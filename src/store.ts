import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FinalStatus, RunRecord, RunStatus, ThreadRecord } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  channel_id  TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  thread_ts    TEXT NOT NULL,
  session_id   TEXT,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL,
  turns        INTEGER,
  cost_usd     REAL,
  duration_ms  INTEGER,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at);
`;

// Index i upgrades a database at user_version i; append only, never edit a shipped entry.
const MIGRATIONS = [
  `ALTER TABLE runs ADD COLUMN status_ts TEXT;
   ALTER TABLE runs ADD COLUMN trigger_ts TEXT;`,
];

interface ThreadRow {
  channel_id: string;
  thread_ts: string;
  session_id: string;
  cwd: string;
  updated_at: number;
}

interface RunRow {
  id: string;
  channel_id: string;
  thread_ts: string;
  session_id: string | null;
  prompt: string;
  status: RunStatus;
  turns: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  started_at: number;
  ended_at: number | null;
  status_ts: string | null;
  trigger_ts: string | null;
}

export interface NewRun {
  id: string;
  channelId: string;
  threadTs: string;
  sessionId?: string;
  prompt: string;
  startedAt: number;
  statusTs?: string;
  triggerTs?: string;
}

export interface FinishedRun {
  status: FinalStatus;
  sessionId?: string;
  turns: number;
  costUsd?: number;
  durationMs: number;
  endedAt: number;
}

const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  sessionId: r.session_id,
  prompt: r.prompt,
  status: r.status,
  turns: r.turns,
  costUsd: r.cost_usd,
  durationMs: r.duration_ms,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  statusTs: r.status_ts,
  triggerTs: r.trigger_ts,
});

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(SCHEMA);
    this.#migrate();
  }

  #migrate(): void {
    const { user_version: version } = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.run(MIGRATIONS[v]!);
        this.db.run(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  /** Only runs started before `bootedAt` can be crash leftovers; later ones belong to this process. */
  recoverStaleRuns(bootedAt: number, now = Date.now()): RunRecord[] {
    return this.db
      .query<RunRow, { bootedAt: number; now: number }>(
        `UPDATE runs SET status = 'shutdown', ended_at = $now, duration_ms = $now - started_at WHERE status = 'running' AND started_at < $bootedAt RETURNING *`,
      )
      .all({ bootedAt, now })
      .map(toRun);
  }

  pruneRuns(cutoff: number): number {
    // started_at <= ended_at, so the started_at bound lets the index narrow the scan without changing the result.
    return this.db.query('DELETE FROM runs WHERE started_at < $cutoff AND ended_at < $cutoff').run({ cutoff }).changes;
  }

  saveThread(t: Omit<ThreadRecord, 'updatedAt'> & { updatedAt?: number }): void {
    this.db
      .query(
        `INSERT INTO threads (channel_id, thread_ts, session_id, cwd, updated_at) VALUES ($channelId, $threadTs, $sessionId, $cwd, $updatedAt)
         ON CONFLICT (channel_id, thread_ts) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd, updated_at = excluded.updated_at`,
      )
      .run({ channelId: t.channelId, threadTs: t.threadTs, sessionId: t.sessionId, cwd: t.cwd, updatedAt: t.updatedAt ?? Date.now() });
  }

  getThread(channelId: string, threadTs: string): ThreadRecord | null {
    const row = this.db
      .query<ThreadRow, { channelId: string; threadTs: string }>('SELECT * FROM threads WHERE channel_id = $channelId AND thread_ts = $threadTs')
      .get({ channelId, threadTs });
    if (!row) return null;
    return { channelId: row.channel_id, threadTs: row.thread_ts, sessionId: row.session_id, cwd: row.cwd, updatedAt: row.updated_at };
  }

  hasRun(channelId: string, threadTs: string): boolean {
    return !!this.db.query('SELECT 1 FROM runs WHERE channel_id = $channelId AND thread_ts = $threadTs LIMIT 1').get({ channelId, threadTs });
  }

  insertRun(r: NewRun): void {
    this.db
      .query(
        `INSERT INTO runs (id, channel_id, thread_ts, session_id, prompt, status, started_at, status_ts, trigger_ts)
         VALUES ($id, $channelId, $threadTs, $sessionId, $prompt, 'running', $startedAt, $statusTs, $triggerTs)`,
      )
      .run({
        id: r.id,
        channelId: r.channelId,
        threadTs: r.threadTs,
        sessionId: r.sessionId ?? null,
        prompt: r.prompt,
        startedAt: r.startedAt,
        statusTs: r.statusTs ?? null,
        triggerTs: r.triggerTs ?? null,
      });
  }

  finishRun(id: string, f: FinishedRun): void {
    this.db
      .query(
        `UPDATE runs SET status = $status, session_id = COALESCE($sessionId, session_id), turns = $turns, cost_usd = $costUsd, duration_ms = $durationMs, ended_at = $endedAt WHERE id = $id`,
      )
      .run({ id, status: f.status, sessionId: f.sessionId ?? null, turns: f.turns, costUsd: f.costUsd ?? null, durationMs: f.durationMs, endedAt: f.endedAt });
  }

  recentRuns(limit: number): RunRecord[] {
    return this.db.query<RunRow, [number]>('SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit).map(toRun);
  }

  close(): void {
    this.db.close();
  }
}
