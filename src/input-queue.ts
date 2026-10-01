import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class QueueClosedError extends Error {
  override name = 'QueueClosedError';
}

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  #buffer: SDKUserMessage[] = [];
  #waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  #closed = false;
  #iterating = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Returns the message uuid, which the CLI echoes in `still_queued` and `user_message_uuids`. */
  push(text: string): string {
    if (this.#closed) throw new QueueClosedError('input queue is closed');
    const uuid = randomUUID();
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid,
    };
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter({ value: message, done: false });
    } else {
      this.#buffer.push(message);
    }
    return uuid;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    if (this.#iterating) throw new Error('InputQueue supports a single consumer');
    this.#iterating = true;
    return {
      next: () => {
        const message = this.#buffer.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiter = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
