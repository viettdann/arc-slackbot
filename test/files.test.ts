import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_FILE_BYTES, createFileSaver, pruneFiles, safeFileName, withAttachments } from '../src/files.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function saver(respond: (url: string, init?: RequestInit) => Response) {
  const dir = mkdtempSync(join(tmpdir(), 'files-'));
  dirs.push(dir);
  const calls: { url: string; auth?: string }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string>).Authorization });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { dir, calls, save: createFileSaver({ token: 'xoxb-t', dir, fetch: fetchFn }) };
}

describe('createFileSaver', () => {
  test('downloads with the bot token into channel/thread dir', async () => {
    const { dir, calls, save } = saver(() => new Response('hello', { headers: { 'content-type': 'text/plain' } }));
    const out = await save([{ id: 'F1', name: '../evil name.txt', url_private_download: 'https://files/F1' }], 'C1', '1.2');
    expect(calls).toEqual([{ url: 'https://files/F1', auth: 'Bearer xoxb-t' }]);
    expect(out.failed).toEqual([]);
    expect(out.saved).toEqual([join(dir, 'C1', '1.2', 'F1-evil_name.txt')]);
    expect(readFileSync(out.saved[0]!, 'utf8')).toBe('hello');
  });

  test('reports HTML login pages, HTTP errors, missing URLs and oversized files as failures', async () => {
    const { save } = saver((url) =>
      url.endsWith('html') ? new Response('<html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('x', { status: 403 }),
    );
    const out = await save(
      [
        { id: 'F1', name: 'a', url_private: 'https://x/html' },
        { id: 'F2', name: 'b', url_private: 'https://x/403' },
        { id: 'F3', name: 'c' },
        { id: 'F4', name: 'd', url_private: 'https://x/big', size: MAX_FILE_BYTES + 1 },
      ],
      'C1',
      '1.2',
    );
    expect(out.saved).toEqual([]);
    expect(out.failed).toHaveLength(4);
    expect(out.failed[0]).toContain('files:read');
    expect(out.failed[1]).toContain('HTTP 403');
    expect(out.failed[2]).toContain('no download URL');
    expect(out.failed[3]).toContain('larger than');
  });
});

describe('helpers', () => {
  test('safeFileName strips path parts and odd characters', () => {
    expect(safeFileName('a/b/../c d?.png')).toBe('c_d_.png');
    expect(safeFileName('.env')).toBe('_env');
    expect(safeFileName('')).toBe('file');
  });

  test('withAttachments lists saved and failed files', () => {
    expect(withAttachments('hi', { saved: [], failed: [] })).toBe('hi');
    expect(withAttachments('', { saved: ['/p/a'], failed: ['b (HTTP 403)'] })).toBe(
      'Attached files (saved locally):\n- /p/a\n\nAttached files that could not be downloaded:\n- b (HTTP 403)',
    );
  });
});

describe('pruneFiles', () => {
  test('removes thread folders older than the cutoff and channel folders left empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prune-'));
    dirs.push(dir);
    const thread = (channel: string, ts: string, mtimeSec: number) => {
      const path = join(dir, channel, ts);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'f.txt'), 'x');
      utimesSync(path, mtimeSec, mtimeSec);
      return path;
    };
    const old1 = thread('C1', '1.1', 100);
    const fresh = thread('C1', '2.2', 2000);
    const old2 = thread('C2', '3.3', 100);

    expect(await pruneFiles(dir, 1000 * 1000)).toBe(2);
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(join(dir, 'C2'))).toBe(false);
  });

  test('a missing root is a no-op', async () => {
    expect(await pruneFiles(join(tmpdir(), 'does-not-exist-prune'), Date.now())).toBe(0);
  });
});
