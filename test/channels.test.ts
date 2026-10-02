import { describe, expect, test } from 'vitest';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebClient } from '@slack/web-api';
import { Channels, checkMembership, describeDiff, diffChannels, watchFile } from '../src/channels.ts';
import type { ChannelConfig } from '../src/types.ts';

const cfg = (cwd: string, extra: Partial<ChannelConfig> = {}): ChannelConfig => ({ cwd, permissionMode: 'default', disallowedTools: [], ...extra });

describe('Channels', () => {
  test('Direct message channel IDs resolve to the direct entry; channelIds omits it', () => {
    const channels = new Channels({ C1: cfg('/a'), direct: cfg('/direct') });
    expect(channels.get('C1')?.cwd).toBe('/a');
    expect(channels.get('D123')?.cwd).toBe('/direct');
    expect(channels.get('C9')).toBeUndefined();
    expect(channels.channelIds()).toEqual(['C1']);
  });

  test('replace swaps the map and returns the diff', () => {
    const channels = new Channels({ C1: cfg('/a'), C2: cfg('/b') });
    const diff = channels.replace({ C1: cfg('/a'), C2: cfg('/b', { model: 'm' }), C3: cfg('/c') });
    expect(diff).toEqual({ added: ['C3'], removed: [], changed: ['C2'] });
    expect(channels.get('C2')?.model).toBe('m');
  });

  test('diffChannels and describeDiff', () => {
    const diff = diffChannels({ C1: cfg('/a'), C2: cfg('/b') }, { C2: cfg('/b'), direct: cfg('/direct') });
    expect(diff).toEqual({ added: ['direct'], removed: ['C1'], changed: [] });
    expect(describeDiff(diff)).toBe('added direct; removed C1');
    expect(describeDiff({ added: [], removed: [], changed: [] })).toBe('no changes');
  });
});

describe('checkMembership', () => {
  test('maps is_member, channel_not_found and other errors', async () => {
    const client = {
      conversations: {
        info: async ({ channel }: { channel: string }) => {
          if (channel === 'CIN') return { ok: true, channel: { is_member: true } };
          if (channel === 'COUT') return { ok: true, channel: { is_member: false } };
          throw Object.assign(new Error('x'), { data: { error: channel === 'GPRIV' ? 'channel_not_found' : 'missing_scope' } });
        },
      },
    } as unknown as Pick<WebClient, 'conversations'>;
    const result = await checkMembership(client, ['CIN', 'COUT', 'GPRIV', 'CSCOPE']);
    expect(Object.fromEntries(result)).toEqual({
      CIN: { kind: 'member' },
      COUT: { kind: 'not_member' },
      GPRIV: { kind: 'not_member' },
      CSCOPE: { kind: 'unknown', error: 'missing_scope' },
    });
  });
});

describe('watchFile', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('fires once per burst of writes and after a rename over the file; ignores other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-'));
    const file = join(dir, 'channels.json');
    writeFileSync(file, '{}');
    let fired = 0;
    const stop = watchFile(file, () => fired++, 50);
    try {
      await wait(50);
      writeFileSync(file, '{"a":1}');
      writeFileSync(file, '{"a":2}');
      await wait(200);
      expect(fired).toBe(1);

      writeFileSync(join(dir, 'other.json'), '{}');
      await wait(200);
      expect(fired).toBe(1);

      writeFileSync(join(dir, 'channels.json.tmp'), '{"b":1}');
      await wait(200);
      fired = 0;
      renameSync(join(dir, 'channels.json.tmp'), file);
      await wait(200);
      expect(fired).toBe(1);
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
