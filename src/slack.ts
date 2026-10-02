import { App, LogLevel, type BlockAction, type ButtonAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { KnownBlock, View } from '@slack/types';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { DIRECT_KEY, checkMembership, describeDiff, isDirectChannel, type ChannelDiff, type Channels, type Membership } from './channels.ts';
import { withAttachments, type SaveFiles, type SlackFile } from './files.ts';
import { alwaysAllow, approve, createCanUseTool, deny, pendingOf, setOtherAnswer, submitAnswers, type PendingRegistry } from './permissions.ts';
import { MARKDOWN_LIMIT, channelLabel, elapsedOf, formatDuration, homeView, interruptedBlocks, promptBlocks, resultFromMessage, resultPayload, statusBlocks, threadLinkMrkdwn, truncate, type ResultPayload } from './render.ts';
import { BusyError, CwdMismatchError, NotConfiguredError, SessionMissingError, ShuttingDownError, type Run, type Runner, type StartOptions } from './runner.ts';
import type { Store } from './store.ts';
import { ACTION, RECENT_RUNS, VIEW, errorMessage, isStopStatus, parseOtherActionValue, questionBlockId, type ChannelConfig, type Config, type FinalStatus, type Prompt, type RunRecord } from './types.ts';

export type SlackClient = Pick<WebClient, 'chat' | 'reactions' | 'views' | 'files' | 'conversations'>;

export type ReloadOutcome = { ok: true; diff: ChannelDiff; warnings: string[] } | { ok: false; error: string };

export interface ControllerDeps {
  client: SlackClient;
  runner: Runner;
  store: Pick<Store, 'getThread' | 'hasRun' | 'recentRuns'>;
  registry: PendingRegistry;
  config: Pick<Config, 'allowedUserId'>;
  channels: Channels;
  /** Reads and validates the channels file; throws on an invalid file. */
  loadChannels: () => Record<string, ChannelConfig>;
  botUserId: string;
  saveFiles: SaveFiles;
  teamUrl?: string;
  now?: () => number;
  statusIntervalMs?: number;
  homeDebounceMs?: number;
  budget?: RateBudget;
}

export interface MentionEvent {
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  files?: SlackFile[];
}

export interface MessageEvent extends MentionEvent {
  subtype?: string;
}

/** Where a button or modal interaction came from, so a stale one can be answered in place. */
export interface ActionSource {
  userId: string;
  channelId?: string;
  threadTs?: string;
}

export interface CommandInput {
  user_id: string;
  channel_id: string;
  text: string;
}

const REACTION = {
  seen: 'eyes',
  running: 'hourglass_flowing_sand',
  waiting: 'raised_hand',
  queued: 'incoming_envelope',
  done: 'white_check_mark',
  error: 'x',
  stopped: 'black_square_for_stop',
} as const;

const FINAL_REACTION: Record<FinalStatus, string> = {
  done: REACTION.done,
  error: REACTION.error,
  stopped: REACTION.stopped,
  shutdown: REACTION.stopped,
};

// Replies with attachments and replies also sent to the channel carry these subtypes but are still the user's own thread replies.
const REPLY_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

const log = (label: string, err: unknown) => console.error(`slack: ${label}:`, errorMessage(err));

/** Token bucket shared by chat.update and views.publish so the bot stays under the ~50/min Tier 3 limit across all runs. */
export class RateBudget {
  #tokens: number;
  #last: number;

  readonly perMinute: number;
  readonly burst: number;
  readonly now: () => number;

  constructor(perMinute = 45, burst = 10, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.burst = burst;
    this.now = now;
    this.#tokens = burst;
    this.#last = now();
  }

  #refill(): void {
    const t = this.now();
    this.#tokens = Math.min(this.burst, this.#tokens + ((t - this.#last) * this.perMinute) / 60_000);
    this.#last = t;
  }

  /** Consumes a token and returns 0, or returns the ms to wait before one is available. */
  tryTake(): number {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.#tokens) * 60_000) / this.perMinute);
  }

  /** Forced updates never wait; the overdraw floor bounds how long they can delay throttled ones. */
  take(): void {
    this.#refill();
    this.#tokens = Math.max(this.#tokens - 1, -this.burst);
  }
}

/** should_escape delivers channels as `<#C123|name>`; a bare ID is accepted too. */
export function parseChannelArg(arg: string): string | undefined {
  const escaped = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(arg);
  if (escaped) return escaped[1];
  return /^[CG][A-Z0-9]+$/.test(arg) ? arg : undefined;
}

interface RunView {
  timer?: ReturnType<typeof setTimeout>;
  lastStatusAt: number;
  inflight?: Promise<void>;
  reaction?: string;
  // Reaction swaps are serialized so a remove never overtakes the add it should undo.
  reactions: Promise<void>;
  // Results, the stop text and finalization are posted strictly in order, so ✅ never precedes a result.
  posts: Promise<void>;
}

type StartRequest = Omit<StartOptions, 'beforeStart'> & { userId: string };

export class Controller {
  readonly #d: ControllerDeps;
  readonly #now: () => number;
  readonly #budget: RateBudget;
  readonly #statusInterval: number;
  readonly #homeDebounce: number;
  readonly #mention: RegExp;
  readonly #views = new Map<string, RunView>();
  readonly #settles = new Set<Promise<void>>();
  #homeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: ControllerDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#budget = deps.budget ?? new RateBudget();
    this.#statusInterval = deps.statusIntervalMs ?? 1500;
    this.#homeDebounce = deps.homeDebounceMs ?? 2000;
    this.#mention = new RegExp(`<@${deps.botUserId}(?:\\|[^>]*)?>`, 'g');

    const { runner } = deps;
    runner.on('start', () => this.scheduleHome());
    runner.on('progress', (run) => {
      this.#scheduleStatus(run);
      if (run.phase === 'stopping') this.scheduleHome();
    });
    runner.on('prompt', (run) => {
      this.#scheduleStatus(run);
      this.scheduleHome();
      if (run.phase === 'waiting') void this.#setRunReaction(run, REACTION.waiting);
      else if (run.phase === 'running') void this.#setRunReaction(run, REACTION.running);
    });
    runner.on('result', (run, msg) => void this.#enqueue(run, () => this.#postResult(run, msg)));
    runner.on('end', (run) => void this.#enqueue(run, () => this.#finish(run)));
  }

  canUseToolFor(run: Run) {
    const { client, registry, runner } = this.#d;
    return createCanUseTool({
      runId: run.id,
      registry,
      post: async (prompt) => {
        const res = await client.chat.postMessage({ channel: run.channelId, thread_ts: run.threadTs, ...promptBlocks(prompt) });
        return res.channel && res.ts ? { channel: res.channel, ts: res.ts } : undefined;
      },
      settle: async (prompt, outcome, message) => {
        if (!message) return;
        this.#budget.take();
        const update = client.chat.update({ channel: message.channel, ts: message.ts, ...promptBlocks(prompt, outcome) }).then(() => undefined);
        this.#settles.add(update);
        try {
          await update;
        } finally {
          this.#settles.delete(update);
        }
      },
      onWaitingChange: (count) => runner.setPendingCount(run.id, count),
    });
  }

  isAllowed(userId: string | undefined): boolean {
    return userId === this.#d.config.allowedUserId;
  }

  #isKnownThread(channelId: string, threadTs: string): boolean {
    // A run that failed before init has no session row, but its thread must still accept replies.
    const { runner, store } = this.#d;
    return !!runner.byThread(channelId, threadTs) || !!store.getThread(channelId, threadTs) || store.hasRun(channelId, threadTs);
  }

  async onAppMention(event: MentionEvent): Promise<void> {
    // Direct messages arrive as message events, where every message is addressed to the bot.
    if (isDirectChannel(event.channel)) return;
    if (event.bot_id || !event.user || !this.isAllowed(event.user)) return;
    await this.#addressed(event, event.user);
  }

  async #addressed(event: MentionEvent, userId: string): Promise<void> {
    const direct = isDirectChannel(event.channel);
    const text = (event.text ?? '').replace(this.#mention, '').trim();
    const threadTs = event.thread_ts ?? event.ts;
    if (event.thread_ts && this.#isKnownThread(event.channel, event.thread_ts)) {
      await this.#threadReply(event.channel, threadTs, await this.#prompt(text, event, threadTs), event.ts, userId);
      return;
    }
    if (!this.#d.channels.get(event.channel)) {
      const reply = direct ? `Direct messages are not configured for Claude: add a "${DIRECT_KEY}" entry to the channels file.` : 'This channel is not configured for Claude.';
      await this.#ephemeral(event.channel, userId, reply, event.thread_ts);
      return;
    }
    if (!text && !event.files?.length) {
      if (!direct) await this.#ephemeral(event.channel, userId, 'Mention me followed by a prompt.', event.thread_ts);
      return;
    }
    const prompt = await this.#prompt(text, event, threadTs);
    await this.#start({ channelId: event.channel, threadTs, prompt, triggerTs: event.ts, userId });
  }

  async onMessage(event: MessageEvent): Promise<void> {
    if ((event.subtype && !REPLY_SUBTYPES.has(event.subtype)) || event.bot_id) return;
    if (!event.user || !this.isAllowed(event.user)) return;
    if (isDirectChannel(event.channel)) {
      await this.#addressed(event, event.user);
      return;
    }
    if (!event.thread_ts || event.thread_ts === event.ts) return;
    const text = (event.text ?? '').trim();
    // Replies that mention the bot also arrive as app_mention and are handled there.
    if (text.replace(this.#mention, '') !== text) return;
    if ((!text && !event.files?.length) || !this.#isKnownThread(event.channel, event.thread_ts)) return;
    await this.#threadReply(event.channel, event.thread_ts, await this.#prompt(text, event, event.thread_ts), event.ts, event.user);
  }

  async #prompt(text: string, event: MentionEvent, threadTs: string): Promise<string> {
    if (!event.files?.length) return text;
    return withAttachments(text, await this.#d.saveFiles(event.files, event.channel, threadTs));
  }

  async #threadReply(channelId: string, threadTs: string, text: string, messageTs: string, userId: string): Promise<void> {
    if (!text) return;
    const { runner, store } = this.#d;
    const injected = runner.inject(channelId, threadTs, text);
    if (injected === 'queued') {
      await this.#react(channelId, messageTs, REACTION.queued);
      return;
    }
    if (injected === 'closed') {
      const run = runner.byThread(channelId, threadTs)!;
      await run.finished;
      await this.#views.get(run.id)?.posts;
      await this.#threadReply(channelId, threadTs, text, messageTs, userId);
      return;
    }
    const thread = store.getThread(channelId, threadTs);
    await this.#start({
      channelId,
      threadTs,
      prompt: text,
      triggerTs: messageTs,
      userId,
      ...(thread ? { resume: { sessionId: thread.sessionId, cwd: thread.cwd } } : {}),
    });
  }

  async #start({ userId, ...opts }: StartRequest): Promise<void> {
    const { client, runner } = this.#d;
    let pending: Run | undefined;
    try {
      await runner.startRun({
        ...opts,
        beforeStart: async (run) => {
          pending = run;
          await this.#setRunReaction(run, REACTION.seen);
          const res = await client.chat.postMessage({ channel: run.channelId, thread_ts: run.threadTs, ...statusBlocks(run, { now: this.#now() }) });
          const view = this.#view(run.id);
          run.statusTs = res.ts;
          view.lastStatusAt = this.#now();
          await this.#setRunReaction(run, REACTION.running);
        },
      });
    } catch (err) {
      if (pending && !runner.get(pending.id)) {
        await this.#setRunReaction(pending, undefined);
        this.#views.delete(pending.id);
      }
      if (err instanceof BusyError) {
        const link = threadLinkMrkdwn(this.#d.teamUrl, err.run.channelId, err.run.threadTs, 'View the active run.');
        const reason = err.run.channelId === opts.channelId ? 'this channel already has an active run' : `\`${err.run.cwd}\` is in use by a run in ${channelLabel(err.run.channelId)}`;
        await this.#ephemeral(opts.channelId, userId, `Busy: ${reason}.${link}`, opts.threadTs);
      } else if (err instanceof NotConfiguredError) {
        await this.#ephemeral(opts.channelId, userId, 'This channel is not configured for Claude.', opts.threadTs);
      } else if (err instanceof ShuttingDownError) {
        await this.#ephemeral(opts.channelId, userId, 'The bot is shutting down; try again once it is back.', opts.threadTs);
      } else if (err instanceof SessionMissingError) {
        await this.#post(opts.channelId, opts.threadTs, {
          text: '❌ Cannot resume: the session transcript is gone (Claude deletes transcripts after `cleanupPeriodDays`, default 30). Mention me in the channel to start a new run.',
        });
      } else if (err instanceof CwdMismatchError) {
        await this.#post(opts.channelId, opts.threadTs, {
          text: `❌ Cannot resume: this session ran in \`${err.storedCwd}\` but the channel now maps to \`${err.channelCwd}\`.`,
        });
      } else {
        log('start run', err);
        await this.#post(opts.channelId, opts.threadTs, { text: `❌ Failed to start: ${errorMessage(err)}` });
      }
    }
  }

  async onCommand(cmd: CommandInput): Promise<string | undefined> {
    if (!this.isAllowed(cmd.user_id)) return undefined;
    const [sub = 'status', arg] = cmd.text.trim().split(/\s+/).filter(Boolean);
    if (sub === 'status') return this.#statusText();
    if (sub === 'channels') return this.#channelsText();
    if (sub === 'reload') return reloadText(await this.reloadChannels());
    if (sub === 'stop') {
      if (arg && arg !== DIRECT_KEY && !parseChannelArg(arg)) return `Unknown channel ${arg}. Usage: \`/claude stop [#channel|direct]\``;
      const channelId = arg === DIRECT_KEY ? this.#directRun()?.channelId : arg ? parseChannelArg(arg) : cmd.channel_id;
      const target = arg === DIRECT_KEY ? 'Direct' : channelLabel(channelId!);
      const run = channelId ? this.#d.runner.byChannel(channelId) : undefined;
      if (!run) return `No active run in ${target}.`;
      this.stop(run.id);
      return `Stopping the run in ${target}…`;
    }
    return 'Usage: `/claude status` | `/claude channels` | `/claude reload` | `/claude stop [#channel|direct]`';
  }

  /** Keeps the current mapping when the file is invalid, so a bad edit never unmaps every channel. */
  async reloadChannels(): Promise<ReloadOutcome> {
    let next: Record<string, ChannelConfig>;
    try {
      next = this.#d.loadChannels();
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    const diff = this.#d.channels.replace(next);
    const warnings = await this.membershipWarnings(diff.added.filter((id) => id !== DIRECT_KEY));
    return { ok: true, diff, warnings };
  }

  /** Mapped channels the bot cannot hear, since mentions there never reach it. */
  async membershipWarnings(ids = this.#d.channels.channelIds()): Promise<string[]> {
    const membership = await checkMembership(this.#d.client, ids);
    return [...membership].flatMap(([id, m]) => (m.kind === 'member' ? [] : [`<#${id}>: ${membershipProblem(m)}`]));
  }

  // Only the allowed user's direct message with the bot reaches it, so at most one direct message run exists.
  #directRun(): Run | undefined {
    return this.#d.runner.active().find((r) => isDirectChannel(r.channelId));
  }

  async #channelsText(): Promise<string> {
    const entries = this.#d.channels.entries();
    if (entries.length === 0) return 'No channels configured.';
    const membership = await checkMembership(this.#d.client, this.#d.channels.channelIds());
    return entries
      .map(([key, c]) => {
        const parts = [key === DIRECT_KEY ? 'Direct' : `<#${key}>`, `\`${c.cwd}\``, c.permissionMode];
        if (c.model) parts.push(c.model);
        const m = membership.get(key);
        if (m && m.kind !== 'member') parts.push(`⚠️ ${membershipProblem(m)}`);
        const run = key === DIRECT_KEY ? this.#directRun() : this.#d.runner.byChannel(key);
        if (run) parts.push(`⏳ active run${threadLinkMrkdwn(this.#d.teamUrl, run.channelId, run.threadTs, 'thread')}`);
        return `• ${parts.join(' · ')}`;
      })
      .join('\n');
  }

  #statusText(): string {
    const runs = this.#d.runner.active();
    if (runs.length === 0) return 'No active runs.';
    return runs
      .map((run) => {
        const state = run.phase === 'waiting' ? 'waiting for approval' : run.phase;
        const link = this.#d.teamUrl ? ` ·${threadLinkMrkdwn(this.#d.teamUrl, run.channelId, run.threadTs, 'thread')}` : '';
        return `• ${channelLabel(run.channelId)} · ${formatDuration(elapsedOf(run, this.#now()))} · ${state}${link}`;
      })
      .join('\n');
  }

  // Stale ids are expected after a restart or a second click, so callers answer false with notifyStale.
  stop(runId: string): boolean {
    if (!this.#d.runner.get(runId)) return false;
    void this.#d.runner.stop(runId);
    return true;
  }

  approve(promptId: string): boolean {
    return approve(this.#d.registry, promptId);
  }

  alwaysAllow(promptId: string): boolean {
    return alwaysAllow(this.#d.registry, promptId);
  }

  deny(promptId: string, note?: string): boolean {
    return deny(this.#d.registry, promptId, note);
  }

  isPending(promptId: string, kind: Prompt['kind']): boolean {
    return !!pendingOf(this.#d.registry, promptId, kind);
  }

  async notifyStale(src: ActionSource): Promise<void> {
    // Home tab actions carry no channel; republishing replaces the stale buttons there.
    if (!src.channelId) {
      this.scheduleHome();
      return;
    }
    await this.#ephemeral(src.channelId, src.userId, 'This run or prompt is no longer active.', src.threadTs);
  }

  /** Fixes the Slack messages of runs a crash left `running`, since no process is left to finalize them. */
  async cleanupInterrupted(runs: RunRecord[]): Promise<void> {
    for (const run of runs) {
      if (run.statusTs) {
        this.#budget.take();
        await this.#d.client.chat.update({ channel: run.channelId, ts: run.statusTs, ...interruptedBlocks() }).catch((err) => log('interrupted status', err));
      }
      if (run.triggerTs) {
        // Which live reaction was set at the crash is unknown, so every one is removed and misses are expected.
        for (const name of [REACTION.seen, REACTION.running, REACTION.waiting]) await this.#unreact(run.channelId, run.triggerTs, name, { quiet: true });
        await this.#react(run.channelId, run.triggerTs, FINAL_REACTION.shutdown);
      }
    }
  }

  async publishHome(userId: string): Promise<void> {
    if (!this.isAllowed(userId)) return;
    this.#budget.take();
    await this.#publishHomeNow();
  }

  scheduleHome(): void {
    if (this.#homeTimer) return;
    const flush = () => {
      const wait = this.#budget.tryTake();
      if (wait > 0) {
        this.#homeTimer = setTimeout(flush, wait);
        return;
      }
      this.#homeTimer = undefined;
      void this.#publishHomeNow();
    };
    this.#homeTimer = setTimeout(flush, this.#homeDebounce);
  }

  async #publishHomeNow(): Promise<void> {
    const view: View = homeView(this.#d.runner.active(), this.#d.store.recentRuns(RECENT_RUNS), { now: this.#now(), teamUrl: this.#d.teamUrl });
    await this.#d.client.views.publish({ user_id: this.#d.config.allowedUserId, view }).catch((err) => log('views.publish', err));
  }

  async submitQuestion(promptId: string, state: Record<string, Record<string, unknown>> | undefined, src: ActionSource): Promise<void> {
    const { userId } = src;
    const entry = this.#d.registry.get(promptId);
    if (entry?.prompt.kind !== 'question') {
      await this.notifyStale(src);
      return;
    }
    const { questions } = entry.prompt;
    const selections: Record<number, string[]> = {};
    questions.forEach((q, i) => {
      const value = state?.[questionBlockId(i)]?.[ACTION.questionSelect] as
        | { selected_option?: { value: string } | null; selected_options?: { value: string }[] }
        | undefined;
      const picked = value?.selected_options ?? (value?.selected_option ? [value.selected_option] : []);
      selections[i] = picked.map((o) => q.options[Number(o.value)]?.label).filter((l): l is string => !!l);
    });
    const result = submitAnswers(this.#d.registry, promptId, selections);
    const run = this.#d.runner.get(entry.runId);
    if (!result.ok && result.missing.length > 0 && run) {
      await this.#ephemeral(run.channelId, userId, `Please answer: ${result.missing.join('; ')}`, run.threadTs);
    }
  }

  async setOther(value: string, text: string, userId: string): Promise<void> {
    const { promptId, questionIndex } = parseOtherActionValue(value);
    const entry = this.#d.registry.get(promptId);
    if (entry?.prompt.kind !== 'question' || !setOtherAnswer(this.#d.registry, promptId, questionIndex, text)) return;
    const run = this.#d.runner.get(entry.runId);
    const question = entry.prompt.questions[questionIndex]?.question ?? '';
    // Confirmed ephemerally instead of re-rendering the prompt, because chat.update would reset the other questions' selections.
    if (run) {
      const reply = text.trim() ? `Recorded "Other" answer for: ${question}. Press Submit when done.` : `Cleared "Other" answer for: ${question}.`;
      await this.#ephemeral(run.channelId, userId, reply, run.threadTs);
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...[...this.#views.values()].map((v) => v.posts), ...[...this.#settles].map((p) => p.catch(() => undefined))]);
    clearTimeout(this.#homeTimer);
    this.#homeTimer = undefined;
  }

  #view(runId: string): RunView {
    let view = this.#views.get(runId);
    if (!view) {
      view = { lastStatusAt: 0, reactions: Promise.resolve(), posts: Promise.resolve() };
      this.#views.set(runId, view);
    }
    return view;
  }

  #enqueue(run: Run, task: () => Promise<void>): Promise<void> {
    const view = this.#view(run.id);
    view.posts = view.posts.then(task).catch((err) => log('post', err));
    return view.posts;
  }

  #scheduleStatus(run: Run): void {
    const view = this.#views.get(run.id);
    if (!view || !run.statusTs || view.timer || !this.#d.runner.get(run.id)) return;
    const flush = () => {
      view.timer = undefined;
      if (!this.#d.runner.get(run.id)) return;
      if (view.inflight) {
        void view.inflight.then(() => this.#scheduleStatus(run));
        return;
      }
      const wait = this.#budget.tryTake();
      if (wait > 0) {
        view.timer = setTimeout(flush, wait);
        return;
      }
      view.lastStatusAt = this.#now();
      view.inflight = this.#updateStatus(run).finally(() => {
        view.inflight = undefined;
      });
    };
    view.timer = setTimeout(flush, Math.max(0, view.lastStatusAt + this.#statusInterval - this.#now()));
  }

  async #updateStatus(run: Run): Promise<void> {
    const { statusTs } = run;
    if (!statusTs) return;
    await this.#d.client.chat
      .update({ channel: run.channelId, ts: statusTs, ...statusBlocks(run, { now: this.#now() }) })
      .catch((err) => log('status update', err));
  }

  async #postResult(run: Run, msg: SDKResultMessage): Promise<void> {
    const { text, meta } = resultFromMessage(msg);
    // An interrupt makes the CLI emit an error result; Stop reports the partial text instead.
    if (run.stopReason && meta.isError) return;
    await this.#postPayload(run, resultPayload(text, meta));
  }

  async #postPayload(run: Run, payload: ResultPayload): Promise<void> {
    if (payload.kind === 'blocks') {
      await this.#post(run.channelId, run.threadTs, { text: payload.text, blocks: payload.blocks });
      return;
    }
    try {
      await this.#d.client.files.uploadV2({
        channel_id: run.channelId,
        thread_ts: run.threadTs,
        filename: payload.filename,
        title: payload.filename,
        content: payload.content,
        blocks: payload.blocks,
      });
    } catch (err) {
      log('files.uploadV2', err);
      for (let i = 0; i < payload.content.length; i += MARKDOWN_LIMIT) {
        const chunk = payload.content.slice(i, i + MARKDOWN_LIMIT);
        await this.#post(run.channelId, run.threadTs, { text: truncate(chunk, 300), blocks: [{ type: 'markdown', text: chunk }] });
      }
    }
  }

  async #finish(run: Run): Promise<void> {
    const view = this.#view(run.id);
    clearTimeout(view.timer);
    view.timer = undefined;
    if (isStopStatus(run.status) && run.pendingText) {
      await this.#postPayload(run, resultPayload(run.pendingText, { turns: run.turns, durationMs: elapsedOf(run, this.#now()), costUsd: run.costUsd }));
    }
    await view.inflight;
    this.#budget.take();
    await this.#updateStatus(run);
    if (run.status !== 'running') await this.#setRunReaction(run, FINAL_REACTION[run.status]);
    this.#views.delete(run.id);
    this.scheduleHome();
  }

  #setRunReaction(run: Run, name: string | undefined): Promise<void> {
    const view = this.#view(run.id);
    view.reactions = view.reactions.then(async () => {
      const previous = view.reaction;
      if (previous === name) return;
      view.reaction = name;
      if (previous) await this.#unreact(run.channelId, run.triggerTs, previous);
      if (name) await this.#react(run.channelId, run.triggerTs, name);
    });
    return view.reactions;
  }

  async #react(channel: string, timestamp: string, name: string): Promise<void> {
    await this.#d.client.reactions.add({ channel, timestamp, name }).catch((err) => log(`reactions.add ${name}`, err));
  }

  async #unreact(channel: string, timestamp: string, name: string, opts: { quiet?: boolean } = {}): Promise<void> {
    await this.#d.client.reactions.remove({ channel, timestamp, name }).catch((err) => {
      if (opts.quiet && (err as { data?: { error?: string } }).data?.error === 'no_reaction') return;
      log(`reactions.remove ${name}`, err);
    });
  }

  async #post(channel: string, threadTs: string, msg: { text: string; blocks?: KnownBlock[] }): Promise<void> {
    await this.#d.client.chat.postMessage({ channel, thread_ts: threadTs, ...msg }).catch((err) => log('chat.postMessage', err));
  }

  async #ephemeral(channel: string, user: string, text: string, threadTs?: string): Promise<void> {
    await this.#d.client.chat
      .postEphemeral({ channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) })
      .catch((err) => log('chat.postEphemeral', err));
  }
}

function membershipProblem(m: Exclude<Membership, { kind: 'member' }>): string {
  if (m.kind === 'not_member') return 'bot is not in this channel; run `/invite @bot` there';
  if (m.error === 'missing_scope') return 'cannot check membership: add the `channels:read` and `groups:read` scopes and reinstall the app';
  return `cannot check membership: ${m.error}`;
}

export function reloadText(outcome: ReloadOutcome): string {
  if (!outcome.ok) return `❌ Reload failed, keeping the previous mapping: ${outcome.error}`;
  return [`✅ Reloaded channels: ${describeDiff(outcome.diff)}.`, ...outcome.warnings.map((w) => `⚠️ ${w}`)].join('\n');
}

const MODAL_INPUT = 'text';

const textInputModal = (callbackId: string, metadata: string, title: string, label: string): View => ({
  type: 'modal',
  callback_id: callbackId,
  private_metadata: metadata,
  title: { type: 'plain_text', text: title },
  submit: { type: 'plain_text', text: 'Submit' },
  close: { type: 'plain_text', text: 'Cancel' },
  blocks: [
    {
      type: 'input',
      block_id: MODAL_INPUT,
      label: { type: 'plain_text', text: label },
      element: { type: 'plain_text_input', action_id: MODAL_INPUT, multiline: true },
    },
  ],
});

export function createSlackApp(config: Pick<Config, 'slackBotToken' | 'slackAppToken'>): App {
  return new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true, logLevel: LogLevel.INFO });
}

export function registerHandlers(app: App, controller: Controller): void {
  const guarded = (label: string, fn: () => unknown) =>
    Promise.resolve()
      .then(fn)
      .catch((err) => log(label, err));

  app.event('app_mention', async ({ event }) => {
    await guarded('app_mention', () => controller.onAppMention(event as MentionEvent));
  });

  app.event('message', async ({ event }) => {
    await guarded('message', () => controller.onMessage(event as MessageEvent));
  });

  app.event('app_home_opened', async ({ event }) => {
    if (event.tab === 'home') await guarded('app_home_opened', () => controller.publishHome(event.user));
  });

  // Acked first because channels and reload call the Slack API and could miss the 3 s ack deadline.
  app.command('/claude', async ({ command, ack, respond }) => {
    await ack();
    let text: string | undefined;
    try {
      text = await controller.onCommand(command);
    } catch (err) {
      log('/claude', err);
      text = `❌ ${errorMessage(err)}`;
    }
    if (text) await guarded('/claude respond', () => respond({ response_type: 'ephemeral', text }));
  });

  const source = (body: BlockAction): ActionSource => ({
    userId: body.user.id,
    channelId: body.channel?.id,
    threadTs: (body.message?.thread_ts as string | undefined) ?? body.message?.ts,
  });

  const buttons: [string, (value: string) => boolean][] = [
    [ACTION.stop, (v) => controller.stop(v)],
    [ACTION.approve, (v) => controller.approve(v)],
    [ACTION.always, (v) => controller.alwaysAllow(v)],
    [ACTION.deny, (v) => controller.deny(v)],
  ];
  for (const [actionId, handle] of buttons) {
    app.action<BlockAction<ButtonAction>>(actionId, async ({ ack, body, action }) => {
      await ack();
      if (!controller.isAllowed(body.user.id)) return;
      await guarded(actionId, async () => {
        if (!handle(action.value ?? '')) await controller.notifyStale(source(body));
      });
    });
  }

  const otherPromptId = (value: string) => parseOtherActionValue(value).promptId;
  const modals: { action: string; view: string; title: string; label: string; kind: Prompt['kind']; promptIdOf: (value: string) => string }[] = [
    { action: ACTION.questionOther, view: VIEW.other, title: 'Other answer', label: 'Your answer', kind: 'question', promptIdOf: otherPromptId },
    { action: ACTION.denyNote, view: VIEW.denyNote, title: 'Deny with note', label: 'Note for Claude', kind: 'approval', promptIdOf: (v) => v },
  ];
  for (const m of modals) {
    app.action<BlockAction<ButtonAction>>(m.action, async ({ ack, body, action, client }) => {
      await ack();
      if (!controller.isAllowed(body.user.id)) return;
      const value = action.value ?? '';
      // The modal would collect text for a prompt that can no longer accept it.
      if (!controller.isPending(m.promptIdOf(value), m.kind)) {
        await guarded('stale modal', () => controller.notifyStale(source(body)));
        return;
      }
      await guarded('views.open', () => client.views.open({ trigger_id: body.trigger_id, view: textInputModal(m.view, value, m.title, m.label) }));
    });
  }

  app.action(ACTION.questionSelect, async ({ ack }) => {
    await ack();
  });

  app.action<BlockAction<ButtonAction>>(ACTION.questionSubmit, async ({ ack, body, action }) => {
    await ack();
    if (!controller.isAllowed(body.user.id)) return;
    const state = body.state?.values as Record<string, Record<string, unknown>> | undefined;
    await guarded('question submit', () => controller.submitQuestion(action.value ?? '', state, source(body)));
  });

  const submittedText = (view: { state: { values: Record<string, Record<string, { value?: string | null }>> } }) =>
    view.state.values[MODAL_INPUT]?.[MODAL_INPUT]?.value ?? '';

  // A prompt can close while its modal is open; the error keeps the modal up instead of dropping the text silently.
  const staleModal = { response_action: 'errors', errors: { [MODAL_INPUT]: 'This prompt is no longer active.' } } as const;

  app.view(VIEW.other, async ({ ack, body, view }) => {
    if (!controller.isPending(otherPromptId(view.private_metadata), 'question')) return ack(staleModal);
    await ack();
    if (controller.isAllowed(body.user.id)) await guarded('other answer', () => controller.setOther(view.private_metadata, submittedText(view), body.user.id));
  });

  app.view(VIEW.denyNote, async ({ ack, body, view }) => {
    if (!controller.isAllowed(body.user.id)) return ack();
    if (!controller.deny(view.private_metadata, submittedText(view))) return ack(staleModal);
    await ack();
  });
}
