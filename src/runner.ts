import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSessionInfo, query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Channels } from './channels.ts';
import { InputQueue } from './input-queue.ts';
import type { Store } from './store.ts';
import { PROGRESS_LINES, errorMessage, isStopStatus, resultOutcome, type ChannelConfig, type FinalStatus, type RunSnapshot, type StopReason } from './types.ts';

export class NotConfiguredError extends Error {
  override name = 'NotConfiguredError';
}

export class BusyError extends Error {
  override name = 'BusyError';
  /** The active run holding the channel or the folder; it may belong to another channel mapped to the same folder. */
  constructor(readonly run: Run) {
    super(`channel ${run.channelId} already has an active run in ${run.cwd}`);
  }
}

export class ShuttingDownError extends Error {
  override name = 'ShuttingDownError';
}

export class CwdMismatchError extends Error {
  override name = 'CwdMismatchError';
  constructor(
    readonly storedCwd: string,
    readonly channelCwd: string,
  ) {
    super(`session cwd ${storedCwd} does not match channel cwd ${channelCwd}`);
  }
}

export class SessionMissingError extends Error {
  override name = 'SessionMissingError';
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} transcript not found`);
  }
}

export interface Run extends RunSnapshot {
  triggerTs: string;
  /** Set by beforeStart so the run record can point at the status message for crash recovery. */
  statusTs?: string;
  queue: InputQueue;
  query?: Query;
  finished: Promise<void>;
  resultCount: number;
  pendingText?: string;
  stopReason?: StopReason;
}

export interface StartOptions {
  channelId: string;
  threadTs: string;
  prompt: string;
  triggerTs: string;
  resume?: { sessionId: string; cwd: string };
  beforeStart?: (run: Run) => Promise<void>;
}

export interface RunnerDeps {
  channels: Pick<Channels, 'get'>;
  store: Pick<Store, 'saveThread' | 'insertRun' | 'finishRun'>;
  pending: { rejectRun(runId: string, reason: string): void };
  canUseTool: (run: Run) => CanUseTool;
  describe: (msg: SDKMessage) => { lines: string[]; text?: string };
  query?: typeof query;
  sessionExists?: (sessionId: string, cwd: string) => Promise<boolean>;
  stopTimeoutMs?: number;
  now?: () => number;
}

export type InjectResult = 'queued' | 'closed' | 'none';

export interface RunnerEvents {
  start: [Run];
  init: [Run];
  progress: [Run];
  prompt: [Run];
  result: [Run, SDKResultMessage];
  error: [Run];
  stopped: [Run];
  end: [Run];
}

interface RunState {
  resolveFinished: () => void;
  folder: string;
  completedTurns: number;
  liveTurns: number;
  lastAssistantId?: string;
  resultError?: string;
  thrownError?: string;
  finalized: boolean;
  stopping?: Promise<void>;
}

const TIMED_OUT = Symbol('timed out');

// Symlinks and trailing slashes must not let two channels mapped to the same folder run in it at once.
function folderKey(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

async function transcriptExists(sessionId: string, cwd: string): Promise<boolean> {
  try {
    return !!(await getSessionInfo(sessionId, { dir: cwd }));
  } catch (err) {
    // A lookup failure must not block a resume the CLI might still manage; the CLI reports the real error.
    console.error(`runner: session lookup for ${sessionId} failed:`, errorMessage(err));
    return true;
  }
}

export class Runner extends EventEmitter<RunnerEvents> {
  readonly #deps: RunnerDeps;
  readonly #query: typeof query;
  readonly #sessionExists: (sessionId: string, cwd: string) => Promise<boolean>;
  readonly #stopTimeoutMs: number;
  readonly #now: () => number;
  readonly #byId = new Map<string, Run>();
  readonly #byChannel = new Map<string, Run>();
  readonly #byThread = new Map<string, Run>();
  readonly #byFolder = new Map<string, Run>();
  readonly #state = new Map<string, RunState>();
  #shuttingDown = false;

  constructor(deps: RunnerDeps) {
    super();
    this.#deps = deps;
    this.#query = deps.query ?? query;
    this.#sessionExists = deps.sessionExists ?? transcriptExists;
    this.#stopTimeoutMs = deps.stopTimeoutMs ?? 10_000;
    this.#now = deps.now ?? Date.now;
  }

  get(runId: string): Run | undefined {
    return this.#byId.get(runId);
  }

  byChannel(channelId: string): Run | undefined {
    return this.#byChannel.get(channelId);
  }

  byThread(channelId: string, threadTs: string): Run | undefined {
    return this.#byThread.get(threadKey(channelId, threadTs));
  }

  active(): Run[] {
    return [...this.#byId.values()];
  }

  async startRun(opts: StartOptions): Promise<Run> {
    let { channel, folder } = this.#guard(opts);
    if (opts.resume) {
      if (!(await this.#sessionExists(opts.resume.sessionId, opts.resume.cwd))) throw new SessionMissingError(opts.resume.sessionId);
      // The lookup yielded, so shutdown, a reload or another run may have changed the channel meanwhile.
      ({ channel, folder } = this.#guard(opts));
    }

    const { promise: finished, resolve: resolveFinished } = Promise.withResolvers<void>();
    const run: Run = {
      id: randomUUID(),
      channelId: opts.channelId,
      threadTs: opts.threadTs,
      triggerTs: opts.triggerTs,
      cwd: channel.cwd,
      prompt: opts.prompt,
      startedAt: this.#now(),
      status: 'running',
      phase: 'running',
      turns: 0,
      progress: [],
      sessionId: opts.resume?.sessionId,
      queue: new InputQueue(),
      finished,
      resultCount: 0,
    };
    const state: RunState = { resolveFinished, folder, completedTurns: 0, liveTurns: 0, finalized: false };
    // Pushed before beforeStart so a reply injected while the status message is being posted lands after the prompt.
    run.queue.push(opts.prompt);
    this.#register(run, state);

    try {
      await opts.beforeStart?.(run);
      this.#deps.store.insertRun({
        id: run.id,
        channelId: run.channelId,
        threadTs: run.threadTs,
        sessionId: opts.resume?.sessionId,
        prompt: run.prompt,
        startedAt: run.startedAt,
        statusTs: run.statusTs,
        triggerTs: run.triggerTs,
      });
    } catch (err) {
      this.#unregister(run);
      state.finalized = true;
      resolveFinished();
      throw err;
    }

    // A Stop during beforeStart already closed the queue; the run then finalizes as stopped without spawning the CLI.
    if (!run.stopReason) {
      try {
        run.query = this.#query({ prompt: run.queue, options: this.#options(channel, run, opts.resume?.sessionId) });
      } catch (err) {
        state.thrownError = errorMessage(err);
      }
    }

    this.#emit('start', run);
    void this.#consume(run, state);
    return run;
  }

  #guard(opts: StartOptions): { channel: ChannelConfig; folder: string } {
    if (this.#shuttingDown) throw new ShuttingDownError('bot is shutting down');
    const channel = this.#deps.channels.get(opts.channelId);
    if (!channel) throw new NotConfiguredError(`channel ${opts.channelId} is not configured`);
    const folder = folderKey(channel.cwd);
    const busy = this.#byChannel.get(opts.channelId) ?? this.#byFolder.get(folder);
    if (busy) throw new BusyError(busy);
    if (opts.resume && opts.resume.cwd !== channel.cwd) throw new CwdMismatchError(opts.resume.cwd, channel.cwd);
    return { channel, folder };
  }

  inject(channelId: string, threadTs: string, text: string): InjectResult {
    const run = this.byThread(channelId, threadTs);
    if (!run) return 'none';
    if (run.queue.closed) return 'closed';
    run.queue.push(text);
    return 'queued';
  }

  setPendingCount(runId: string, count: number): void {
    const run = this.#byId.get(runId);
    if (!run || run.phase === 'stopping') return;
    const phase = count > 0 ? 'waiting' : 'running';
    if (run.phase === phase) return;
    run.phase = phase;
    this.#emit('prompt', run);
  }

  stop(runId: string): Promise<void> {
    const run = this.#byId.get(runId);
    const state = this.#state.get(runId);
    if (!run || !state || state.finalized) return Promise.resolve();
    state.stopping ??= this.#stop(run);
    return state.stopping;
  }

  async stopAll(): Promise<void> {
    this.#shuttingDown = true;
    const runs = this.active();
    for (const run of runs) {
      this.#beginStop(run, 'shutdown');
      this.#safe(() => run.query?.close());
    }
    await Promise.all(
      runs.map(async (run) => {
        if ((await this.#within(run.finished, this.#stopTimeoutMs)) !== TIMED_OUT) return;
        // A CLI that ignores close() must not leave the run unrecorded and its status message stale when the process exits.
        const state = this.#state.get(run.id);
        if (state) this.#finalize(run, state);
      }),
    );
  }

  #beginStop(run: Run, reason: StopReason): void {
    run.stopReason = reason;
    run.phase = 'stopping';
    this.#emit('progress', run);
    run.queue.close();
    this.#safe(() => this.#deps.pending.rejectRun(run.id, reason));
  }

  async #stop(run: Run): Promise<void> {
    this.#beginStop(run, 'stopped');
    // One deadline covers both the interrupt round trip and the wait for the iterator, so a hung CLI cannot stall Stop.
    const deadline = this.#now() + this.#stopTimeoutMs;
    const receipt = await this.#within(run.query?.interrupt().catch(() => undefined), this.#stopTimeoutMs);
    // Messages listed in still_queued would run after the interrupt, so only killing the CLI guarantees the stop.
    if (receipt === TIMED_OUT || receipt?.still_queued?.length) this.#safe(() => run.query?.close());
    else if ((await this.#within(run.finished, deadline - this.#now())) === TIMED_OUT) this.#safe(() => run.query?.close());
    await run.finished;
  }

  #options(channel: ChannelConfig, run: Run, resume: string | undefined): Options {
    const options: Options = {
      cwd: channel.cwd,
      permissionMode: channel.permissionMode,
      disallowedTools: channel.disallowedTools,
      settingSources: ['user', 'project', 'local'],
      canUseTool: this.#deps.canUseTool(run),
    };
    if (channel.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    if (channel.model) options.model = channel.model;
    if (resume) options.resume = resume;
    return options;
  }

  async #consume(run: Run, state: RunState): Promise<void> {
    try {
      if (run.query) {
        for await (const msg of run.query) this.#handle(run, state, msg);
      }
    } catch (err) {
      if (!run.stopReason) state.thrownError = errorMessage(err);
    }
    this.#finalize(run, state);
  }

  #handle(run: Run, state: RunState, msg: SDKMessage): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      run.sessionId = msg.session_id;
      this.#safe(() => this.#deps.store.saveThread({ channelId: run.channelId, threadTs: run.threadTs, sessionId: msg.session_id, cwd: run.cwd }));
      this.#emit('init', run);
    }

    let changed = false;
    const described = this.#safe(() => this.#deps.describe(msg));
    if (described?.lines.length) {
      run.progress = [...run.progress, ...described.lines].slice(-PROGRESS_LINES);
      changed = true;
    }
    if (described?.text) {
      run.lastText = run.pendingText = described.text;
      changed = true;
    }
    if (msg.type === 'assistant' && msg.parent_tool_use_id === null && msg.message.id !== state.lastAssistantId) {
      state.lastAssistantId = msg.message.id;
      state.liveTurns++;
      run.turns = state.completedTurns + state.liveTurns;
      changed = true;
    }
    if (changed) this.#emit('progress', run);

    if (msg.type === 'result') {
      run.queue.close();
      run.resultCount++;
      state.completedTurns += msg.num_turns;
      state.liveTurns = 0;
      run.turns = state.completedTurns;
      run.costUsd = msg.total_cost_usd;
      const { isError, text } = resultOutcome(msg);
      // The error result an interrupt produces must not discard the partial text Stop posts.
      if (!(run.stopReason && isError)) run.pendingText = undefined;
      state.resultError = isError ? text || `result ${msg.subtype}` : undefined;
      run.error = state.resultError;
      this.#emit('result', run, msg);
    }
  }

  #finalize(run: Run, state: RunState): void {
    if (state.finalized) return;
    state.finalized = true;

    let status: FinalStatus;
    if (run.stopReason) {
      status = run.stopReason;
    } else if (state.thrownError || state.resultError) {
      status = 'error';
      run.error = state.thrownError ?? state.resultError;
    } else if (run.resultCount === 0) {
      status = 'error';
      run.error = 'ended without a result';
    } else {
      status = 'done';
    }
    run.status = status;
    run.endedAt = this.#now();
    run.queue.close();
    this.#safe(() => this.#deps.pending.rejectRun(run.id, status));
    try {
      this.#deps.store.finishRun(run.id, { status, sessionId: run.sessionId, turns: run.turns, costUsd: run.costUsd, durationMs: run.endedAt - run.startedAt, endedAt: run.endedAt });
    } catch (err) {
      console.error(`runner: failed to record run ${run.id}:`, err);
    }
    this.#unregister(run);

    if (status === 'error') this.#emit('error', run);
    else if (isStopStatus(status)) this.#emit('stopped', run);
    this.#emit('end', run);
    state.resolveFinished();
  }

  async #within<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #register(run: Run, state: RunState): void {
    this.#byId.set(run.id, run);
    this.#byChannel.set(run.channelId, run);
    this.#byThread.set(threadKey(run.channelId, run.threadTs), run);
    this.#byFolder.set(state.folder, run);
    this.#state.set(run.id, state);
  }

  #unregister(run: Run): void {
    const folder = this.#state.get(run.id)?.folder;
    this.#byId.delete(run.id);
    this.#state.delete(run.id);
    if (folder && this.#byFolder.get(folder) === run) this.#byFolder.delete(folder);
    if (this.#byChannel.get(run.channelId) === run) this.#byChannel.delete(run.channelId);
    const key = threadKey(run.channelId, run.threadTs);
    if (this.#byThread.get(key) === run) this.#byThread.delete(key);
  }

  #emit<K extends keyof RunnerEvents>(event: K, ...args: RunnerEvents[K]): void {
    // EventEmitter throws on an unhandled 'error' event, which would abort finalization.
    if (event === 'error' && this.listenerCount('error') === 0) return;
    try {
      (this.emit as (event: K, ...args: RunnerEvents[K]) => boolean)(event, ...args);
    } catch (err) {
      console.error(`runner: '${event}' listener failed:`, err);
    }
  }

  #safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      console.error('runner:', err);
      return undefined;
    }
  }
}

const threadKey = (channelId: string, threadTs: string) => `${channelId}:${threadTs}`;
