import { randomUUID } from 'node:crypto';
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { errorMessage, type ApprovalPrompt, type Prompt, type PromptOutcome, type Question, type QuestionPrompt } from './types.ts';

export interface MessageRef {
  channel: string;
  ts: string;
}

export interface PendingEntry {
  id: string;
  runId: string;
  prompt: Prompt;
  message?: MessageRef;
}

export class PromptCancelledError extends Error {
  reason: string;

  constructor(reason: string) {
    super(`Prompt cancelled: ${reason}`);
    this.name = 'PromptCancelledError';
    this.reason = reason;
  }
}

interface InternalEntry extends PendingEntry {
  resolve(outcome: PromptOutcome): void;
  reject(error: PromptCancelledError): void;
}

export class PendingRegistry {
  private readonly map = new Map<string, InternalEntry>();

  create(prompt: Prompt): Promise<PromptOutcome> {
    if (this.map.has(prompt.id)) throw new Error(`Duplicate prompt id: ${prompt.id}`);
    return new Promise<PromptOutcome>((resolve, reject) => {
      this.map.set(prompt.id, { id: prompt.id, runId: prompt.runId, prompt, resolve, reject });
    });
  }

  get(id: string): PendingEntry | undefined {
    const entry = this.map.get(id);
    return entry && toPublic(entry);
  }

  setMessage(id: string, ref: MessageRef): void {
    const entry = this.map.get(id);
    if (entry) entry.message = ref;
  }

  resolve(id: string, outcome: PromptOutcome): boolean {
    const entry = this.map.get(id);
    if (!entry) return false;
    this.map.delete(id);
    entry.resolve(outcome);
    return true;
  }

  reject(id: string, reason: string): boolean {
    const entry = this.map.get(id);
    if (!entry) return false;
    this.map.delete(id);
    entry.reject(new PromptCancelledError(reason));
    return true;
  }

  rejectRun(runId: string, reason: string): void {
    for (const entry of [...this.map.values()]) {
      if (entry.runId === runId) this.reject(entry.id, reason);
    }
  }

  countForRun(runId: string): number {
    let count = 0;
    for (const entry of this.map.values()) if (entry.runId === runId) count++;
    return count;
  }

  entries(): PendingEntry[] {
    return [...this.map.values()].map(toPublic);
  }
}

function toPublic(entry: InternalEntry): PendingEntry {
  const { id, runId, prompt, message } = entry;
  return message ? { id, runId, prompt, message } : { id, runId, prompt };
}

export interface CanUseToolContext {
  runId: string;
  registry: PendingRegistry;
  post(prompt: Prompt): Promise<MessageRef | undefined>;
  settle(prompt: Prompt, outcome: PromptOutcome, message: MessageRef | undefined): void | Promise<void>;
  onWaitingChange(pendingCount: number): void;
}

const newPromptId = () => randomUUID().replace(/-/g, '').slice(0, 12);

function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q: Record<string, unknown>) => ({
    question: String(q.question ?? ''),
    header: String(q.header ?? ''),
    options: (Array.isArray(q.options) ? q.options : []).map((o: Record<string, unknown>) =>
      typeof o.description === 'string'
        ? { label: String(o.label ?? ''), description: o.description }
        : { label: String(o.label ?? '') },
    ),
    multiSelect: q.multiSelect === true,
  }));
}

function toResult(
  prompt: Prompt,
  input: Record<string, unknown>,
  outcome: PromptOutcome,
  suggestions: PermissionUpdate[] | undefined,
): PermissionResult {
  switch (outcome.kind) {
    case 'answered':
      if (prompt.kind === 'question') return { behavior: 'allow', updatedInput: { ...input, answers: outcome.answers } };
      break;
    case 'approved':
      if (prompt.kind === 'approval') return { behavior: 'allow', updatedInput: input };
      break;
    case 'always':
      if (prompt.kind === 'approval') {
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: (suggestions ?? []).map((s) => ({ ...s, destination: 'session' as const })),
        };
      }
      break;
    case 'denied':
      return { behavior: 'deny', message: outcome.message };
    case 'cancelled':
      return { behavior: 'deny', message: `Cancelled: ${outcome.reason}`, interrupt: true };
  }
  return { behavior: 'deny', message: `Unexpected outcome '${outcome.kind}' for ${prompt.kind} prompt`, interrupt: true };
}

export function createCanUseTool(ctx: CanUseToolContext): CanUseTool {
  const { runId, registry } = ctx;
  return async (toolName, input, options) => {
    const id = newPromptId();
    const prompt: Prompt =
      toolName === 'AskUserQuestion'
        ? { kind: 'question', id, runId, questions: normalizeQuestions(input.questions), other: {} }
        : {
            kind: 'approval',
            id,
            runId,
            toolName,
            input,
            title: options.title,
            decisionReason: options.decisionReason,
            blockedPath: options.blockedPath,
            showAlwaysAllow: (options.suggestions?.length ?? 0) > 0 && !options.suppressAlwaysAllowRule,
          };

    // Handler attached immediately so a reject during post() never surfaces as an unhandled rejection.
    const outcomePromise = registry.create(prompt).catch(
      (err): PromptOutcome => ({ kind: 'cancelled', reason: err instanceof PromptCancelledError ? err.reason : errorMessage(err) }),
    );
    ctx.onWaitingChange(registry.countForRun(runId));

    const { signal } = options;
    const onAbort = () => registry.reject(id, 'aborted');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    let message: MessageRef | undefined;
    try {
      message = await ctx.post(prompt);
      if (message) registry.setMessage(id, message);
    } catch (err) {
      registry.reject(id, `failed to post prompt: ${errorMessage(err)}`);
    }

    const outcome = await outcomePromise;
    signal.removeEventListener('abort', onAbort);
    ctx.onWaitingChange(registry.countForRun(runId));
    try {
      await ctx.settle(prompt, outcome, message);
    } catch (err) {
      console.error(`[permissions] settle failed for prompt ${id}:`, err);
    }
    return toResult(prompt, input, outcome, options.suggestions);
  };
}

export function pendingOf<K extends Prompt['kind']>(
  registry: PendingRegistry,
  promptId: string,
  kind: K,
): Extract<Prompt, { kind: K }> | undefined {
  const prompt = registry.get(promptId)?.prompt;
  return prompt?.kind === kind ? (prompt as Extract<Prompt, { kind: K }>) : undefined;
}

export function submitAnswers(
  registry: PendingRegistry,
  promptId: string,
  selections: Record<number, string[]>,
): { ok: true } | { ok: false; missing: string[] } {
  const prompt: QuestionPrompt | undefined = pendingOf(registry, promptId, 'question');
  if (!prompt) return { ok: false, missing: [] };
  const answers: Record<string, string> = {};
  const missing: string[] = [];
  prompt.questions.forEach((q, index) => {
    const answer = prompt.other[q.question] || (selections[index] ?? []).join(', ');
    if (answer) answers[q.question] = answer;
    else missing.push(q.question);
  });
  if (missing.length > 0) return { ok: false, missing };
  return registry.resolve(promptId, { kind: 'answered', answers }) ? { ok: true } : { ok: false, missing: [] };
}

export function setOtherAnswer(registry: PendingRegistry, promptId: string, questionIndex: number, text: string): boolean {
  const prompt: QuestionPrompt | undefined = pendingOf(registry, promptId, 'question');
  const question = prompt?.questions[questionIndex];
  if (!prompt || !question) return false;
  const trimmed = text.trim();
  if (trimmed) prompt.other[question.question] = trimmed;
  else delete prompt.other[question.question];
  return true;
}

export function approve(registry: PendingRegistry, promptId: string): boolean {
  return !!pendingOf(registry, promptId, 'approval') && registry.resolve(promptId, { kind: 'approved' });
}

export function alwaysAllow(registry: PendingRegistry, promptId: string): boolean {
  const prompt: ApprovalPrompt | undefined = pendingOf(registry, promptId, 'approval');
  return !!prompt?.showAlwaysAllow && registry.resolve(promptId, { kind: 'always' });
}

export function deny(registry: PendingRegistry, promptId: string, note?: string): boolean {
  if (!pendingOf(registry, promptId, 'approval')) return false;
  return registry.resolve(promptId, { kind: 'denied', message: note?.trim() || 'Denied by user' });
}
