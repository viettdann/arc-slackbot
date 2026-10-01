import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ActionsBlock, Button, ContextBlock, KnownBlock, PlainTextOption, SectionBlock, View } from '@slack/types';
import {
  ACTION,
  PROGRESS_LINES,
  RECENT_RUNS,
  isRecord,
  otherActionValue,
  questionBlockId,
  resultOutcome,
  type ApprovalPrompt,
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

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function codeBlock(s: string, max: number): string {
  // Triple backticks inside would terminate the Slack code block early.
  const safe = escapeMrkdwn(truncate(s, max)).replace(/```/g, '`​``');
  return '```\n' + safe + '\n```';
}

function inlineCode(s: string, max: number): string {
  return '`' + escapeMrkdwn(truncate(oneLine(s).replace(/`/g, "'"), max)) + '`';
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

const TOOL_ICONS: Record<string, string> = {
  Bash: '💻',
  BashOutput: '💻',
  KillShell: '💻',
  Read: '📖',
  Edit: '✏️',
  MultiEdit: '✏️',
  Write: '📝',
  NotebookEdit: '📓',
  Grep: '🔍',
  Glob: '🔍',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Task: '🤖',
  Agent: '🤖',
  TodoWrite: '📋',
  AskUserQuestion: '❓',
};

const ARG_KEYS = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description'] as const;

function toolLine(block: Record<string, unknown>, nested: boolean): string {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const icon = TOOL_ICONS[name] ?? (name.startsWith('mcp__') ? '🔌' : '🔧');
  const input = isRecord(block.input) ? block.input : {};
  const key = ARG_KEYS.find((k) => typeof input[k] === 'string' && input[k] !== '');
  const arg = key ? ' ' + inlineCode(input[key] as string, 80) : '';
  return `${nested ? '↳ ' : ''}${icon} *${escapeMrkdwn(name)}*${arg}`;
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

/** Returns pre-escaped mrkdwn lines; statusBlocks renders them verbatim. */
export function progressLine(msg: SDKMessage): string[] {
  if (msg.type === 'assistant') {
    const nested = msg.parent_tool_use_id !== null;
    return contentBlocks(msg)
      .filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use')
      .map((b) => toolLine(b, nested));
  }
  if (msg.type === 'user') {
    return contentBlocks(msg)
      .filter((b) => b.type === 'tool_result' && b.is_error === true)
      .map((b) => '❗ ' + escapeMrkdwn(truncate(oneLine(toolResultText(b.content)) || 'tool error', 150)));
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

  const lines = run.progress.slice(-PROGRESS_LINES).map((l) => truncate(l, 280));
  if (lines.length > 0) blocks.push(section(lines.join('\n')));
  if (run.lastText) blocks.push(section('💬 ' + escapeMrkdwn(truncate(run.lastText.trim(), 300))));

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
    const text = `<#${run.channelId}> · ${stateLine(run)} · ${formatDuration(elapsedOf(run, opts.now))}${link(run.channelId, run.threadTs)}\n${snippet(run.prompt)}`;
    blocks.push(section(text, canStop(run) ? { accessory: button('Stop', ACTION.stop, run.id, 'danger') } : {}));
  }
  if (active.length > MAX_ACTIVE_HOME) blocks.push(context(`…and ${active.length - MAX_ACTIVE_HOME} more`));

  blocks.push({ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: 'Recent runs', emoji: true } });
  if (recent.length === 0) blocks.push(context('No recent runs'));
  for (const r of recent.slice(0, RECENT_RUNS)) {
    const duration = r.durationMs ?? (r.endedAt != null ? r.endedAt - r.startedAt : null);
    const text = `${STATUS_EMOJI[r.status]} <#${r.channelId}> · ${duration != null ? formatDuration(duration) : '—'} · ${formatCost(r.costUsd)}${link(r.channelId, r.threadTs)}\n${snippet(r.prompt)}`;
    blocks.push(section(text));
  }
  return { type: 'home', blocks };
}
