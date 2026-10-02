import { mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { errorMessage } from './types.ts';

export interface SlackFile {
  id: string;
  name?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export interface SavedFiles {
  saved: string[];
  failed: string[];
}

export type SaveFiles = (files: SlackFile[], channelId: string, threadTs: string) => Promise<SavedFiles>;

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const safeFileName = (name: string) => basename(name).replace(/[^\w.-]/g, '_').replace(/^\.+/, '_') || 'file';

export function createFileSaver(opts: { token: string; dir: string; fetch?: typeof fetch }): SaveFiles {
  const doFetch = opts.fetch ?? fetch;
  const saveOne = async (file: SlackFile, dir: string): Promise<string> => {
    const url = file.url_private_download ?? file.url_private;
    if (!url) throw new Error('no download URL');
    if ((file.size ?? 0) > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${opts.token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Slack answers a token without files:read with a 200 HTML login page instead of an error.
    if (res.headers.get('content-type')?.startsWith('text/html')) throw new Error('got an HTML page; is the files:read scope granted?');
    const path = join(dir, `${file.id}-${safeFileName(file.name ?? file.id)}`);
    await writeFile(path, res.body ?? '');
    return path;
  };

  return async (files, channelId, threadTs) => {
    const dir = join(opts.dir, channelId, threadTs);
    await mkdir(dir, { recursive: true });
    const results = await Promise.allSettled(files.map((file) => saveOne(file, dir)));
    const out: SavedFiles = { saved: [], failed: [] };
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') out.saved.push(r.value);
      else out.failed.push(`${files[i]!.name ?? files[i]!.id} (${errorMessage(r.reason)})`);
    });
    return out;
  };
}

export function withAttachments(text: string, { saved, failed }: SavedFiles): string {
  const parts = text ? [text] : [];
  if (saved.length > 0) parts.push(['Attached files (saved locally):', ...saved.map((p) => `- ${p}`)].join('\n'));
  if (failed.length > 0) parts.push(['Attached files that could not be downloaded:', ...failed.map((f) => `- ${f}`)].join('\n'));
  return parts.join('\n\n');
}

/** Expects the `<dir>/<channel>/<thread>` layout written by createFileSaver. */
export async function pruneFiles(dir: string, cutoff: number): Promise<number> {
  const list = (path: string) => readdir(path, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const channel of await list(dir)) {
    if (!channel.isDirectory()) continue;
    const channelDir = join(dir, channel.name);
    for (const thread of await list(channelDir)) {
      const threadDir = join(channelDir, thread.name);
      if (!thread.isDirectory()) continue;
      try {
        if ((await stat(threadDir)).mtimeMs >= cutoff) continue;
        await rm(threadDir, { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.error(`files: cannot prune ${threadDir}:`, errorMessage(err));
      }
    }
    // Fails while the folder still has threads, which is the case to keep it.
    await rmdir(channelDir).catch(() => undefined);
  }
  return removed;
}
