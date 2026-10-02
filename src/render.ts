import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ActionsBlock, Button, ContextBlock, KnownBlock, PlainTextOption, SectionBlock, View } from '@slack/types';
import { isDirectChannel } from './channels.ts';
import {
  ACTION,
  RECENT_RUNS,
  isRecord,
  otherActionValue,
  questionBlockId,
  resultOutcome,
  type ApprovalPrompt,
  type ProgressEntry,
  type Prompt,
  type PromptOutcome,
  type QuestionPrompt,
  type RunRecord,
  type RunSnapshot,
  type RunStatus,
} from './types.ts';

export const MARKDOWN_LIMIT = 12_000;
const SECTION_LIMIT = 3000;
const CONTEXT_LIMIT = 2000;
const MAX_ACTIVE_HOME = 50;

const escapeMrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Keeps the tail, where a path's file name lives, and snaps the cut to a directory boundary. */
function truncateStart(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = s.slice(-(max - 1));
  const slash = tail.indexOf('/');
  return '…' + (slash >= 0 && slash < tail.length - 1 ? tail.slice(slash) : tail);
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function codeBlock(s: string, max: number): string {
  // Triple backticks inside would terminate the Slack code block early.
  const safe = escapeMrkdwn(truncate(s, max)).replace(/```/g, '`​``');
  return '```\n' + safe + '\n```';
}

function inlineCode(s: string, max: number, path = false): string {
  const flat = oneLine(s).replace(/`/g, "'");
  return '`' + escapeMrkdwn(path ? truncateStart(flat, max) : truncate(flat, max)) + '`';
}

const section = (text: string, extra: Partial<SectionBlock> = {}): SectionBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text: truncate(text, SECTION_LIMIT) },
  ...extra,
});

const context = (text: string): ContextBlock => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text: truncate(text, CONTEXT_LIMIT) }],
});

const button = (text: string, actionId: string, value: string, style?: 'primary' | 'danger'): Button => ({
  type: 'button',
  text: { type: 'plain_text', text: truncate(text, 75), emoji: true },
  action_id: actionId,
  value,
  ...(style ? { style } : {}),
});

function contentBlocks(msg: { message: unknown }): Record<string, unknown>[] {
  const content = isRecord(msg.message) ? msg.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

const ARG_KEYS = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description'] as const;
const PATH_KEYS = new Set<string>(['file_path', 'notebook_path']);

/** The status header already shows the cwd, so repeating it in every arg only pushes the useful part out. */
function relativize(s: string, cwd: string): string {
  const root = cwd.replace(/\/+$/, '');
  if (!root) return s;
  return s.split(root + '/').join('./');
}

function toolEntry(block: Record<string, unknown>, nested: boolean, cwd: string): ProgressEntry {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = isRecord(block.input) ? block.input : {};
  const key = ARG_KEYS.find((k) => typeof input[k] === 'string' && input[k] !== '');
  const head = `${nested ? '↳ ' : ''}*${escapeMrkdwn(name)}*`;
  if (!key) return { head, args: [], count: 1 };
  const path = PATH_KEYS.has(key);
  const arg = relativize(oneLine(input[key] as string), cwd);
  return { head, args: [path ? arg.replace(/^\.\//, '') : arg], count: 1, ...(path ? { path } : {}) };
}

export function progressText(e: ProgressEntry): string {
  if (e.count === 1) return e.args.length ? `${e.head} ${inlineCode(e.args[0]!, 80, e.path)}` : e.head;
  const args = e.args.map((a) => inlineCode(a, 40, e.path)).join(', ');
  const more = e.count > e.args.length && e.args.length > 0 ? '… ' : '';
  return `${e.head} ×${e.count}${args ? ` ${more}${args}` : ''}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .join(' ');
  }
  return '';
}

export function progressLine(msg: SDKMessage, cwd: string): ProgressEntry[] {
  if (msg.type === 'assistant') {
    const nested = msg.parent_tool_use_id !== null;
    return contentBlocks(msg)
      .filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use')
      .map((b) => toolEntry(b, nested, cwd));
  }
  if (msg.type === 'user') {
    return contentBlocks(msg)
      .filter((b) => b.type === 'tool_result' && b.is_error === true)
      .map((b) => ({ head: '❗ ' + escapeMrkdwn(truncate(oneLine(toolResultText(b.content)) || 'tool error', 150)), args: [], count: 1 }));
  }
  return [];
}

export function assistantText(msg: SDKMessage): string | undefined {
  if (msg.type !== 'assistant' || msg.parent_tool_use_id !== null) return undefined;
  const text = contentBlocks(msg)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
  return text || undefined;
}

/** `<#D…>` renders as an unknown channel, so direct message channels get a plain label. */
export const channelLabel = (channelId: string) => (isDirectChannel(channelId) ? 'Direct' : `<#${channelId}>`);

export function threadLink(teamUrl: string, channelId: string, threadTs: string): string {
  return `${teamUrl.replace(/\/$/, '')}/archives/${channelId}/p${threadTs.replace('.', '')}`;
}

/** Returns `' <url|label>'`, or `''` when the team URL is unknown. */
export function threadLinkMrkdwn(teamUrl: string | undefined, channelId: string, threadTs: string, label: string): string {
  return teamUrl ? ` <${threadLink(teamUrl, channelId, threadTs)}|${label}>` : '';
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${pad(total % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '—';
  return `$${usd.toFixed(2)}`;
}

function stateLine(run: RunSnapshot): string {
  switch (run.status) {
    case 'running':
      if (run.phase === 'stopping') return '⏹ Stopping…';
      if (run.phase === 'waiting') return '✋ Waiting for approval';
      return '⏳ Running';
    case 'done':
      return '✅ Done';
    case 'error':
      return `❌ Error: ${escapeMrkdwn(truncate(oneLine(run.error ?? 'unknown error'), 500))}`;
    case 'stopped':
      return '⏹ Stopped';
    case 'shutdown':
      return '🛑 Bot shutdown';
  }
}

export const elapsedOf = (run: Pick<RunSnapshot, 'startedAt' | 'endedAt'>, now: number) => (run.endedAt ?? now) - run.startedAt;

const canStop = (run: RunSnapshot) => run.status === 'running' && run.phase !== 'stopping';

export function statusBlocks(run: RunSnapshot, opts: { now: number }): { text: string; blocks: KnownBlock[] } {
  const state = stateLine(run);
  const elapsed = formatDuration(elapsedOf(run, opts.now));
  const meta = [`\`${escapeMrkdwn(run.cwd)}\``, elapsed, `${run.turns} ${run.turns === 1 ? 'turn' : 'turns'}`];
  if (run.costUsd != null) meta.push(`~${formatCost(run.costUsd)}`);
  const blocks: KnownBlock[] = [section(`*${state}*`), context(meta.join(' · '))];

  const lines = run.progress.map((e) => truncate(progressText(e), 280));
  if (lines.length > 0) blocks.push(section(lines.join('\n')));
  // Once the run ends the result message carries the text, so a preview here would duplicate it.
  if (run.lastText && run.status === 'running') blocks.push(section('💬 ' + escapeMrkdwn(truncate(run.lastText.trim(), 300))));

  if (canStop(run)) {
    blocks.push({ type: 'actions', block_id: 'run_actions', elements: [button('Stop', ACTION.stop, run.id, 'danger')] });
  }
  return { text: truncate(`${state} · ${elapsed}`, 300), blocks };
}

/** Replaces the status message of a run whose process died with the bot, so it no longer shows a live state and a Stop button. */
export function interruptedBlocks(): { text: string; blocks: KnownBlock[] } {
  const state = '🛑 Interrupted: the bot stopped unexpectedly';
  return { text: state, blocks: [section(`*${state}*`), context('Reply in this thread to continue the session.')] };
}

function questionHeading(q: { header: string; question: string }): string {
  return `*${escapeMrkdwn(truncate(q.header, 100))}*\n${escapeMrkdwn(truncate(q.question, 2500))}`;
}

function outcomeLine(outcome: PromptOutcome): string {
  switch (outcome.kind) {
    case 'answered':
      return '✅ Answered';
    case 'approved':
      return '✅ Approved';
    case 'always':
      return '✅ Always allowed (session)';
    case 'denied':
      return `🚫 Denied: ${escapeMrkdwn(truncate(outcome.message, 1500))}`;
    case 'cancelled':
      return `⏹ Cancelled: ${escapeMrkdwn(truncate(outcome.reason, 1500))}`;
  }
}

export function questionBlocks(prompt: QuestionPrompt, outcome?: PromptOutcome): { text: string; blocks: KnownBlock[] } {
  const blocks: KnownBlock[] = [];
  const first = prompt.questions[0];
  const text = truncate(`❓ ${first ? first.question : 'Question'}`, 300);

  prompt.questions.forEach((q, i) => {
    blocks.push(section(questionHeading(q)));
    if (outcome) {
      if (outcome.kind === 'answered') {
        const answer = outcome.answers[q.question];
        blocks.push(context(`→ ${answer ? escapeMrkdwn(truncate(answer, 1500)) : '_(no answer)_'}`));
      }
      return;
    }
    const options: PlainTextOption[] = q.options.slice(0, 10).map((o, idx) => ({
      text: { type: 'plain_text', text: truncate(o.label, 75), emoji: true },
      value: String(idx),
      ...(o.description ? { description: { type: 'plain_text', text: truncate(o.description, 75), emoji: true } } : {}),
    }));
    const input: ActionsBlock['elements'][number] = q.multiSelect
      ? { type: 'checkboxes', action_id: ACTION.questionSelect, options }
      : { type: 'radio_buttons', action_id: ACTION.questionSelect, options };
    blocks.push({
      type: 'actions',
      block_id: questionBlockId(i),
      elements: [input, button('Other…', ACTION.questionOther, otherActionValue(prompt.id, i))],
    });
    const other = prompt.other[q.question];
    if (other) blocks.push(context(`Other: ${escapeMrkdwn(truncate(other, 1500))}`));
  });

  if (outcome) {
    blocks.push(context(outcomeLine(outcome)));
  } else {
    blocks.push({
      type: 'actions',
      block_id: 'q_submit',
      elements: [button('Submit', ACTION.questionSubmit, prompt.id, 'primary')],
    });
  }
  return { text, blocks };
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit']);

function formatInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') return codeBlock(input.command, 2500);
  if (FILE_TOOLS.has(toolName)) {
    const path = input.file_path ?? input.notebook_path;
    if (typeof path === 'string') return inlineCode(path, 500);
  }
  let json: string;
  try {
    json = JSON.stringify(input, null, 2) ?? '';
  } catch {
    json = String(input);
  }
  return codeBlock(json, 2500);
}

export function approvalBlocks(prompt: ApprovalPrompt, outcome?: PromptOutcome): { text: string; blocks: KnownBlock[] } {
  const title = prompt.title || prompt.toolName;
  const blocks: KnownBlock[] = [section(`🔐 *${escapeMrkdwn(truncate(title, 300))}*`)];
  if (prompt.title) blocks.push(context(`Tool: \`${escapeMrkdwn(prompt.toolName)}\``));
  blocks.push(section(formatInput(prompt.toolName, prompt.input)));

  const notes: string[] = [];
  if (prompt.decisionReason) notes.push(`Reason: ${escapeMrkdwn(truncate(prompt.decisionReason, 800))}`);
  if (prompt.blockedPath) notes.push(`Blocked path: ${inlineCode(prompt.blockedPath, 500)}`);
  if (notes.length > 0) blocks.push(context(notes.join('\n')));

  if (outcome) {
    blocks.push(section(outcomeLine(outcome)));
  } else {
    const elements: Button[] = [button('Approve', ACTION.approve, prompt.id, 'primary')];
    if (prompt.showAlwaysAllow) elements.push(button('Always allow (session)', ACTION.always, prompt.id));
    elements.push(button('Deny', ACTION.deny, prompt.id, 'danger'), button('Deny + note…', ACTION.denyNote, prompt.id));
    blocks.push({ type: 'actions', block_id: 'perm_actions', elements });
  }
  return { text: truncate(`🔐 Permission request: ${title}`, 300), blocks };
}

export function promptBlocks(prompt: Prompt, outcome?: PromptOutcome): { text: string; blocks: KnownBlock[] } {
  return prompt.kind === 'question' ? questionBlocks(prompt, outcome) : approvalBlocks(prompt, outcome);
}

export type ResultPayload =
  | { kind: 'blocks'; text: string; blocks: KnownBlock[] }
  | { kind: 'file'; filename: 'result.md'; content: string; text: string; blocks: KnownBlock[] };

export function resultPayload(
  text: string,
  meta: { turns: number; durationMs: number; costUsd?: number; isError?: boolean },
): ResultPayload {
  const body = (meta.isError ? '❌ ' : '') + (text.trim() ? text : '_(no text output)_');
  const parts = [`${meta.turns} ${meta.turns === 1 ? 'turn' : 'turns'}`, formatDuration(meta.durationMs)];
  if (meta.costUsd != null) parts.push(`~${formatCost(meta.costUsd)} (estimated)`);
  const ctx = context(parts.join(' · '));
  const fallback = truncate(body, 300);

  if (body.length <= MARKDOWN_LIMIT) {
    return { kind: 'blocks', text: fallback, blocks: [{ type: 'markdown', text: body }, ctx] };
  }
  const summary = `${escapeMrkdwn(truncate(body, 500))}\n\n_Full result attached as \`result.md\`._`;
  return { kind: 'file', filename: 'result.md', content: text, text: fallback, blocks: [section(summary), ctx] };
}

export function resultFromMessage(result: SDKResultMessage): {
  text: string;
  meta: { turns: number; durationMs: number; costUsd: number; isError: boolean };
} {
  const { text, isError } = resultOutcome(result);
  return { text, meta: { turns: result.num_turns, durationMs: result.duration_ms, costUsd: result.total_cost_usd, isError } };
}

const STATUS_EMOJI: Record<RunStatus, string> = {
  running: '⏳',
  done: '✅',
  error: '❌',
  stopped: '⏹',
  shutdown: '🛑',
};

function snippet(prompt: string): string {
  return escapeMrkdwn(truncate(oneLine(prompt), 80)) || '_(empty prompt)_';
}

export function homeView(active: RunSnapshot[], recent: RunRecord[], opts: { now: number; teamUrl?: string }): View {
  const link = (channelId: string, threadTs: string) => (opts.teamUrl ? ` ·${threadLinkMrkdwn(opts.teamUrl, channelId, threadTs, 'thread')}` : '');
  const blocks: KnownBlock[] = [{ type: 'header', text: { type: 'plain_text', text: 'Active runs', emoji: true } }];

  if (active.length === 0) blocks.push(context('No active runs'));
  for (const run of active.slice(0, MAX_ACTIVE_HOME)) {
    const text = `${channelLabel(run.channelId)} · ${stateLine(run)} · ${formatDuration(elapsedOf(run, opts.now))}${link(run.channelId, run.threadTs)}\n${snippet(run.prompt)}`;
    blocks.push(section(text, canStop(run) ? { accessory: button('Stop', ACTION.stop, run.id, 'danger') } : {}));
  }
  if (active.length > MAX_ACTIVE_HOME) blocks.push(context(`…and ${active.length - MAX_ACTIVE_HOME} more`));

  blocks.push({ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: 'Recent runs', emoji: true } });
  if (recent.length === 0) blocks.push(context('No recent runs'));
  for (const r of recent.slice(0, RECENT_RUNS)) {
    const duration = r.durationMs ?? (r.endedAt != null ? r.endedAt - r.startedAt : null);
    const text = `${STATUS_EMOJI[r.status]} ${channelLabel(r.channelId)} · ${duration != null ? formatDuration(duration) : '—'} · ${formatCost(r.costUsd)}${link(r.channelId, r.threadTs)}\n${snippet(r.prompt)}`;
    blocks.push(section(text));
  }
  return { type: 'home', blocks };
}
