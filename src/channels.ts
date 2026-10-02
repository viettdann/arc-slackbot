import { watch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { ChannelConfig } from './types.ts';

/** channels.json key holding the config used for direct messages with the bot. */
export const DIRECT_KEY = 'direct';

export const isDirectChannel = (channelId: string) => channelId.startsWith('D');

export interface ChannelDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffChannels(prev: Record<string, ChannelConfig>, next: Record<string, ChannelConfig>): ChannelDiff {
  const same = (a: ChannelConfig, b: ChannelConfig) => JSON.stringify(a) === JSON.stringify(b);
  return {
    added: Object.keys(next).filter((k) => !(k in prev)),
    removed: Object.keys(prev).filter((k) => !(k in next)),
    changed: Object.keys(next).filter((k) => k in prev && !same(prev[k]!, next[k]!)),
  };
}

export const isEmptyDiff = (d: ChannelDiff) => d.added.length + d.removed.length + d.changed.length === 0;

export function describeDiff(d: ChannelDiff): string {
  if (isEmptyDiff(d)) return 'no changes';
  const parts: string[] = [];
  if (d.added.length) parts.push(`added ${d.added.join(', ')}`);
  if (d.removed.length) parts.push(`removed ${d.removed.join(', ')}`);
  if (d.changed.length) parts.push(`changed ${d.changed.join(', ')}`);
  return parts.join('; ');
}

/** Shared by Runner and Controller so a reload applies to the next run without touching active ones. */
export class Channels {
  #map: Record<string, ChannelConfig>;

  constructor(map: Record<string, ChannelConfig>) {
    this.#map = map;
  }

  get(channelId: string): ChannelConfig | undefined {
    return this.#map[isDirectChannel(channelId) ? DIRECT_KEY : channelId];
  }

  entries(): [string, ChannelConfig][] {
    return Object.entries(this.#map);
  }

  /** Mapped Slack channel IDs, without the direct message entry. */
  channelIds(): string[] {
    return Object.keys(this.#map).filter((k) => k !== DIRECT_KEY);
  }

  replace(next: Record<string, ChannelConfig>): ChannelDiff {
    const diff = diffChannels(this.#map, next);
    this.#map = next;
    return diff;
  }
}

export type Membership = { kind: 'member' } | { kind: 'not_member' } | { kind: 'unknown'; error: string };

export async function checkMembership(client: Pick<WebClient, 'conversations'>, ids: string[]): Promise<Map<string, Membership>> {
  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, Membership]> => {
      try {
        const res = await client.conversations.info({ channel: id });
        return [id, res.channel?.is_member ? { kind: 'member' } : { kind: 'not_member' }];
      } catch (err) {
        const code = (err as { data?: { error?: string } }).data?.error ?? String(err);
        // Private channels the bot was not invited to are invisible to it.
        return [id, code === 'channel_not_found' ? { kind: 'not_member' } : { kind: 'unknown', error: code }];
      }
    }),
  );
  return new Map(entries);
}

/** Calls onChange after the file stops changing for debounceMs; returns a function that stops watching. */
export function watchFile(path: string, onChange: () => void, debounceMs = 500): () => void {
  const name = basename(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Watching the directory survives editors that save by renaming a temp file over the original, which drops a file watch.
  const watcher = watch(dirname(resolve(path)), (_event, filename) => {
    if (filename && filename !== name) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  watcher.on('error', (err) => console.error(`watch ${path}:`, err));
  watcher.unref?.();
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
