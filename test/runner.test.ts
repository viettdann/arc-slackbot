import { describe, expect, test, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool, Options, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Channels } from '../src/channels.ts';
import { BusyError, CwdMismatchError, NotConfiguredError, Runner, SessionMissingError, ShuttingDownError, type Run, type RunnerDeps } from '../src/runner.ts';
import type { FinishedRun, NewRun } from '../src/store.ts';
import type { ChannelConfig, ThreadRecord } from '../src/types.ts';

class Channel<T> {
  #items: T[] = [];
  #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #done = false;
  #error: unknown;

  push(item: T): void {
    const w = this.#waiters.shift();
    if (w) w({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  fail(err: unknown): void {
    this.#error = err;
    this.end();
  }

  async next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.#error) throw this.#error;
    if (this.#done) return { value: undefined, done: true };
    const r = await new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
    if (r.done && this.#error) throw this.#error;
    return r;
  }
}

interface FakeQuery {
  options: Options;
  prompts: SDKUserMessage[];
  promptEnded: boolean;
  out: Channel<SDKMessage>;
  interrupt: Mock<() => Promise<{ still_queued: string[] } | undefined>>;
  close: Mock<() => void>;
}

function fakeQueryFactory() {
  const instances: FakeQuery[] = [];
  const fn = vi.fn(({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const out = new Channel<SDKMessage>();
    const fq: FakeQuery = {
      options: options ?? {},
      prompts: [],
      promptEnded: false,
      out,
      interrupt: vi.fn(async () => ({ still_queued: [] as string[] })),
      close: vi.fn(() => out.end()),
    };
    instances.push(fq);
    void (async () => {
      if (typeof prompt === 'string') return;
      for await (const m of prompt) fq.prompts.push(m);
      fq.promptEnded = true;
    })();
    const gen = {
      next: () => out.next(),
      return: async () => ({ value: undefined, done: true as const }),
      throw: async (e: unknown) => {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return gen;
      },
      interrupt: () => fq.interrupt(),
      close: () => fq.close(),
    };
    return gen as never;
  });
  return { fn, instances };
}

const init = (sessionId = 'sess-1') => ({ type: 'system', subtype: 'init', session_id: sessionId }) as unknown as SDKMessage;
const assistant = (id: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content: [] } }) as unknown as SDKMessage;
const result = (numTurns: number, cost: number, extra: Partial<Record<string, unknown>> = {}) =>
  ({ type: 'result', subtype: 'success', is_error: false, num_turns: numTurns, total_cost_usd: cost, result: 'ok', ...extra }) as unknown as SDKResultMessage;

const tick = () => new Promise((r) => setTimeout(r, 0));

const CHANNELS: Record<string, ChannelConfig> = {
  C1: { cwd: '/proj/a', permissionMode: 'bypassPermissions', disallowedTools: ['AskUserQuestion'], model: 'claude-opus-5-5' },
  C2: { cwd: '/proj/b', permissionMode: 'default', disallowedTools: [] },
  C3: { cwd: '/proj/a/', permissionMode: 'default', disallowedTools: [] },
};

function setup(over: Partial<RunnerDeps> = {}) {
  const q = fakeQueryFactory();
  const store = { saveThread: vi.fn((_t: Omit<ThreadRecord, 'updatedAt'>) => {}), insertRun: vi.fn((_r: NewRun) => {}), finishRun: vi.fn((_id: string, _f: FinishedRun) => {}) };
  const pending = { rejectRun: vi.fn((_id: string, _reason: string) => {}) };
  const canUse: CanUseTool = async () => ({ behavior: 'deny', message: 'x' });
  const deps: RunnerDeps = {
    channels: new Channels(CHANNELS),
    store,
    pending,
    canUseTool: () => canUse,
    describe: (msg) => (msg.type === 'assistant' ? { lines: [{ head: `line ${msg.message.id}`, args: [], count: 1 }], text: `text ${msg.message.id}` } : { lines: [] }),
    query: q.fn as never,
    sessionExists: async () => true,
    stopTimeoutMs: 30,
    ...over,
  };
  const runner = new Runner(deps);
  const events: string[] = [];
  for (const e of ['start', 'init', 'progress', 'prompt', 'result', 'error', 'stopped', 'end'] as const) runner.on(e, () => events.push(e));
  return { runner, q, store, pending, events, canUse };
}

const start = (runner: Runner, over: Partial<Parameters<Runner['startRun']>[0]> = {}) =>
  runner.startRun({ channelId: 'C1', threadTs: '100.1', prompt: 'hello', triggerTs: '100.1', ...over });

describe('Runner options', () => {
  test('bypass channel passes dangerous flag, disallowedTools, model, settingSources, canUseTool', async () => {
    const { runner, q, canUse } = setup();
    await start(runner);
    const o = q.instances[0]!.options;
    expect(o.cwd).toBe('/proj/a');
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.disallowedTools).toEqual(['AskUserQuestion']);
    expect(o.model).toBe('claude-opus-5-5');
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.canUseTool).toBe(canUse);
    expect(o.resume).toBeUndefined();
    expect('maxTurns' in o).toBe(false);
    expect('maxBudgetUsd' in o).toBe(false);
  });

  test('non-bypass channel omits dangerous flag and model', async () => {
    const { runner, q } = setup();
    await start(runner, { channelId: 'C2' });
    const o = q.instances[0]!.options;
    expect(o.permissionMode).toBe('default');
    expect('allowDangerouslySkipPermissions' in o).toBe(false);
    expect('model' in o).toBe(false);
  });

  test('resume passes stored session id', async () => {
    const { runner, q, store } = setup();
    await start(runner, { resume: { sessionId: 'old-sess', cwd: '/proj/a' } });
    expect(q.instances[0]!.options.resume).toBe('old-sess');
    expect(store.insertRun.mock.calls[0]![0]).toMatchObject({ sessionId: 'old-sess', prompt: 'hello', channelId: 'C1', threadTs: '100.1' });
  });

  test('insertRun records the status message ts set by beforeStart and the trigger ts', async () => {
    const { runner, store } = setup();
    await start(runner, {
      triggerTs: '100.5',
      beforeStart: async (run) => {
        run.statusTs = '100.6';
      },
    });
    expect(store.insertRun.mock.calls[0]![0]).toMatchObject({ statusTs: '100.6', triggerTs: '100.5' });
  });

  test('prompt is pushed into the input queue', async () => {
    const { runner, q } = setup();
    await start(runner);
    await tick();
    expect(q.instances[0]!.prompts.map((m) => m.message.content)).toEqual(['hello']);
  });
});

describe('Runner start guards', () => {
  test('unknown channel throws NotConfiguredError', async () => {
    const { runner } = setup();
    await expect(start(runner, { channelId: 'CX' })).rejects.toBeInstanceOf(NotConfiguredError);
  });

  test('second run in the same channel throws BusyError carrying the active run', async () => {
    const { runner } = setup();
    const run = await start(runner);
    const err = await start(runner, { threadTs: '200.2' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect((err as BusyError).run).toBe(run);
  });

  test('another channel mapped to the same folder is busy until the run ends', async () => {
    const { runner, q } = setup();
    const run = await start(runner);
    const err = await start(runner, { channelId: 'C3', threadTs: '300.3' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect((err as BusyError).run).toBe(run);
    await start(runner, { channelId: 'C2', threadTs: '300.4' });
    q.instances[0]!.out.push(result(1, 0));
    q.instances[0]!.out.end();
    await run.finished;
    expect((await start(runner, { channelId: 'C3', threadTs: '300.5' })).channelId).toBe('C3');
  });

  test('a symlink to a folder in use is busy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-lock-'));
    try {
      symlinkSync(dir, join(dir, '..', `${dir.split('/').pop()}-link`));
      const channels = new Channels({
        L1: { cwd: dir, permissionMode: 'default', disallowedTools: [] },
        L2: { cwd: `${dir}-link`, permissionMode: 'default', disallowedTools: [] },
      });
      const { runner } = setup({ channels });
      await start(runner, { channelId: 'L1' });
      await expect(start(runner, { channelId: 'L2', threadTs: '400.4' })).rejects.toBeInstanceOf(BusyError);
    } finally {
      rmSync(`${dir}-link`, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a reload applies to the next start and leaves the active run on its config', async () => {
    const channels = new Channels({ C1: CHANNELS.C1! });
    const { runner, q } = setup({ channels });
    const run = await start(runner);
    channels.replace({ C1: { cwd: '/proj/new', permissionMode: 'default', disallowedTools: [] } });
    expect(run.cwd).toBe('/proj/a');
    q.instances[0]!.out.push(result(1, 0));
    q.instances[0]!.out.end();
    await run.finished;
    await start(runner, { threadTs: '500.5' });
    expect(q.instances[1]!.options.cwd).toBe('/proj/new');
    channels.replace({});
    await expect(start(runner, { threadTs: '500.6' })).rejects.toBeInstanceOf(NotConfiguredError);
  });

  test('resume cwd mismatch throws CwdMismatchError', async () => {
    const { runner } = setup();
    const err = await start(runner, { resume: { sessionId: 's', cwd: '/elsewhere' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CwdMismatchError);
    expect(err).toMatchObject({ storedCwd: '/elsewhere', channelCwd: '/proj/a' });
  });

  test('resume of a session whose transcript is gone throws SessionMissingError without spawning the CLI', async () => {
    const sessionExists = vi.fn(async (_id: string, _cwd: string) => false);
    const { runner, q, store } = setup({ sessionExists });
    const err = await start(runner, { resume: { sessionId: 'gone', cwd: '/proj/a' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionMissingError);
    expect(sessionExists.mock.calls[0]).toEqual(['gone', '/proj/a']);
    expect(runner.byChannel('C1')).toBeUndefined();
    expect(store.insertRun).not.toHaveBeenCalled();
    expect(q.fn).not.toHaveBeenCalled();
  });

  test('cwd mismatch is reported before the session lookup runs', async () => {
    const sessionExists = vi.fn(async () => false);
    const { runner } = setup({ sessionExists });
    const err = await start(runner, { resume: { sessionId: 's', cwd: '/elsewhere' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CwdMismatchError);
    expect(sessionExists).not.toHaveBeenCalled();
  });

  test('shutdown during the session lookup rejects the resume', async () => {
    const lookup = Promise.withResolvers<boolean>();
    const { runner, q } = setup({ sessionExists: () => lookup.promise });
    const resuming = start(runner, { resume: { sessionId: 's', cwd: '/proj/a' } }).catch((e: unknown) => e);
    await runner.stopAll();
    lookup.resolve(true);
    expect(await resuming).toBeInstanceOf(ShuttingDownError);
    expect(q.fn).not.toHaveBeenCalled();
  });

  test('a run started while a resume awaits the session lookup still makes the resume busy', async () => {
    const lookup = Promise.withResolvers<boolean>();
    const { runner } = setup({ sessionExists: () => lookup.promise });
    const resuming = start(runner, { resume: { sessionId: 's', cwd: '/proj/a' } }).catch((e: unknown) => e);
    const fresh = await start(runner, { threadTs: '200.2' });
    lookup.resolve(true);
    const err = await resuming;
    expect(err).toBeInstanceOf(BusyError);
    expect((err as BusyError).run).toBe(fresh);
  });

  test('beforeStart runs with the lock held; throwing releases the lock without inserting a run', async () => {
    const { runner, q, store } = setup();
    let seen: Run | undefined;
    const err = await start(runner, {
      beforeStart: async (run) => {
        seen = runner.byChannel('C1');
        expect(seen).toBe(run);
        throw new Error('slack down');
      },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('slack down');
    expect(runner.byChannel('C1')).toBeUndefined();
    expect(runner.active()).toEqual([]);
    expect(store.insertRun).not.toHaveBeenCalled();
    expect(q.fn).not.toHaveBeenCalled();
    await start(runner);
    expect(q.fn).toHaveBeenCalledTimes(1);
  });

  test('insertRun failure releases the lock without spawning the CLI', async () => {
    const { runner, q, store } = setup();
    store.insertRun.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    await expect(start(runner)).rejects.toThrow('db locked');
    expect(runner.active()).toEqual([]);
    expect(q.fn).not.toHaveBeenCalled();
    await start(runner);
    expect(q.fn).toHaveBeenCalledTimes(1);
  });
});

describe('Runner consume loop', () => {
  test('init saves session id and emits init', async () => {
    const { runner, q, store, events } = setup();
    const run = await start(runner);
    q.instances[0]!.out.push(init('sess-9'));
    await tick();
    expect(run.sessionId).toBe('sess-9');
    expect(store.saveThread).toHaveBeenCalledWith({ channelId: 'C1', threadTs: '100.1', sessionId: 'sess-9', cwd: '/proj/a' });
    expect(events).toContain('init');
  });

  test('progress lines, last text, live turn counting', async () => {
    const { runner, q } = setup();
    const run = await start(runner);
    const out = q.instances[0]!.out;
    for (let i = 0; i < 12; i++) out.push(assistant(`m${i}`));
    out.push(assistant('m11'));
    out.push(assistant('sub', 'tool-1'));
    await tick();
    expect(run.progress).toHaveLength(10);
    expect(run.progress.at(-1)?.head).toBe('line sub');
    expect(run.lastText).toBe('text sub');
    expect(run.pendingText).toBe('text sub');
    expect(run.turns).toBe(12);
  });

  test('inject: queued while active, closed after first result, none without a run', async () => {
    const { runner, q } = setup();
    const run = await start(runner);
    expect(runner.inject('C1', '100.1', 'more')).toBe('queued');
    await tick();
    expect(q.instances[0]!.prompts.map((m) => m.message.content)).toEqual(['hello', 'more']);
    q.instances[0]!.out.push(result(1, 0.1));
    await tick();
    expect(run.queue.closed).toBe(true);
    expect(runner.inject('C1', '100.1', 'late')).toBe('closed');
    expect(runner.inject('C1', '999.9', 'x')).toBe('none');
    q.instances[0]!.out.end();
    await run.finished;
    expect(runner.inject('C1', '100.1', 'x')).toBe('none');
  });

  test('two results before iterator end: two result events, single end, summed turns, last cost', async () => {
    const { runner, q, store, events, pending } = setup();
    const run = await start(runner);
    const results: SDKResultMessage[] = [];
    runner.on('result', (_r, msg) => results.push(msg));
    let endRun: Run | undefined;
    let lockedAtEnd: Run | undefined;
    runner.on('end', (r) => {
      endRun = r;
      lockedAtEnd = runner.byChannel('C1');
    });
    const out = q.instances[0]!.out;
    out.push(init());
    out.push(assistant('a1'));
    out.push(result(2, 0.1));
    out.push(assistant('a2'));
    out.push(result(3, 0.25));
    await tick();
    expect(results).toHaveLength(2);
    expect(run.status).toBe('running');
    expect(run.pendingText).toBeUndefined();
    out.end();
    await run.finished;
    expect(events.filter((e) => e === 'end')).toHaveLength(1);
    expect(events).not.toContain('error');
    expect(endRun).toBe(run);
    expect(lockedAtEnd).toBeUndefined();
    expect(run.status).toBe('done');
    expect(run.turns).toBe(5);
    expect(run.costUsd).toBe(0.25);
    expect(pending.rejectRun).toHaveBeenCalledWith(run.id, 'done');
    expect(store.finishRun).toHaveBeenCalledTimes(1);
    expect(store.finishRun.mock.calls[0]).toEqual([run.id, { status: 'done', sessionId: 'sess-1', turns: 5, costUsd: 0.25, durationMs: expect.any(Number), endedAt: expect.any(Number) }] as never);
  });

  test('error result finishes with status error', async () => {
    const { runner, q, store, events } = setup();
    const run = await start(runner);
    q.instances[0]!.out.push(result(1, 0.05, { subtype: 'error_during_execution', is_error: true, errors: ['boom'] }));
    q.instances[0]!.out.end();
    await run.finished;
    expect(run.status).toBe('error');
    expect(run.error).toBe('boom');
    expect(events).toContain('error');
    expect(store.finishRun.mock.calls[0]![1]).toMatchObject({ status: 'error', turns: 1 });
  });

  test('iterator ending without a result is an error', async () => {
    const { runner, q } = setup();
    const run = await start(runner);
    q.instances[0]!.out.end();
    await run.finished;
    expect(run.status).toBe('error');
    expect(run.error).toBe('ended without a result');
  });

  test('thrown iterator records the error; listener exceptions do not break finalization', async () => {
    const { runner, q, store } = setup();
    runner.on('error', () => {
      throw new Error('listener bug');
    });
    const run = await start(runner);
    q.instances[0]!.out.fail(new Error('cli crashed'));
    await run.finished;
    expect(run.status).toBe('error');
    expect(run.error).toBe('cli crashed');
    expect(store.finishRun).toHaveBeenCalledTimes(1);
    expect(runner.active()).toEqual([]);
  });

  test('store failure in finishRun does not prevent end', async () => {
    const { runner, q, store, events } = setup();
    store.finishRun.mockImplementation(() => {
      throw new Error('disk full');
    });
    const run = await start(runner);
    q.instances[0]!.out.push(result(1, 0));
    q.instances[0]!.out.end();
    await run.finished;
    expect(events).toContain('end');
  });
});

describe('Runner setPendingCount', () => {
  test('toggles running/waiting, emits prompt on change, never overrides stopping', async () => {
    const { runner, q, events } = setup();
    const run = await start(runner);
    runner.setPendingCount(run.id, 1);
    expect(run.phase).toBe('waiting');
    runner.setPendingCount(run.id, 2);
    runner.setPendingCount(run.id, 0);
    expect(run.phase).toBe('running');
    expect(events.filter((e) => e === 'prompt')).toHaveLength(2);
    q.instances[0]!.interrupt.mockImplementation(() => new Promise(() => {}));
    void runner.stop(run.id);
    expect(run.phase).toBe('stopping');
    runner.setPendingCount(run.id, 1);
    expect(run.phase).toBe('stopping');
    q.instances[0]!.out.end();
    await run.finished;
  });
});

describe('Runner stop', () => {
  test('closes queue, rejects pending, interrupts; no close when iterator completes promptly', async () => {
    const { runner, q, pending, events } = setup({ stopTimeoutMs: 1000 });
    const run = await start(runner);
    const fq = q.instances[0]!;
    fq.interrupt.mockImplementation(async () => {
      setTimeout(() => fq.out.end(), 5);
      return { still_queued: [] };
    });
    const p1 = runner.stop(run.id);
    const p2 = runner.stop(run.id);
    expect(run.queue.closed).toBe(true);
    expect(pending.rejectRun).toHaveBeenCalledWith(run.id, 'stopped');
    await Promise.all([p1, p2]);
    expect(fq.interrupt).toHaveBeenCalledTimes(1);
    expect(fq.close).not.toHaveBeenCalled();
    expect(run.status).toBe('stopped');
    expect(events).toContain('stopped');
    expect(events).not.toContain('error');
    await runner.stop(run.id);
  });

  test('calls close when still_queued is non-empty', async () => {
    const { runner, q, store } = setup({ stopTimeoutMs: 5000 });
    const run = await start(runner);
    const fq = q.instances[0]!;
    fq.interrupt.mockImplementation(async () => ({ still_queued: ['u1'] }));
    await runner.stop(run.id);
    expect(fq.close).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('stopped');
    expect(store.finishRun.mock.calls[0]![1]).toMatchObject({ status: 'stopped' });
  });

  test('calls close after timeout when the iterator does not complete', async () => {
    const { runner, q } = setup({ stopTimeoutMs: 20 });
    const run = await start(runner);
    const fq = q.instances[0]!;
    fq.interrupt.mockImplementation(async () => undefined);
    await runner.stop(run.id);
    expect(fq.close).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('stopped');
  });

  test('interrupt failure is tolerated and an iterator error after stop is ignored', async () => {
    const { runner, q } = setup({ stopTimeoutMs: 20 });
    const run = await start(runner);
    const fq = q.instances[0]!;
    fq.interrupt.mockImplementation(async () => {
      throw new Error('not streaming');
    });
    fq.close.mockImplementation(() => fq.out.fail(new Error('aborted')));
    await runner.stop(run.id);
    expect(run.status).toBe('stopped');
    expect(run.error).toBeUndefined();
  });

  test('calls close when interrupt itself hangs past the deadline', async () => {
    const { runner, q } = setup({ stopTimeoutMs: 20 });
    const run = await start(runner);
    const fq = q.instances[0]!;
    fq.interrupt.mockImplementation(() => new Promise(() => {}));
    await runner.stop(run.id);
    expect(fq.close).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('stopped');
  });

  test('error result produced by the interrupt keeps the partial text', async () => {
    const { runner, q } = setup({ stopTimeoutMs: 1000 });
    const run = await start(runner);
    const fq = q.instances[0]!;
    fq.out.push(assistant('m1'));
    await tick();
    fq.interrupt.mockImplementation(async () => {
      fq.out.push(result(1, 0.1, { subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] }));
      setTimeout(() => fq.out.end(), 5);
      return { still_queued: [] };
    });
    await runner.stop(run.id);
    expect(run.status).toBe('stopped');
    expect(run.pendingText).toBe('text m1');
  });

  test('stop of unknown run is a no-op', async () => {
    const { runner } = setup();
    await runner.stop('nope');
  });

  test('stopAll marks runs shutdown and closes the query', async () => {
    const { runner, q, pending, events } = setup();
    const a = await start(runner);
    const b = await start(runner, { channelId: 'C2', threadTs: '300.3' });
    await runner.stopAll();
    for (const [run, fq] of [
      [a, q.instances[0]!],
      [b, q.instances[1]!],
    ] as const) {
      expect(run.status).toBe('shutdown');
      expect(fq.close).toHaveBeenCalled();
      expect(pending.rejectRun).toHaveBeenCalledWith(run.id, 'shutdown');
    }
    expect(events.filter((e) => e === 'stopped')).toHaveLength(2);
    expect(runner.active()).toEqual([]);
    await expect(start(runner)).rejects.toBeInstanceOf(ShuttingDownError);
  });

  test('stopAll finalizes a run whose CLI ignores close() after the timeout', async () => {
    const { runner, q, store, events } = setup({ stopTimeoutMs: 20 });
    const run = await start(runner);
    q.instances[0]!.close.mockImplementation(() => {});
    await runner.stopAll();
    expect(run.status).toBe('shutdown');
    expect(store.finishRun).toHaveBeenCalledTimes(1);
    expect(store.finishRun.mock.calls[0]![1].status).toBe('shutdown');
    expect(events.filter((e) => e === 'end')).toHaveLength(1);
    expect(runner.active()).toEqual([]);
    q.instances[0]!.out.end();
    await tick();
    expect(events.filter((e) => e === 'end')).toHaveLength(1);
  });

  test('stop tolerates an interrupt receipt without still_queued', async () => {
    const { runner, q } = setup({ stopTimeoutMs: 1000 });
    const run = await start(runner);
    q.instances[0]!.interrupt.mockImplementation(async () => ({}) as never);
    const stopping = runner.stop(run.id);
    await tick();
    q.instances[0]!.out.end();
    await stopping;
    expect(run.status).toBe('stopped');
    expect(q.instances[0]!.close).not.toHaveBeenCalled();
  });
});
