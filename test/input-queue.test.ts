import { describe, expect, test } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue, QueueClosedError } from '../src/input-queue.ts';

const textOf = (m: SDKUserMessage): unknown => m.message.content;

describe('InputQueue', () => {
  test('push before iteration starts is yielded', async () => {
    const q = new InputQueue();
    q.push('one');
    const it = q[Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.done).toBe(false);
    expect(textOf(r.value as SDKUserMessage)).toBe('one');
  });

  test('push after iteration starts resolves the pending next()', async () => {
    const q = new InputQueue();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.push('later');
    const r = await pending;
    expect(r.done).toBe(false);
    expect(textOf(r.value as SDKUserMessage)).toBe('later');
  });

  test('messages have SDKUserMessage shape with unique uuids', async () => {
    const q = new InputQueue();
    const u1 = q.push('a');
    const u2 = q.push('b');
    expect(u1).not.toBe(u2);
    const it = q[Symbol.asyncIterator]();
    const m1 = (await it.next()).value;
    const m2 = (await it.next()).value;
    expect(m1).toEqual({ type: 'user', message: { role: 'user', content: 'a' }, parent_tool_use_id: null, uuid: u1 });
    expect(m2).toEqual({ type: 'user', message: { role: 'user', content: 'b' }, parent_tool_use_id: null, uuid: u2 });
  });

  test('close ends a for-await loop with a pending next()', async () => {
    const q = new InputQueue();
    const seen: string[] = [];
    const loop = (async () => {
      for await (const m of q) seen.push(textOf(m) as string);
    })();
    await Promise.resolve();
    q.push('x');
    await Promise.resolve();
    q.close();
    await loop;
    expect(seen).toEqual(['x']);
  });

  test('pending next() resolves done on close', async () => {
    const q = new InputQueue();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.close();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  test('buffered messages pushed before close are yielded, then done', async () => {
    const q = new InputQueue();
    q.push('a');
    q.push('b');
    q.close();
    const seen: string[] = [];
    for await (const m of q) seen.push(textOf(m) as string);
    expect(seen).toEqual(['a', 'b']);
  });

  test('push after close throws QueueClosedError', () => {
    const q = new InputQueue();
    expect(q.closed).toBe(false);
    q.close();
    expect(q.closed).toBe(true);
    expect(() => q.push('x')).toThrow(QueueClosedError);
  });

  test('a second iterator throws', () => {
    const q = new InputQueue();
    q[Symbol.asyncIterator]();
    expect(() => q[Symbol.asyncIterator]()).toThrow();
  });
});
