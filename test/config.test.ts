import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadChannels, loadConfig, parseChannels } from '../src/config.ts';

const UID = 1000;

let dir: string;
let workDir: string;
let channelsFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slack-bot-config-'));
  workDir = mkdtempSync(join(dir, 'work-'));
  channelsFile = join(dir, 'channels.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeChannels(value: unknown): void {
  writeFileSync(channelsFile, JSON.stringify(value));
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_APP_TOKEN: 'xapp-test',
    ALLOWED_USER_ID: 'U123',
    CHANNELS_FILE: channelsFile,
    ...overrides,
  };
}

describe('loadConfig', () => {
  test('valid config with all fields', () => {
    writeChannels({ C1: { cwd: workDir, permissionMode: 'acceptEdits', disallowedTools: ['Bash', 'WebFetch'], model: 'claude-opus-5-5' } });
    const dbPath = join(dir, 'db', 'bot.db');
    expect(loadConfig(env({ DB_PATH: dbPath, RETENTION_DAYS: '7' }), UID)).toEqual({
      slackBotToken: 'xoxb-test',
      slackAppToken: 'xapp-test',
      allowedUserId: 'U123',
      channelsFile,
      dbPath,
      retentionDays: 7,
      channels: { C1: { cwd: workDir, permissionMode: 'acceptEdits', disallowedTools: ['Bash', 'WebFetch'], model: 'claude-opus-5-5' } },
    });
  });

  test('applies defaults', () => {
    writeChannels({ C1: { cwd: workDir } });
    const config = loadConfig(env(), UID);
    expect(config.dbPath).toBe('./data/bot.db');
    expect(config.retentionDays).toBe(30);
    expect(config.channels.C1).toEqual({ cwd: workDir, permissionMode: 'bypassPermissions', disallowedTools: [] });
    expect(config.channels.C1).not.toHaveProperty('model');
  });

  test('RETENTION_DAYS accepts 0 and rejects non-integers', () => {
    writeChannels({ C1: { cwd: workDir } });
    expect(loadConfig(env({ RETENTION_DAYS: '0' }), UID).retentionDays).toBe(0);
    for (const bad of ['-1', '1.5', 'abc', '30d']) {
      expect(() => loadConfig(env({ RETENTION_DAYS: bad }), UID)).toThrow(/RETENTION_DAYS/);
    }
  });

  test('ANTHROPIC_API_KEY present throws', () => {
    writeChannels({ C1: { cwd: workDir } });
    expect(() => loadConfig(env({ ANTHROPIC_API_KEY: 'sk-ant-x' }), UID)).toThrow(ConfigError);
  });

  test('uid 0 throws', () => {
    writeChannels({ C1: { cwd: workDir } });
    expect(() => loadConfig(env(), 0)).toThrow(ConfigError);
  });

  for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'ALLOWED_USER_ID']) {
    test(`missing ${key} throws`, () => {
      writeChannels({ C1: { cwd: workDir } });
      expect(() => loadConfig(env({ [key]: undefined }), UID)).toThrow(new ConfigError(`${key} is required`));
      expect(() => loadConfig(env({ [key]: '' }), UID)).toThrow(ConfigError);
    });
  }

  test('missing channels file throws', () => {
    expect(() => loadConfig(env(), UID)).toThrow(ConfigError);
  });

  test('invalid JSON channels file throws', () => {
    writeFileSync(channelsFile, '{ not json');
    expect(() => loadConfig(env(), UID)).toThrow(ConfigError);
  });

  test('channels file that is not an object throws', () => {
    writeChannels([{ cwd: workDir }]);
    expect(() => loadConfig(env(), UID)).toThrow(ConfigError);
  });
});

describe('parseChannels', () => {
  test('missing cwd throws', () => {
    expect(() => parseChannels({ C1: {} })).toThrow(ConfigError);
    expect(() => parseChannels({ C1: { cwd: '' } })).toThrow(ConfigError);
  });

  test('non-absolute cwd throws', () => {
    expect(() => parseChannels({ C1: { cwd: 'relative/dir' } })).toThrow(/absolute/);
  });

  test('non-existent cwd throws', () => {
    expect(() => parseChannels({ C1: { cwd: join(dir, 'missing') } })).toThrow(/not an existing directory/);
  });

  test('cwd that is a file throws', () => {
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    expect(() => parseChannels({ C1: { cwd: file } })).toThrow(/not an existing directory/);
  });

  test('invalid permissionMode throws', () => {
    expect(() => parseChannels({ C1: { cwd: workDir, permissionMode: 'yolo' } })).toThrow(/permissionMode/);
    expect(() => parseChannels({ C1: { cwd: workDir, permissionMode: 1 } })).toThrow(/permissionMode/);
  });

  test('invalid disallowedTools throws', () => {
    expect(() => parseChannels({ C1: { cwd: workDir, disallowedTools: 'Bash' } })).toThrow(/disallowedTools/);
    expect(() => parseChannels({ C1: { cwd: workDir, disallowedTools: ['Bash', 1] } })).toThrow(/disallowedTools/);
  });

  test('requireMention is stored only when false and must be a boolean', () => {
    expect(parseChannels({ C1: { cwd: workDir, requireMention: true } }).C1).not.toHaveProperty('requireMention');
    expect(parseChannels({ C1: { cwd: workDir, requireMention: false } }).C1?.requireMention).toBe(false);
    expect(() => parseChannels({ C1: { cwd: workDir, requireMention: 'no' } })).toThrow(/requireMention/);
  });

  test('thirdParty is parsed and validated', () => {
    const tp = { baseUrl: 'https://tp.example', authToken: 't', env: { ANTHROPIC_MODEL: 'glm' } };
    expect(parseChannels({ C1: { cwd: workDir, thirdParty: tp } }).C1?.thirdParty).toEqual(tp);
    expect(parseChannels({ C1: { cwd: workDir, thirdParty: { baseUrl: 'https://tp.example', apiKey: 'k' } } }).C1?.thirdParty).toEqual({ baseUrl: 'https://tp.example', apiKey: 'k', env: {} });
    expect(parseChannels({ C1: { cwd: workDir } }).C1).not.toHaveProperty('thirdParty');
    expect(() => parseChannels({ C1: { cwd: workDir, thirdParty: true } })).toThrow(/thirdParty must be an object/);
    expect(() => parseChannels({ C1: { cwd: workDir, thirdParty: { authToken: 't' } } })).toThrow(/baseUrl/);
    expect(() => parseChannels({ C1: { cwd: workDir, thirdParty: { baseUrl: 'not a url', authToken: 't' } } })).toThrow(/baseUrl/);
    expect(() => parseChannels({ C1: { cwd: workDir, thirdParty: { baseUrl: 'https://tp' } } })).toThrow(/exactly one/);
    expect(() => parseChannels({ C1: { cwd: workDir, thirdParty: { baseUrl: 'https://tp', apiKey: 'k', authToken: 't' } } })).toThrow(/exactly one/);
    expect(() => parseChannels({ C1: { cwd: workDir, thirdParty: { baseUrl: 'https://tp', apiKey: '' } } })).toThrow(/apiKey/);
    expect(() => parseChannels({ C1: { cwd: workDir, thirdParty: { baseUrl: 'https://tp', apiKey: 'k', env: { X: 1 } } } })).toThrow(/env must be an object of strings/);
    expect(() => parseChannels({ C1: { cwd: workDir, thirdParty: { baseUrl: 'https://tp', apiKey: 'k', env: { ANTHROPIC_BASE_URL: 'x' } } } })).toThrow(/must not set ANTHROPIC_BASE_URL/);
  });

  test('direct key is accepted; other direct message channel IDs are rejected', () => {
    expect(parseChannels({ direct: { cwd: workDir } }).direct?.cwd).toBe(workDir);
    expect(() => parseChannels({ D0123: { cwd: workDir } })).toThrow(/"direct" key/);
  });

  test('loadChannels reads the file and reports read errors as ConfigError', () => {
    writeChannels({ C1: { cwd: workDir } });
    expect(loadChannels(channelsFile).C1?.cwd).toBe(workDir);
    expect(() => loadChannels(join(dir, 'missing.json'))).toThrow(/cannot read/);
  });

  test('non-object entry throws', () => {
    expect(() => parseChannels({ C1: 'x' })).toThrow(ConfigError);
    expect(() => parseChannels(null)).toThrow(ConfigError);
  });
});
