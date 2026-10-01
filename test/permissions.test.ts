import { describe, expect, test } from 'bun:test';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import {
  PendingRegistry,
  alwaysAllow,
  approve,
  createCanUseTool,
  deny,
  setOtherAnswer,
  submitAnswers,
  type MessageRef,
} from '../src/permissions.ts';
import type { Prompt, PromptOutcome } from '../src/types.ts';

const RUN = 'run-1';
const REF: MessageRef = { channel: 'C1', ts: '111.222' };

function setup(post?: (prompt: Prompt) => Promise<MessageRef | undefined>) {
  const registry = new PendingRegistry();
  const settled: { prompt: Prompt; outcome: PromptOutcome; message: MessageRef | undefined }[] = [];
  const waiting: number[] = [];
  const canUseTool = createCanUseTool({
    runId: RUN,
    registry,
    post: post ?? (async () => REF),
    settle: (prompt, outcome, message) => {
      settled.push({ prompt, outcome, message });
    },
    onWaitingChange: (n) => waiting.push(n),
  });
  return { registry, settled, waiting, canUseTool };
}

type Opts = Partial<Parameters<ReturnType<typeof createCanUseTool>>[2]>;

function call(canUseTool: ReturnType<typeof createCanUseTool>, toolName: string, input: Record<string, unknown>, opts: Opts = {}) {
  return canUseTool(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: 'tu-1',
    requestId: 'req-1',
    ...opts,
  });
}

async function pendingId(registry: PendingRegistry): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const entry = registry.entries()[0];
    if (entry) return entry.id;
    await Bun.sleep(0);
  }
  throw new Error('no pending entry');
}

const questionInput = {
  questions: [
    { question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: 'SQL' }, { label: 'Mongo' }], multiSelect: false },
    { question: 'Which features?', header: 'Feat', options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }], multiSelect: true },
  ],
  extra: 'keep-me',
};

const suggestions: PermissionUpdate[] = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addDirectories', directories: ['/tmp'], destination: 'projectSettings' },
];

describe('AskUserQuestion', () => {
  test('answered → updatedInput.answers keyed by question text, multi-select comma-joined, input kept', async () => {
    const { registry, canUseTool, settled } = setup();
    const result = call(canUseTool, 'AskUserQuestion', questionInput);
    const id = await pendingId(registry);
    const prompt = registry.get(id)?.prompt;
    expect(prompt?.kind).toBe('question');
    if (prompt?.kind === 'question') {
      expect(prompt.questions[0]?.options[1]).toEqual({ label: 'Mongo' });
      expect(prompt.questions[1]?.multiSelect).toBe(true);
    }
    expect(submitAnswers(registry, id, { 0: ['Postgres'], 1: ['Auth', 'Search'] })).toEqual({ ok: true });
    expect(await result).toEqual({
      behavior: 'allow',
      updatedInput: { ...questionInput, answers: { 'Which DB?': 'Postgres', 'Which features?': 'Auth, Search' } },
    });
    expect(registry.entries()).toHaveLength(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.outcome.kind).toBe('answered');
    expect(settled[0]?.message).toEqual(REF);
  });

  test('Other free text overrides selection; empty text clears it', async () => {
    const { registry, canUseTool } = setup();
    const result = call(canUseTool, 'AskUserQuestion', questionInput);
    const id = await pendingId(registry);
    expect(setOtherAnswer(registry, id, 0, '  SQLite  ')).toBe(true);
    expect(setOtherAnswer(registry, id, 1, 'temp')).toBe(true);
    expect(setOtherAnswer(registry, id, 1, '   ')).toBe(true);
    expect(setOtherAnswer(registry, id, 5, 'x')).toBe(false);
    expect(submitAnswers(registry, id, { 0: ['Postgres'], 1: ['Billing'] })).toEqual({ ok: true });
    const res = await result;
    expect(res?.behavior).toBe('allow');
    if (res?.behavior === 'allow') expect(res.updatedInput?.answers).toEqual({ 'Which DB?': 'SQLite', 'Which features?': 'Billing' });
  });

  test('missing answers → ok:false and still pending', async () => {
    const { registry, canUseTool } = setup();
    const result = call(canUseTool, 'AskUserQuestion', questionInput);
    const id = await pendingId(registry);
    expect(submitAnswers(registry, id, { 0: ['Mongo'], 1: [] })).toEqual({ ok: false, missing: ['Which features?'] });
    expect(registry.get(id)).toBeDefined();
    expect(submitAnswers(registry, 'nope', {})).toEqual({ ok: false, missing: [] });
    expect(approve(registry, id)).toBe(false);
    expect(submitAnswers(registry, id, { 0: ['Mongo'], 1: ['Auth'] })).toEqual({ ok: true });
    await result;
  });
});

describe('tool approval', () => {
  const input = { command: 'ls -la' };

  test('approve → allow with original input', async () => {
    const { registry, canUseTool } = setup();
    const result = call(canUseTool, 'Bash', input, { title: 'Claude wants to run ls', decisionReason: 'why', blockedPath: '/etc' });
    const id = await pendingId(registry);
    const prompt = registry.get(id)?.prompt;
    expect(prompt).toMatchObject({ kind: 'approval', runId: RUN, toolName: 'Bash', input, title: 'Claude wants to run ls', decisionReason: 'why', blockedPath: '/etc', showAlwaysAllow: false });
    expect(submitAnswers(registry, id, {})).toEqual({ ok: false, missing: [] });
    expect(approve(registry, id)).toBe(true);
    expect(approve(registry, id)).toBe(false);
    expect(await result).toEqual({ behavior: 'allow', updatedInput: input });
  });

  test('always allow → updatedPermissions with destinations rewritten to session', async () => {
    const { registry, canUseTool } = setup();
    const result = call(canUseTool, 'Bash', input, { suggestions });
    const id = await pendingId(registry);
    expect(registry.get(id)?.prompt).toMatchObject({ showAlwaysAllow: true });
    expect(alwaysAllow(registry, id)).toBe(true);
    const res = await result;
    expect(res).toEqual({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: suggestions.map((s) => ({ ...s, destination: 'session' })),
    });
    if (res?.behavior === 'allow') expect(res.updatedPermissions?.every((p) => p.destination === 'session')).toBe(true);
  });

  test.each([
    ['undefined suggestions', {}],
    ['empty suggestions', { suggestions: [] }],
    ['suppressAlwaysAllowRule', { suggestions, suppressAlwaysAllowRule: true }],
  ] as [string, Opts][])('showAlwaysAllow false on %s', async (_name, opts) => {
    const { registry, canUseTool } = setup();
    const result = call(canUseTool, 'Bash', input, opts);
    const id = await pendingId(registry);
    expect(registry.get(id)?.prompt).toMatchObject({ showAlwaysAllow: false });
    expect(alwaysAllow(registry, id)).toBe(false);
    expect(registry.get(id)).toBeDefined();
    deny(registry, id);
    await result;
  });

  test('deny → default message', async () => {
    const { registry, canUseTool } = setup();
    const result = call(canUseTool, 'Bash', input);
    const id = await pendingId(registry);
    expect(deny(registry, id, '   ')).toBe(true);
    expect(await result).toEqual({ behavior: 'deny', message: 'Denied by user' });
  });

  test('deny with note', async () => {
    const { registry, canUseTool } = setup();
    const result = call(canUseTool, 'Bash', input);
    const id = await pendingId(registry);
    expect(deny(registry, id, '  use rg instead  ')).toBe(true);
    expect(await result).toEqual({ behavior: 'deny', message: 'use rg instead' });
  });
});

describe('cancellation and lifecycle', () => {
  test('rejectRun (Stop) → deny + interrupt, settle cancelled', async () => {
    const { registry, canUseTool, settled } = setup();
    const result = call(canUseTool, 'Bash', { command: 'x' });
    await pendingId(registry);
    registry.rejectRun('other-run', 'stopped');
    expect(registry.countForRun(RUN)).toBe(1);
    registry.rejectRun(RUN, 'stopped');
    expect(await result).toEqual({ behavior: 'deny', message: 'Cancelled: stopped', interrupt: true });
    expect(registry.entries()).toHaveLength(0);
    expect(settled.map((s) => s.outcome)).toEqual([{ kind: 'cancelled', reason: 'stopped' }]);
  });

  test('signal abort while waiting → deny + interrupt', async () => {
    const { registry, canUseTool } = setup();
    const ac = new AbortController();
    const result = call(canUseTool, 'AskUserQuestion', questionInput, { signal: ac.signal });
    await pendingId(registry);
    ac.abort();
    expect(await result).toEqual({ behavior: 'deny', message: 'Cancelled: aborted', interrupt: true });
    expect(registry.entries()).toHaveLength(0);
  });

  test('already aborted signal → deny + interrupt', async () => {
    const { registry, canUseTool, settled } = setup();
    const ac = new AbortController();
    ac.abort();
    expect(await call(canUseTool, 'Bash', {}, { signal: ac.signal })).toEqual({ behavior: 'deny', message: 'Cancelled: aborted', interrupt: true });
    expect(registry.entries()).toHaveLength(0);
    expect(settled).toHaveLength(1);
  });

  test('settle called once per prompt; onWaitingChange counts 1 then 0', async () => {
    const { registry, canUseTool, settled, waiting } = setup();
    const result = call(canUseTool, 'Bash', {});
    const id = await pendingId(registry);
    expect(waiting).toEqual([1]);
    approve(registry, id);
    registry.reject(id, 'late');
    await result;
    expect(waiting).toEqual([1, 0]);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.outcome).toEqual({ kind: 'approved' });
    expect(settled[0]?.prompt.id).toBe(id);
  });

  test('settle errors are swallowed', async () => {
    const registry = new PendingRegistry();
    const canUseTool = createCanUseTool({
      runId: RUN,
      registry,
      post: async () => REF,
      settle: async () => {
        throw new Error('boom');
      },
      onWaitingChange: () => {},
    });
    const result = call(canUseTool, 'Bash', {});
    approve(registry, await pendingId(registry));
    expect(await result).toEqual({ behavior: 'allow', updatedInput: {} });
  });

  test('post failure → deny and registry empty', async () => {
    const { registry, canUseTool, settled, waiting } = setup(async () => {
      throw new Error('slack down');
    });
    const res = await call(canUseTool, 'Bash', {});
    expect(res?.behavior).toBe('deny');
    expect(registry.entries()).toHaveLength(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.message).toBeUndefined();
    expect(waiting).toEqual([1, 0]);
  });

  test('prompt ids are unique and short', async () => {
    const { registry, canUseTool } = setup();
    const results = [call(canUseTool, 'Bash', {}), call(canUseTool, 'Bash', {})];
    await pendingId(registry);
    while (registry.entries().length < 2) await Bun.sleep(0);
    const ids = registry.entries().map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(12);
    expect(registry.get(ids[0]!)?.message).toEqual(REF);
    registry.rejectRun(RUN, 'done');
    await Promise.all(results);
  });
});
