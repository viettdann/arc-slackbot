import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { query as sdkQuery, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Channels } from '../src/channels.ts';
import { ConfigError } from '../src/config.ts';
import { PendingRegistry } from '../src/permissions.ts';
import { Runner } from '../src/runner.ts';
import { Controller, RateBudget, parseChannelArg, type SlackClient } from '../src/slack.ts';
import { Store } from '../src/store.ts';
import type { ChannelConfig } from '../src/types.ts';

const BOT = 'UBOT';
const OWNER = 'UOWNER';
const CHANNEL = 'C111';
const DIRECT = 'D555';

interface FakeQuery {
  prompts: string[];
  emit(msg: SDKMessage): void;
  end(): void;
  resume?: string;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'routing-'));
  const store = new Store(':memory:');
  const registry = new PendingRegistry();
  const calls: { method: string; args: Record<string, unknown>; ts: string }[] = [];
  const record = (method: string) => async (args: Record<string, unknown>) => {
    const ts = `${calls.length + 1}.000`;
    calls.push({ method, args, ts });
    return { ok: true, channel: args.channel, ts };
  };
  const client = {
    chat: { postMessage: record('chat.postMessage'), postEphemeral: record('chat.postEphemeral'), update: record('chat.update') },
    reactions: { add: record('reactions.add'), remove: record('reactions.remove') },
    views: { publish: record('views.publish'), open: record('views.open') },
    files: { uploadV2: record('files.uploadV2') },
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        const m = membership[channel] ?? 'member';
        if (m === 'member' || m === 'outside') return { ok: true, channel: { id: channel, is_member: m === 'member' } };
        throw Object.assign(new Error(m), { data: { error: m } });
      },
    },
  } as unknown as SlackClient;
  const membership: Record<string, 'member' | 'outside' | 'channel_not_found' | 'missing_scope'> = {};

  const queries: FakeQuery[] = [];
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: { resume?: string } }) => {
    const pending: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const fake: FakeQuery = {
      prompts: [],
      resume: params.options.resume,
      emit(msg) {
        pending.push(msg);
        wake?.();
      },
      end() {
        ended = true;
        wake?.();
      },
    };
    queries.push(fake);
    void (async () => {
      for await (const m of params.prompt) fake.prompts.push(m.message.content as string);
    })();
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      while (true) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    }
    const it = gen() as unknown as Query;
    Object.assign(it, { interrupt: async () => ({ still_queued: [] }), close: () => fake.end() });
    return it;
  }) as unknown as typeof sdkQuery;

  const sessions = { alive: true };
  const channel = (cwd = dir): ChannelConfig => ({ cwd, permissionMode: 'bypassPermissions', disallowedTools: [] });
  const channels = new Channels({ [CHANNEL]: channel(), direct: channel(join(dir, 'direct')) });
  mkdirSync(join(dir, 'direct'));
  // Stands in for channels.json; a thrown ConfigError models an invalid file.
  const file: { next: Record<string, ChannelConfig> | ConfigError } = { next: {} };
  let controller: Controller | undefined;
  const runner = new Runner({
    channels,
    store,
    pending: registry,
    canUseTool: (run) => controller!.canUseToolFor(run),
    describe: () => ({ lines: [] }),
    query,
    sessionExists: async () => sessions.alive,
    stopTimeoutMs: 50,
  });
  controller = new Controller({
    client,
    runner,
    store,
    registry,
    config: { allowedUserId: OWNER },
    channels,
    loadChannels: () => {
      if (file.next instanceof ConfigError) throw file.next;
      return file.next;
    },
    botUserId: BOT,
    saveFiles: async (files, channelId, threadTs) => ({ saved: files.map((f) => `/files/${channelId}/${threadTs}/${f.id}`), failed: [] }),
    teamUrl: 'https://example.slack.com/',
    statusIntervalMs: 0,
    homeDebounceMs: 0,
    budget: new RateBudget(10_000, 10_000),
  });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, registry, runner, controller, channels, channel, file, membership, calls, queries, sessions, cleanup };
}

type Ctx = ReturnType<typeof setup>;
let ctx: Ctx;

beforeEach(() => {
  ctx = setup();
});

afterEach(async () => {
  await ctx.runner.stopAll();
  await ctx.controller.drain();
  ctx.cleanup();
});

const tick = () => new Promise((r) => setTimeout(r, 5));
const init = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId }) as unknown as SDKMessage;
const result = (text: string) =>
  ({ type: 'result', subtype: 'success', result: text, is_error: false, num_turns: 1, duration_ms: 10, total_cost_usd: 0.01 }) as unknown as SDKMessage;

describe('app_mention routing', () => {
  test('top-level mention starts a run in a new thread keyed by the mention ts', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> fix the bug`, ts: '100.1' });
    const run = ctx.runner.byChannel(CHANNEL)!;
    expect(run.threadTs).toBe('100.1');
    expect(run.prompt).toBe('fix the bug');
    await tick();
    expect(ctx.queries[0]!.prompts).toEqual(['fix the bug']);
    const status = ctx.calls.find((c) => c.method === 'chat.postMessage')!;
    expect(status.args.thread_ts).toBe('100.1');
    expect(ctx.calls.filter((c) => c.method === 'reactions.add').map((c) => c.args.name)).toEqual(['eyes', 'hourglass_flowing_sand']);
  });

  test('mention in an unknown thread starts a run in that thread', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> hi`, ts: '200.2', thread_ts: '200.0' });
    expect(ctx.runner.byChannel(CHANNEL)!.threadTs).toBe('200.0');
  });

  test('mention in a known thread is handled once as a thread reply', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> first`, ts: '300.0' });
    await tick();
    const reply = { channel: CHANNEL, user: OWNER, text: `<@${BOT}> also this`, ts: '300.5', thread_ts: '300.0' };
    await ctx.controller.onAppMention(reply);
    await ctx.controller.onMessage(reply);
    await tick();
    expect(ctx.queries).toHaveLength(1);
    expect(ctx.queries[0]!.prompts).toEqual(['first', 'also this']);
    expect(ctx.calls.filter((c) => c.method === 'reactions.add' && c.args.name === 'incoming_envelope')).toHaveLength(1);
  });

  test('mention in a thread known from the store resumes the session', async () => {
    ctx.store.saveThread({ channelId: CHANNEL, threadTs: '400.0', sessionId: 'sess-1', cwd: ctx.dir });
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> continue`, ts: '400.9', thread_ts: '400.0' });
    expect(ctx.queries[0]!.resume).toBe('sess-1');
    expect(ctx.runner.byChannel(CHANNEL)!.triggerTs).toBe('400.9');
  });

  test('reply in a thread whose run failed before init starts a fresh run there', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> first`, ts: '420.0' });
    await tick();
    ctx.queries[0]!.end();
    await tick();
    expect(ctx.store.getThread(CHANNEL, '420.0')).toBeNull();
    await ctx.controller.onMessage({ channel: CHANNEL, user: OWNER, text: 'retry', ts: '420.1', thread_ts: '420.0' });
    await tick();
    expect(ctx.queries).toHaveLength(2);
    expect(ctx.queries[1]!.resume).toBeUndefined();
    expect(ctx.queries[1]!.prompts).toEqual(['retry']);
    expect(ctx.runner.byChannel(CHANNEL)!.threadTs).toBe('420.0');
  });

  test('resume with a changed cwd posts an error and starts nothing', async () => {
    ctx.store.saveThread({ channelId: CHANNEL, threadTs: '450.0', sessionId: 'sess-1', cwd: '/elsewhere' });
    await ctx.controller.onMessage({ channel: CHANNEL, user: OWNER, text: 'go on', ts: '450.1', thread_ts: '450.0' });
    expect(ctx.queries).toHaveLength(0);
    const post = ctx.calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.args.text).toContain('Cannot resume');
  });

  test('resume of an expired session posts an error and starts nothing', async () => {
    ctx.sessions.alive = false;
    ctx.store.saveThread({ channelId: CHANNEL, threadTs: '460.0', sessionId: 'sess-old', cwd: ctx.dir });
    await ctx.controller.onMessage({ channel: CHANNEL, user: OWNER, text: 'go on', ts: '460.1', thread_ts: '460.0' });
    expect(ctx.queries).toHaveLength(0);
    expect(ctx.runner.byChannel(CHANNEL)).toBeUndefined();
    const post = ctx.calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.args).toMatchObject({ channel: CHANNEL, thread_ts: '460.0' });
    expect(post.args.text).toContain('session transcript is gone');
  });

  test('unmapped channel gets an ephemeral reply', async () => {
    await ctx.controller.onAppMention({ channel: 'C999', user: OWNER, text: `<@${BOT}> hi`, ts: '1.0' });
    expect(ctx.queries).toHaveLength(0);
    expect(ctx.calls.find((c) => c.method === 'chat.postEphemeral')!.args.text).toContain('not configured');
  });

  test('second mention while busy gets an ephemeral busy reply with a link', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> one`, ts: '500.0' });
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> two`, ts: '501.0' });
    const eph = ctx.calls.find((c) => c.method === 'chat.postEphemeral')!;
    expect(eph.args.text).toContain('Busy');
    expect(eph.args.text).toContain('/archives/C111/p5000');
    expect(ctx.queries).toHaveLength(1);
  });

  test('non-allowed user is ignored', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: 'USTRANGER', text: `<@${BOT}> hi`, ts: '600.0' });
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.queries).toHaveLength(0);
  });
});

describe('folder lock', () => {
  test('a mention in another channel mapped to the busy folder names that channel', async () => {
    ctx.channels.replace({ [CHANNEL]: ctx.channel(), C222: ctx.channel(`${ctx.dir}/`) });
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> one`, ts: '510.0' });
    await ctx.controller.onAppMention({ channel: 'C222', user: OWNER, text: `<@${BOT}> two`, ts: '511.0' });
    const eph = ctx.calls.find((c) => c.method === 'chat.postEphemeral')!;
    expect(eph.args).toMatchObject({ channel: 'C222', user: OWNER });
    expect(eph.args.text).toContain(`Busy: \`${ctx.dir}\` is in use by a run in <#${CHANNEL}>.`);
    expect(ctx.queries).toHaveLength(1);
  });
});

describe('direct messages', () => {
  test('a top-level direct message starts a run in its own thread without a mention', async () => {
    await ctx.controller.onMessage({ channel: DIRECT, user: OWNER, text: 'check the logs', ts: '1000.0' });
    const run = ctx.runner.byChannel(DIRECT)!;
    expect(run).toMatchObject({ threadTs: '1000.0', prompt: 'check the logs', cwd: join(ctx.dir, 'direct') });
    expect(ctx.calls.find((c) => c.method === 'chat.postMessage')!.args).toMatchObject({ channel: DIRECT, thread_ts: '1000.0' });
  });

  test('a direct message mention is stripped and an app_mention from a direct message is ignored', async () => {
    const event = { channel: DIRECT, user: OWNER, text: `<@${BOT}> hi there`, ts: '1010.0' };
    await ctx.controller.onAppMention(event);
    expect(ctx.queries).toHaveLength(0);
    await ctx.controller.onMessage(event);
    await tick();
    expect(ctx.queries).toHaveLength(1);
    expect(ctx.queries[0]!.prompts).toEqual(['hi there']);
  });

  test('a reply in the direct message thread is injected; other users and bots are ignored', async () => {
    await ctx.controller.onMessage({ channel: DIRECT, user: OWNER, text: 'start', ts: '1020.0' });
    await ctx.controller.onMessage({ channel: DIRECT, user: OWNER, text: 'more', ts: '1020.1', thread_ts: '1020.0' });
    await ctx.controller.onMessage({ channel: DIRECT, user: 'USTRANGER', text: 'x', ts: '1020.2', thread_ts: '1020.0' });
    await ctx.controller.onMessage({ channel: DIRECT, user: OWNER, bot_id: 'B1', text: 'x', ts: '1020.3', thread_ts: '1020.0' });
    await tick();
    expect(ctx.queries).toHaveLength(1);
    expect(ctx.queries[0]!.prompts).toEqual(['start', 'more']);
  });

  test('without a direct entry the direct message gets an ephemeral reply', async () => {
    ctx.channels.replace({ [CHANNEL]: ctx.channel() });
    await ctx.controller.onMessage({ channel: DIRECT, user: OWNER, text: 'hello', ts: '1030.0' });
    expect(ctx.queries).toHaveLength(0);
    expect(ctx.calls.find((c) => c.method === 'chat.postEphemeral')!.args).toMatchObject({ channel: DIRECT, text: expect.stringContaining('Direct messages are not configured') });
  });
});

describe('message routing', () => {
  beforeEach(async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> start`, ts: '700.0' });
    await tick();
  });

  test('thread reply during a run is injected', async () => {
    await ctx.controller.onMessage({ channel: CHANNEL, user: OWNER, text: 'more', ts: '700.1', thread_ts: '700.0' });
    await tick();
    expect(ctx.queries[0]!.prompts).toEqual(['start', 'more']);
  });

  test('subtypes, bot messages, other users, top-level and unknown threads are ignored', async () => {
    const base = { channel: CHANNEL, user: OWNER, text: 'x', ts: '700.2', thread_ts: '700.0' };
    await ctx.controller.onMessage({ ...base, subtype: 'message_changed' });
    await ctx.controller.onMessage({ ...base, bot_id: 'B1' });
    await ctx.controller.onMessage({ ...base, user: 'USTRANGER' });
    await ctx.controller.onMessage({ ...base, thread_ts: undefined });
    await ctx.controller.onMessage({ ...base, thread_ts: '999.0' });
    await tick();
    expect(ctx.queries[0]!.prompts).toEqual(['start']);
  });

  test('file_share and thread_broadcast replies are injected, files as local paths', async () => {
    const base = { channel: CHANNEL, user: OWNER, thread_ts: '700.0' };
    await ctx.controller.onMessage({ ...base, subtype: 'thread_broadcast', text: 'also here', ts: '700.3' });
    await ctx.controller.onMessage({ ...base, subtype: 'file_share', text: 'see log', ts: '700.4', files: [{ id: 'F1', name: 'a.log' }] });
    await ctx.controller.onMessage({ ...base, subtype: 'file_share', text: '', ts: '700.5', files: [{ id: 'F2' }] });
    await tick();
    expect(ctx.queries[0]!.prompts).toEqual([
      'start',
      'also here',
      `see log\n\nAttached files (saved locally):\n- /files/${CHANNEL}/700.0/F1`,
      `Attached files (saved locally):\n- /files/${CHANNEL}/700.0/F2`,
    ]);
  });

  test('reply after the queue closed starts a resume run once the current run ends', async () => {
    const q = ctx.queries[0]!;
    q.emit(init('sess-7'));
    q.emit(result('done'));
    await tick();
    const pending = ctx.controller.onMessage({ channel: CHANNEL, user: OWNER, text: 'next', ts: '700.3', thread_ts: '700.0' });
    await tick();
    expect(ctx.queries).toHaveLength(1);
    q.end();
    await pending;
    expect(ctx.queries).toHaveLength(2);
    expect(ctx.queries[1]!.resume).toBe('sess-7');
    const reactions = ctx.calls.filter((c) => c.method === 'reactions.add').map((c) => c.args.name);
    expect(reactions).toContain('white_check_mark');
  });

  test('result is posted before the final reaction', async () => {
    const q = ctx.queries[0]!;
    q.emit(result('the answer'));
    q.end();
    await ctx.runner.byChannel(CHANNEL)?.finished;
    await ctx.controller.drain();
    const resultIdx = ctx.calls.findIndex((c) => c.method === 'chat.postMessage' && c.args.text === 'the answer');
    const doneIdx = ctx.calls.findIndex((c) => c.method === 'reactions.add' && c.args.name === 'white_check_mark');
    expect(resultIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(resultIdx);
  });
});

describe('run presentation', () => {
  test('reactions go eyes, hourglass, raised hand, hourglass, check in order', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> go`, ts: '900.0' });
    const run = ctx.runner.byChannel(CHANNEL)!;
    ctx.runner.setPendingCount(run.id, 1);
    ctx.runner.setPendingCount(run.id, 0);
    ctx.queries[0]!.emit(result('ok'));
    ctx.queries[0]!.end();
    await run.finished;
    await ctx.controller.drain();
    const ops = ctx.calls.filter((c) => c.method.startsWith('reactions.')).map((c) => `${c.method === 'reactions.add' ? '+' : '-'}${c.args.name}`);
    expect(ops).toEqual(['+eyes', '-eyes', '+hourglass_flowing_sand', '-hourglass_flowing_sand', '+raised_hand', '-raised_hand', '+hourglass_flowing_sand', '-hourglass_flowing_sand', '+white_check_mark']);
  });

  test('stop posts the partial text instead of the interrupt error result', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> go`, ts: '910.0' });
    const run = ctx.runner.byChannel(CHANNEL)!;
    run.pendingText = 'partial work';
    run.lastText = 'partial work';
    const q = ctx.queries[0]!;
    const stopping = ctx.runner.stop(run.id);
    q.emit({ type: 'result', subtype: 'error_during_execution', errors: ['interrupted'], is_error: true, num_turns: 1, duration_ms: 5, total_cost_usd: 0 } as unknown as SDKMessage);
    q.end();
    await stopping;
    await ctx.controller.drain();
    const texts = ctx.calls.filter((c) => c.method === 'chat.postMessage').map((c) => String(c.args.text));
    expect(texts.some((t) => t.includes('interrupted'))).toBe(false);
    expect(texts).toContain('partial work');
    expect(ctx.calls.some((c) => c.method === 'reactions.add' && c.args.name === 'black_square_for_stop')).toBe(true);
  });

  test('long result is uploaded as result.md', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> go`, ts: '920.0' });
    const run = ctx.runner.byChannel(CHANNEL)!;
    ctx.queries[0]!.emit(result('x'.repeat(12_001)));
    ctx.queries[0]!.end();
    await run.finished;
    await ctx.controller.drain();
    const upload = ctx.calls.find((c) => c.method === 'files.uploadV2')!;
    expect(upload.args).toMatchObject({ filename: 'result.md', thread_ts: '920.0', channel_id: CHANNEL });
    expect(String(upload.args.content)).toHaveLength(12_001);
  });
});

describe('crash recovery', () => {
  test('the run record keeps the status message and trigger ts', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> go`, ts: '950.0' });
    const statusPost = ctx.calls.find((c) => c.method === 'chat.postMessage')!;
    expect(ctx.store.recentRuns(1)[0]).toMatchObject({ statusTs: statusPost.ts, triggerTs: '950.0' });
  });

  test('cleanupInterrupted rewrites the status message and swaps live reactions for stop', async () => {
    ctx.store.insertRun({ id: 'dead', channelId: CHANNEL, threadTs: '960.0', prompt: 'p', startedAt: 1, statusTs: '960.1', triggerTs: '960.0' });
    ctx.store.insertRun({ id: 'early', channelId: CHANNEL, threadTs: '970.0', prompt: 'p', startedAt: 2 });
    await ctx.controller.cleanupInterrupted(ctx.store.recoverStaleRuns(Date.now()));
    const updates = ctx.calls.filter((c) => c.method === 'chat.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args).toMatchObject({ channel: CHANNEL, ts: '960.1' });
    expect(String(updates[0]!.args.text)).toContain('Interrupted');
    const ops = ctx.calls.filter((c) => c.method.startsWith('reactions.')).map((c) => `${c.method === 'reactions.add' ? '+' : '-'}${c.args.name}@${c.args.timestamp}`);
    expect(ops).toEqual(['-eyes@960.0', '-hourglass_flowing_sand@960.0', '-raised_hand@960.0', '+black_square_for_stop@960.0']);
  });
});

describe('stale actions', () => {
  const src = { userId: OWNER, channelId: CHANNEL, threadTs: '980.0' };

  test('stop, approve, always and deny report false for unknown ids', () => {
    expect(ctx.controller.stop('no-run')).toBe(false);
    expect(ctx.controller.approve('no-prompt')).toBe(false);
    expect(ctx.controller.alwaysAllow('no-prompt')).toBe(false);
    expect(ctx.controller.deny('no-prompt')).toBe(false);
    expect(ctx.controller.isPending('no-prompt', 'approval')).toBe(false);
  });

  test('stop reports true for an active run', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> go`, ts: '985.0' });
    expect(ctx.controller.stop(ctx.runner.byChannel(CHANNEL)!.id)).toBe(true);
  });

  test('a pending approval is resolved once; the second click is stale', () => {
    void ctx.registry
      .create({ kind: 'approval', id: 'p1', runId: 'r1', toolName: 'Bash', input: {}, showAlwaysAllow: false })
      .catch(() => undefined);
    expect(ctx.controller.isPending('p1', 'approval')).toBe(true);
    expect(ctx.controller.isPending('p1', 'question')).toBe(false);
    expect(ctx.controller.approve('p1')).toBe(true);
    expect(ctx.controller.approve('p1')).toBe(false);
  });

  test('submitting a gone question and notifyStale post an ephemeral in the thread', async () => {
    await ctx.controller.submitQuestion('no-prompt', undefined, src);
    await ctx.controller.notifyStale(src);
    const eph = ctx.calls.filter((c) => c.method === 'chat.postEphemeral');
    expect(eph).toHaveLength(2);
    for (const e of eph) expect(e.args).toMatchObject({ channel: CHANNEL, user: OWNER, thread_ts: '980.0', text: 'This run or prompt is no longer active.' });
  });

  test('notifyStale without a channel (App Home) republishes the home view instead of posting', async () => {
    await ctx.controller.notifyStale({ userId: OWNER });
    await tick();
    expect(ctx.calls.map((c) => c.method)).toEqual(['views.publish']);
  });
});

describe('/claude', () => {
  test('stop with an escaped channel stops that channel', async () => {
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> go`, ts: '800.0' });
    const reply = await ctx.controller.onCommand({ user_id: OWNER, channel_id: 'C222', text: `stop <#${CHANNEL}|proj>` });
    expect(reply).toContain('Stopping');
    await ctx.runner.byChannel(CHANNEL)?.finished;
    expect(ctx.runner.byChannel(CHANNEL)).toBeUndefined();
  });

  test('stop without argument uses the current channel; status lists runs', async () => {
    expect(await ctx.controller.onCommand({ user_id: OWNER, channel_id: CHANNEL, text: 'stop' })).toContain('No active run');
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> go`, ts: '810.0' });
    expect(await ctx.controller.onCommand({ user_id: OWNER, channel_id: CHANNEL, text: 'status' })).toContain(`<#${CHANNEL}>`);
  });

  test('stop direct stops the direct message run; status labels it Direct', async () => {
    await ctx.controller.onMessage({ channel: DIRECT, user: OWNER, text: 'go', ts: '830.0' });
    expect(await ctx.controller.onCommand({ user_id: OWNER, channel_id: CHANNEL, text: 'status' })).toContain('• Direct ·');
    expect(await ctx.controller.onCommand({ user_id: OWNER, channel_id: CHANNEL, text: 'stop direct' })).toBe('Stopping the run in Direct…');
    await ctx.runner.byChannel(DIRECT)?.finished;
    expect(ctx.runner.byChannel(DIRECT)).toBeUndefined();
    expect(await ctx.controller.onCommand({ user_id: OWNER, channel_id: CHANNEL, text: 'stop direct' })).toBe('No active run in Direct.');
    expect(await ctx.controller.onCommand({ user_id: OWNER, channel_id: CHANNEL, text: 'stop #nope' })).toContain('Unknown channel');
  });

  test('channels lists every entry with membership problems and the active run', async () => {
    ctx.channels.replace({ [CHANNEL]: ctx.channel(), C222: { ...ctx.channel('/p/two'), model: 'claude-opus-5-5' }, C333: ctx.channel('/p/three'), direct: ctx.channel('/p/direct') });
    Object.assign(ctx.membership, { C222: 'outside', C333: 'missing_scope' });
    await ctx.controller.onAppMention({ channel: CHANNEL, user: OWNER, text: `<@${BOT}> go`, ts: '840.0' });
    const lines = (await ctx.controller.onCommand({ user_id: OWNER, channel_id: CHANNEL, text: 'channels' }))!.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]!.startsWith(`• <#${CHANNEL}> · \`${ctx.dir}\` · bypassPermissions · ⏳ active run <https://example.slack.com/archives/${CHANNEL}/p8400|thread>`)).toBe(true);
    expect(lines[1]).toBe('• <#C222> · `/p/two` · bypassPermissions · claude-opus-5-5 · ⚠️ bot is not in this channel; run `/invite @bot` there');
    expect(lines[2]).toContain('add the `channels:read` and `groups:read` scopes');
    expect(lines[3]).toBe('• Direct · `/p/direct` · bypassPermissions');
  });

  test('reload replaces the mapping and warns about added channels the bot is not in', async () => {
    ctx.file.next = { [CHANNEL]: ctx.channel(), C444: ctx.channel('/p/four') };
    ctx.membership.C444 = 'channel_not_found';
    const reply = await ctx.controller.onCommand({ user_id: OWNER, channel_id: CHANNEL, text: 'reload' });
    expect(reply).toBe('✅ Reloaded channels: added C444; removed direct.\n⚠️ <#C444>: bot is not in this channel; run `/invite @bot` there');
    expect(ctx.channels.get('C444')?.cwd).toBe('/p/four');
    expect(ctx.channels.get(DIRECT)).toBeUndefined();
  });

  test('a failed reload keeps the previous mapping', async () => {
    ctx.file.next = new ConfigError('cannot read channels.json: bad JSON');
    const reply = await ctx.controller.onCommand({ user_id: OWNER, channel_id: CHANNEL, text: 'reload' });
    expect(reply).toBe('❌ Reload failed, keeping the previous mapping: cannot read channels.json: bad JSON');
    expect(ctx.channels.get(CHANNEL)).toBeDefined();
  });

  test('non-allowed user gets nothing', async () => {
    expect(await ctx.controller.onCommand({ user_id: 'USTRANGER', channel_id: CHANNEL, text: 'status' })).toBeUndefined();
  });

  test('parseChannelArg', () => {
    expect(parseChannelArg('<#C0123ABC|general>')).toBe('C0123ABC');
    expect(parseChannelArg('<#G0123ABC>')).toBe('G0123ABC');
    expect(parseChannelArg('C0123ABC')).toBe('C0123ABC');
    expect(parseChannelArg('#general')).toBeUndefined();
  });
});
