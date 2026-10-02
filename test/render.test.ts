import { describe, expect, test } from 'vitest';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AnyBlock, KnownBlock } from '@slack/types';
import {
  approvalBlocks,
  assistantText,
  formatCost,
  formatDuration,
  homeView,
  interruptedBlocks,
  MARKDOWN_LIMIT,
  progressLine,
  promptBlocks,
  questionBlocks,
  resultFromMessage,
  resultPayload,
  statusBlocks,
  threadLink,
} from '../src/render.ts';
import { ACTION, questionBlockId, type ApprovalPrompt, type QuestionPrompt, type RunRecord, type RunSnapshot } from '../src/types.ts';

const assistant = (content: unknown[], parent: string | null = null) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content } }) as unknown as SDKMessage;
const user = (content: unknown[]) =>
  ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content } }) as unknown as SDKMessage;
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: 't1', name, input });

const json = (v: unknown) => JSON.stringify(v);
const find = (blocks: AnyBlock[], pred: (b: any) => boolean): any => blocks.find(pred);
const actionIds = (blocks: KnownBlock[]) =>
  blocks.flatMap((b) => (b.type === 'actions' ? b.elements.map((e) => ('action_id' in e ? e.action_id : undefined)) : []));

function run(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: 'run-1',
    channelId: 'C1',
    threadTs: '1700000000.123456',
    cwd: '/work/proj',
    prompt: 'fix the <bug> & ship',
    startedAt: 1_000,
    status: 'running',
    phase: 'running',
    turns: 3,
    progress: [],
    ...over,
  };
}

describe('progressLine', () => {
  test('Bash shows command', () => {
    const [line] = progressLine(assistant([toolUse('Bash', { command: 'ls -la\n| grep <x>' })]));
    expect(line).toBe('*Bash* `ls -la | grep &lt;x&gt;`');
  });
  test('Read shows file_path', () => {
    expect(progressLine(assistant([toolUse('Read', { file_path: '/a/b.ts' })]))).toEqual(['*Read* `/a/b.ts`']);
  });
  test('Edit shows file_path', () => {
    expect(progressLine(assistant([toolUse('Edit', { file_path: '/a/c.ts', old_string: 'x' })]))[0]).toContain('`/a/c.ts`');
  });
  test('Grep shows pattern', () => {
    expect(progressLine(assistant([toolUse('Grep', { pattern: 'foo.*bar' })]))[0]).toBe('*Grep* `foo.*bar`');
  });
  test('unknown tool has no arg', () => {
    expect(progressLine(assistant([toolUse('Mystery', { x: 1 })]))).toEqual(['*Mystery*']);
  });
  test('long arg truncated to one line', () => {
    const [line] = progressLine(assistant([toolUse('Bash', { command: 'x'.repeat(500) })]));
    expect(line!.length).toBeLessThan(110);
    expect(line).toContain('…');
  });
  test('one line per tool_use, text ignored, subagent marked', () => {
    const lines = progressLine(
      assistant([{ type: 'text', text: 'hi' }, toolUse('Read', { file_path: '/a' }), toolUse('Glob', { pattern: '*.ts' })], 'parent'),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('↳ ')).toBe(true);
  });
  test('tool_result error → ❗ line', () => {
    const lines = progressLine(user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom\nfailed' }]));
    expect(lines).toEqual(['❗ boom failed']);
    const arr = progressLine(user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'bad' }] }]));
    expect(arr).toEqual(['❗ bad']);
  });
  test('non-error tool_result ignored', () => {
    expect(progressLine(user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]))).toEqual([]);
  });
  test('other messages ignored', () => {
    expect(progressLine({ type: 'system', subtype: 'init' } as unknown as SDKMessage)).toEqual([]);
  });
});

describe('assistantText', () => {
  test('joins top-level text blocks', () => {
    expect(assistantText(assistant([{ type: 'text', text: 'a' }, toolUse('Bash', {}), { type: 'text', text: 'b' }]))).toBe('a\nb');
  });
  test('subagent and non-text → undefined', () => {
    expect(assistantText(assistant([{ type: 'text', text: 'a' }], 'p'))).toBeUndefined();
    expect(assistantText(assistant([toolUse('Bash', {})]))).toBeUndefined();
    expect(assistantText(user([{ type: 'text', text: 'a' }]))).toBeUndefined();
  });
});

describe('formatting helpers', () => {
  test('threadLink', () => {
    expect(threadLink('https://x.slack.com/', 'C1', '1700000000.123456')).toBe('https://x.slack.com/archives/C1/p1700000000123456');
  });
  test('formatDuration', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });
  test('formatCost', () => {
    expect(formatCost(0.4213)).toBe('$0.42');
    expect(formatCost(undefined)).toBe('—');
    expect(formatCost(null)).toBe('—');
  });
});

describe('interruptedBlocks', () => {
  test('shows the interrupted state without a Stop button', () => {
    const { text, blocks } = interruptedBlocks();
    expect(text).toContain('Interrupted');
    expect(actionIds(blocks)).toEqual([]);
  });
});

describe('statusBlocks', () => {
  test('running has Stop button with run id', () => {
    const { blocks, text } = statusBlocks(run({ progress: ['*Bash* `ls`'], lastText: 'hello <world>' }), { now: 46_000 });
    expect(text).toContain('⏳ Running');
    const stop = find(blocks, (b) => b.type === 'actions').elements[0];
    expect(stop).toMatchObject({ action_id: ACTION.stop, value: 'run-1', style: 'danger' });
    expect(json(blocks)).toContain('45s');
    expect(json(blocks)).toContain('💬 hello &lt;world&gt;');
    expect(json(blocks)).toContain('/work/proj');
  });
  test('waiting phase shows approval state', () => {
    expect(statusBlocks(run({ phase: 'waiting' }), { now: 2_000 }).text).toContain('✋ Waiting for approval');
  });
  test('done and stopping have no Stop', () => {
    const done = statusBlocks(run({ status: 'done', endedAt: 61_000, lastText: 'final answer' }), { now: 999_999 });
    expect(actionIds(done.blocks)).toEqual([]);
    expect(json(done.blocks)).not.toContain('final answer');
    expect(done.text).toContain('✅ Done');
    expect(json(done.blocks)).toContain('1m 00s');
    const stopping = statusBlocks(run({ phase: 'stopping' }), { now: 2_000 });
    expect(actionIds(stopping.blocks)).toEqual([]);
    expect(stopping.text).toContain('Stopping');
  });
  test('error shows message; only last 10 progress lines; within limits', () => {
    const progress = Array.from({ length: 15 }, (_, i) => `line-${i}-${'y'.repeat(400)}`);
    const { blocks, text } = statusBlocks(run({ status: 'error', error: 'kaput', progress }), { now: 2_000 });
    expect(text).toContain('❌ Error: kaput');
    expect(json(blocks)).not.toContain('line-4-');
    expect(json(blocks)).toContain('line-5-');
    for (const b of blocks) if (b.type === 'section') expect(b.text!.text.length).toBeLessThanOrEqual(3000);
  });
});

const qPrompt = (over: Partial<QuestionPrompt> = {}): QuestionPrompt => ({
  kind: 'question',
  id: 'p1',
  runId: 'run-1',
  questions: [
    { question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'relational' }, { label: 'Mongo' }] },
    { question: 'Which features?', header: 'Feat', multiSelect: true, options: [{ label: 'A' }, { label: 'B'.repeat(100), description: 'd'.repeat(100) }] },
  ],
  other: {},
  ...over,
});

describe('questionBlocks', () => {
  test('single → radio_buttons, multi → checkboxes with conventions', () => {
    const { blocks } = questionBlocks(qPrompt());
    const q0 = find(blocks, (b) => b.block_id === questionBlockId(0));
    const q1 = find(blocks, (b) => b.block_id === questionBlockId(1));
    expect(q0.type).toBe('actions');
    expect(q0.elements[0]).toMatchObject({ type: 'radio_buttons', action_id: ACTION.questionSelect });
    expect(q0.elements[0].options.map((o: { value: string }) => o.value)).toEqual(['0', '1']);
    expect(q0.elements[0].options[0].text.text).toBe('Postgres');
    expect(q0.elements[0].options[0].description.text).toBe('relational');
    expect(q0.elements[1]).toMatchObject({ action_id: ACTION.questionOther, value: 'p1:0' });
    expect(q1.elements[0].type).toBe('checkboxes');
    expect(q1.elements[0].options[1].text.text.length).toBeLessThanOrEqual(75);
    expect(q1.elements[0].options[1].description.text.length).toBeLessThanOrEqual(75);
    expect(q1.elements[1].value).toBe('p1:1');
    const submit = find(blocks, (b) => b.type === 'actions' && b.elements[0].action_id === ACTION.questionSubmit).elements[0];
    expect(submit).toMatchObject({ value: 'p1', style: 'primary' });
    const ids = blocks.map((b) => b.block_id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(json(blocks)).toContain('Which DB?');
  });
  test('Other text displayed', () => {
    const { blocks } = questionBlocks(qPrompt({ other: { 'Which DB?': 'SQLite <3' } }));
    expect(json(blocks)).toContain('Other: SQLite &lt;3');
  });
  test('outcome removes inputs and shows answers', () => {
    const { blocks } = questionBlocks(qPrompt(), { kind: 'answered', answers: { 'Which DB?': 'Postgres', 'Which features?': 'A, B' } });
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(json(blocks)).toContain('Postgres');
    expect(json(blocks)).toContain('A, B');
    const cancelled = questionBlocks(qPrompt(), { kind: 'cancelled', reason: 'run stopped' });
    expect(cancelled.blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(json(cancelled.blocks)).toContain('⏹ Cancelled: run stopped');
  });
});

const aPrompt = (over: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  kind: 'approval',
  id: 'p2',
  runId: 'run-1',
  toolName: 'Bash',
  input: { command: 'rm -rf <dir>' },
  showAlwaysAllow: true,
  ...over,
});

describe('approvalBlocks', () => {
  test('buttons with Always allow', () => {
    const { blocks } = approvalBlocks(aPrompt({ decisionReason: 'ask rule', blockedPath: '/etc' }));
    expect(actionIds(blocks)).toEqual([ACTION.approve, ACTION.always, ACTION.deny, ACTION.denyNote]);
    const els = find(blocks, (b) => b.type === 'actions').elements;
    expect(els.every((e: { value: string }) => e.value === 'p2')).toBe(true);
    expect(els[0].style).toBe('primary');
    expect(els[2].style).toBe('danger');
    const s = json(blocks);
    expect(s).toContain('```\\nrm -rf &lt;dir&gt;\\n```');
    expect(s).toContain('ask rule');
    expect(s).toContain('/etc');
  });
  test('without Always allow; title and file path', () => {
    const { blocks, text } = approvalBlocks(aPrompt({ toolName: 'Write', title: 'Write file?', input: { file_path: '/x.ts', content: 'secret' }, showAlwaysAllow: false }));
    expect(actionIds(blocks)).toEqual([ACTION.approve, ACTION.deny, ACTION.denyNote]);
    expect(text).toContain('Write file?');
    expect(json(blocks)).toContain('/x.ts');
    expect(json(blocks)).not.toContain('secret');
  });
  test('other tools → truncated JSON', () => {
    const { blocks } = approvalBlocks(aPrompt({ toolName: 'mcp__x', input: { data: 'z'.repeat(5000) } }));
    for (const b of blocks) if (b.type === 'section') expect(b.text!.text.length).toBeLessThanOrEqual(3000);
    expect(json(blocks)).toContain('\\"data\\": \\"zzz');
    expect(json(blocks)).toContain('…');
  });
  test('outcome removes buttons', () => {
    expect(actionIds(approvalBlocks(aPrompt(), { kind: 'approved' }).blocks)).toEqual([]);
    expect(json(approvalBlocks(aPrompt(), { kind: 'always' }).blocks)).toContain('Always allowed (session)');
    expect(json(approvalBlocks(aPrompt(), { kind: 'denied', message: 'nope' }).blocks)).toContain('🚫 Denied: nope');
  });
  test('promptBlocks dispatches', () => {
    expect(promptBlocks(aPrompt()).text).toContain('Permission');
    expect(actionIds(promptBlocks(qPrompt()).blocks)).toContain(ACTION.questionSubmit);
  });
});

describe('resultPayload', () => {
  const meta = { turns: 4, durationMs: 185_000, costUsd: 0.42 };
  test('under and at limit → markdown block + context', () => {
    for (const len of [10, MARKDOWN_LIMIT]) {
      const p = resultPayload('a'.repeat(len), meta);
      expect(p.kind).toBe('blocks');
      expect(p.blocks[0]).toEqual({ type: 'markdown', text: 'a'.repeat(len) });
      expect(json(p.blocks[1])).toContain('4 turns · 3m 05s · ~$0.42');
    }
  });
  test('over limit → file', () => {
    const text = 'b'.repeat(MARKDOWN_LIMIT + 1);
    const p = resultPayload(text, meta);
    expect(p.kind).toBe('file');
    if (p.kind !== 'file') return;
    expect(p.filename).toBe('result.md');
    expect(p.content).toBe(text);
    expect(json(p.blocks)).toContain('result.md');
    expect(p.blocks[0]!.type).toBe('section');
  });
  test('error prefix and empty text', () => {
    expect(resultPayload('bad', { ...meta, isError: true }).blocks[0]).toEqual({ type: 'markdown', text: '❌ bad' });
    expect(resultPayload('', meta).blocks[0]).toEqual({ type: 'markdown', text: '_(no text output)_' });
  });
});

describe('resultFromMessage', () => {
  const base = { type: 'result', duration_ms: 5000, duration_api_ms: 1, num_turns: 2, total_cost_usd: 0.1, is_error: false };
  test('success', () => {
    const r = resultFromMessage({ ...base, subtype: 'success', result: 'done!' } as unknown as SDKResultMessage);
    expect(r).toEqual({ text: 'done!', meta: { turns: 2, durationMs: 5000, costUsd: 0.1, isError: false } });
  });
  test('error subtype', () => {
    const r = resultFromMessage({ ...base, subtype: 'error_during_execution', is_error: true, errors: ['e1', 'e2'] } as unknown as SDKResultMessage);
    expect(r.text).toBe('e1\ne2');
    expect(r.meta.isError).toBe(true);
    const empty = resultFromMessage({ ...base, subtype: 'error_max_turns', errors: [] } as unknown as SDKResultMessage);
    expect(empty.text).toBe('error_max_turns');
    expect(empty.meta.isError).toBe(true);
  });
});

describe('homeView', () => {
  const rec = (i: number): RunRecord => ({
    id: `r${i}`,
    channelId: 'C2',
    threadTs: '1700000001.000100',
    sessionId: null,
    prompt: `prompt ${i}`,
    status: 'done',
    turns: 1,
    costUsd: 0.5,
    durationMs: 65_000,
    startedAt: 0,
    endedAt: 65_000,
    statusTs: null,
    triggerTs: null,
  });
  test('active + recent', () => {
    const view = homeView([run()], Array.from({ length: 30 }, (_, i) => rec(i)), { now: 61_000, teamUrl: 'https://x.slack.com' });
    expect(view.type).toBe('home');
    const s = json(view.blocks);
    expect(s).toContain('Active runs');
    expect(s).toContain('Recent runs');
    expect(s).toContain('<#C1>');
    expect(s).toContain('fix the &lt;bug&gt; &amp; ship');
    expect(s).toContain('https://x.slack.com/archives/C1/p1700000000123456');
    expect(s).toContain('1m 05s');
    expect(s).toContain('$0.50');
    expect(s).toContain('prompt 19');
    expect(s).not.toContain('prompt 20');
    const stop = find(view.blocks, (b) => b.accessory?.action_id === ACTION.stop);
    expect(stop.accessory.value).toBe('run-1');
    expect(view.blocks.length).toBeLessThan(100);
  });
  test('direct message runs are labelled Direct instead of a channel mention', () => {
    const s = json(homeView([run({ channelId: 'D9' })], [{ ...rec(0), channelId: 'D9' }], { now: 0 }).blocks);
    expect(s).not.toContain('<#D9>');
    expect(s.match(/Direct ·/g)).toHaveLength(2);
  });
  test('empty', () => {
    const s = json(homeView([], [], { now: 0 }).blocks);
    expect(s).toContain('No active runs');
    expect(s).not.toContain('archives');
  });
  test('many active runs stay under 100 blocks', () => {
    const active = Array.from({ length: 120 }, (_, i) => run({ id: `a${i}` }));
    const view = homeView(active, Array.from({ length: 20 }, (_, i) => rec(i)), { now: 0 });
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });
});
