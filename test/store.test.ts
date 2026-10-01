import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

let dir: string;
let dbPath: string;
let store: Store | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slack-bot-store-'));
  dbPath = join(dir, 'nested', 'data', 'bot.db');
});

afterEach(() => {
  store?.close();
  store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function open(): Store {
  store = new Store(dbPath);
  return store;
}

function reopen(): Store {
  store?.close();
  return open();
}

describe('Store', () => {
  test('creates the parent directory when missing', () => {
    expect(existsSync(join(dir, 'nested'))).toBe(false);
    open();
    expect(existsSync(dbPath)).toBe(true);
  });

  test('migrates a version 0 database and keeps its rows', () => {
    mkdirSync(join(dir, 'nested', 'data'), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.run(`CREATE TABLE runs (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, session_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL, turns INTEGER, cost_usd REAL, duration_ms INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER)`);
    legacy.run(`INSERT INTO runs (id, channel_id, thread_ts, prompt, status, started_at) VALUES ('r0', 'C1', '1.1', 'p', 'done', 1)`);
    legacy.close();

    const s = open();
    expect(s.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(s.recentRuns(1)[0]).toMatchObject({ id: 'r0', statusTs: null, triggerTs: null });
    s.insertRun({ id: 'r1', channelId: 'C1', threadTs: '2.2', prompt: 'p', startedAt: 2, statusTs: '2.3', triggerTs: '2.2' });
    expect(reopen().recentRuns(1)[0]).toMatchObject({ id: 'r1', statusTs: '2.3', triggerTs: '2.2' });
  });

  describe('threads', () => {
    test('upsert and lookup by (channel_id, thread_ts)', () => {
      const s = open();
      s.saveThread({ channelId: 'C1', threadTs: '1.1', sessionId: 's1', cwd: '/a', updatedAt: 100 });
      s.saveThread({ channelId: 'C1', threadTs: '2.2', sessionId: 's2', cwd: '/b', updatedAt: 100 });
      s.saveThread({ channelId: 'C1', threadTs: '1.1', sessionId: 's3', cwd: '/c', updatedAt: 200 });

      expect(s.getThread('C1', '1.1')).toEqual({ channelId: 'C1', threadTs: '1.1', sessionId: 's3', cwd: '/c', updatedAt: 200 });
      expect(s.getThread('C1', '2.2')).toEqual({ channelId: 'C1', threadTs: '2.2', sessionId: 's2', cwd: '/b', updatedAt: 100 });
      expect(s.getThread('C2', '1.1')).toBeNull();
      expect(s.getThread('C1', '9.9')).toBeNull();
    });

    test('updatedAt defaults to now', () => {
      const s = open();
      const before = Date.now();
      s.saveThread({ channelId: 'C1', threadTs: '1.1', sessionId: 's1', cwd: '/a' });
      expect(s.getThread('C1', '1.1')?.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('runs', () => {
    test('hasRun matches channel and thread', () => {
      const s = open();
      s.insertRun({ id: 'r1', channelId: 'C1', threadTs: '1.1', prompt: 'p', startedAt: 1000 });
      expect(s.hasRun('C1', '1.1')).toBe(true);
      expect(s.hasRun('C1', '2.2')).toBe(false);
      expect(s.hasRun('C2', '1.1')).toBe(false);
    });

    test('insertRun + finishRun round trip', () => {
      const s = open();
      s.insertRun({ id: 'r1', channelId: 'C1', threadTs: '1.1', prompt: 'hello', startedAt: 1000 });
      expect(s.recentRuns(10)).toEqual([
        { id: 'r1', channelId: 'C1', threadTs: '1.1', sessionId: null, prompt: 'hello', status: 'running', turns: null, costUsd: null, durationMs: null, startedAt: 1000, endedAt: null, statusTs: null, triggerTs: null },
      ]);

      s.finishRun('r1', { status: 'done', sessionId: 's1', turns: 3, costUsd: 0.25, durationMs: 500, endedAt: 1500 });
      expect(s.recentRuns(10)).toEqual([
        { id: 'r1', channelId: 'C1', threadTs: '1.1', sessionId: 's1', prompt: 'hello', status: 'done', turns: 3, costUsd: 0.25, durationMs: 500, startedAt: 1000, endedAt: 1500, statusTs: null, triggerTs: null },
      ]);
    });

    test('finishRun without sessionId keeps the existing one', () => {
      const s = open();
      s.insertRun({ id: 'r1', channelId: 'C1', threadTs: '1.1', sessionId: 's0', prompt: 'p', startedAt: 1000 });
      s.finishRun('r1', { status: 'error', turns: 1, durationMs: 10, endedAt: 1010 });
      const [run] = s.recentRuns(1);
      expect(run?.sessionId).toBe('s0');
      expect(run?.costUsd).toBeNull();
      expect(run?.status).toBe('error');
    });

    test('recoverStaleRuns marks only running rows started before boot as shutdown and returns them', () => {
      const s = open();
      s.insertRun({ id: 'stale', channelId: 'C1', threadTs: '1.1', prompt: 'p', startedAt: 1000, statusTs: '1.2', triggerTs: '1.1' });
      s.insertRun({ id: 'current', channelId: 'C2', threadTs: '3.3', prompt: 'p', startedAt: 4000 });
      s.insertRun({ id: 'done', channelId: 'C1', threadTs: '2.2', prompt: 'p', startedAt: 2000 });
      s.finishRun('done', { status: 'done', turns: 2, durationMs: 100, endedAt: 2100 });

      const r = reopen();
      expect(r.recentRuns(10).find((x) => x.id === 'stale')?.status).toBe('running');
      const recovered = r.recoverStaleRuns(3000, 5000);
      expect(recovered.map((x) => [x.id, x.status, x.endedAt, x.durationMs, x.statusTs, x.triggerTs])).toEqual([['stale', 'shutdown', 5000, 4000, '1.2', '1.1']]);
      expect(r.recentRuns(10).find((x) => x.id === 'current')?.status).toBe('running');
      expect(r.recentRuns(10).find((x) => x.id === 'done')).toEqual({
        id: 'done', channelId: 'C1', threadTs: '2.2', sessionId: null, prompt: 'p', status: 'done', turns: 2, costUsd: null, durationMs: 100, startedAt: 2000, endedAt: 2100, statusTs: null, triggerTs: null,
      });
      expect(r.recoverStaleRuns(3000)).toEqual([]);
    });

    test('pruneRuns deletes finished rows older than the cutoff and keeps running ones', () => {
      const s = open();
      s.insertRun({ id: 'old', channelId: 'C1', threadTs: '1.1', prompt: 'p', startedAt: 100 });
      s.finishRun('old', { status: 'done', turns: 1, durationMs: 10, endedAt: 110 });
      s.insertRun({ id: 'new', channelId: 'C1', threadTs: '2.2', prompt: 'p', startedAt: 900 });
      s.finishRun('new', { status: 'done', turns: 1, durationMs: 10, endedAt: 910 });
      s.insertRun({ id: 'live', channelId: 'C1', threadTs: '3.3', prompt: 'p', startedAt: 50 });

      expect(s.pruneRuns(500)).toBe(1);
      expect(s.recentRuns(10).map((r) => r.id).sort()).toEqual(['live', 'new']);
    });

    test('recentRuns ordered by started_at desc and limited', () => {
      const s = open();
      for (const [id, startedAt] of [['a', 3000], ['b', 1000], ['c', 4000], ['d', 2000]] as const) {
        s.insertRun({ id, channelId: 'C1', threadTs: '1.1', prompt: id, startedAt });
      }
      expect(s.recentRuns(10).map((r) => r.id)).toEqual(['c', 'a', 'd', 'b']);
      expect(s.recentRuns(2).map((r) => r.id)).toEqual(['c', 'a']);
    });
  });
});
