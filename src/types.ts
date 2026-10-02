import type { PermissionMode, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

export const PROGRESS_LINES = 10;
export const RECENT_RUNS = 20;

export interface ChannelConfig {
  cwd: string;
  permissionMode: PermissionMode;
  disallowedTools: string[];
  model?: string;
  /** Stored only when false; top-level messages then start runs without a mention. */
  requireMention?: false;
}

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  allowedUserId: string;
  channelsFile: string;
  dbPath: string;
  /** 0 disables pruning of run history and downloaded attachments. */
  retentionDays: number;
  channels: Record<string, ChannelConfig>;
}

export type RunStatus = 'running' | 'done' | 'error' | 'stopped' | 'shutdown';
export type FinalStatus = Exclude<RunStatus, 'running'>;
export type StopReason = Extract<RunStatus, 'stopped' | 'shutdown'>;

export const isStopStatus = (status: RunStatus): status is StopReason => status === 'stopped' || status === 'shutdown';

/** `waiting` means at least one approval/question prompt is pending. */
export type RunPhase = 'running' | 'waiting' | 'stopping';

export interface RunSnapshot {
  id: string;
  channelId: string;
  threadTs: string;
  cwd: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  phase: RunPhase;
  turns: number;
  costUsd?: number;
  /** Oldest first. */
  progress: string[];
  lastText?: string;
  error?: string;
  sessionId?: string;
}

export interface RunRecord {
  id: string;
  channelId: string;
  threadTs: string;
  sessionId: string | null;
  prompt: string;
  status: RunStatus;
  turns: number | null;
  costUsd: number | null;
  durationMs: number | null;
  startedAt: number;
  endedAt: number | null;
  statusTs: string | null;
  triggerTs: string | null;
}

export interface ThreadRecord {
  channelId: string;
  threadTs: string;
  sessionId: string;
  cwd: string;
  updatedAt: number;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface QuestionPrompt {
  kind: 'question';
  id: string;
  runId: string;
  questions: Question[];
  /** Free text entered through "Other…", keyed by question text. */
  other: Record<string, string>;
}

export interface ApprovalPrompt {
  kind: 'approval';
  id: string;
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  decisionReason?: string;
  blockedPath?: string;
  showAlwaysAllow: boolean;
}

export type Prompt = QuestionPrompt | ApprovalPrompt;

export type PromptOutcome =
  | { kind: 'answered'; answers: Record<string, string> }
  | { kind: 'approved' }
  | { kind: 'always' }
  | { kind: 'denied'; message: string }
  | { kind: 'cancelled'; reason: string };

// Action values: prompt ID, `${promptId}:${questionIndex}` for questionOther, run ID for stop; option values are option indexes.
export const ACTION = {
  stop: 'run_stop',
  questionSelect: 'q_select',
  questionOther: 'q_other',
  questionSubmit: 'q_submit',
  approve: 'perm_approve',
  always: 'perm_always',
  deny: 'perm_deny',
  denyNote: 'perm_deny_note',
} as const;

export const VIEW = {
  other: 'view_other',
  denyNote: 'view_deny_note',
} as const;

export const questionBlockId = (index: number) => `q_${index}`;

export const otherActionValue = (promptId: string, questionIndex: number) => `${promptId}:${questionIndex}`;

export function parseOtherActionValue(value: string): { promptId: string; questionIndex: number } {
  const sep = value.lastIndexOf(':');
  return { promptId: value.slice(0, sep), questionIndex: Number(value.slice(sep + 1)) };
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function resultOutcome(msg: SDKResultMessage): { isError: boolean; text: string } {
  const text = msg.subtype === 'success' ? msg.result : msg.errors.join('\n') || msg.subtype;
  return { isError: msg.is_error || msg.subtype !== 'success', text };
}
