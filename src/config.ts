import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { errorMessage, isRecord, type ChannelConfig, type Config } from './types.ts';

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function parseChannels(raw: unknown): Record<string, ChannelConfig> {
  if (!isRecord(raw)) throw new ConfigError('channels file must contain a JSON object keyed by channel ID');
  const channels: Record<string, ChannelConfig> = {};
  for (const [channelId, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) throw new ConfigError(`channel ${channelId}: entry must be an object`);
    const { cwd, permissionMode = 'bypassPermissions', disallowedTools = [], model } = entry;
    if (typeof cwd !== 'string' || cwd === '') throw new ConfigError(`channel ${channelId}: cwd is required`);
    if (!isAbsolute(cwd)) throw new ConfigError(`channel ${channelId}: cwd must be an absolute path`);
    if (!isDirectory(cwd)) throw new ConfigError(`channel ${channelId}: cwd ${cwd} is not an existing directory`);
    if (typeof permissionMode !== 'string' || !PERMISSION_MODES.includes(permissionMode as PermissionMode)) {
      throw new ConfigError(`channel ${channelId}: invalid permissionMode ${JSON.stringify(permissionMode)}`);
    }
    if (!Array.isArray(disallowedTools) || !disallowedTools.every((t) => typeof t === 'string')) {
      throw new ConfigError(`channel ${channelId}: disallowedTools must be an array of strings`);
    }
    if (model !== undefined && (typeof model !== 'string' || model === '')) {
      throw new ConfigError(`channel ${channelId}: model must be a non-empty string`);
    }
    channels[channelId] = {
      cwd,
      permissionMode: permissionMode as PermissionMode,
      disallowedTools: disallowedTools as string[],
      ...(model !== undefined ? { model: model as string } : {}),
    };
  }
  return channels;
}

function retentionDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 30;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`RETENTION_DAYS must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new ConfigError(`${key} is required`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env, uid: number | undefined = process.getuid?.()): Config {
  // An API key would silently bill the API account instead of the logged-in Claude subscription.
  if (env.ANTHROPIC_API_KEY) throw new ConfigError('ANTHROPIC_API_KEY must not be set; use the Claude login or CLAUDE_CODE_OAUTH_TOKEN');
  // bypassPermissions is refused by Claude Code under root.
  if (uid === 0) throw new ConfigError('refusing to run as root');

  const channelsFile = env.CHANNELS_FILE || './channels.json';
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(channelsFile, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read ${channelsFile}: ${errorMessage(err)}`);
  }

  return {
    slackBotToken: required(env, 'SLACK_BOT_TOKEN'),
    slackAppToken: required(env, 'SLACK_APP_TOKEN'),
    allowedUserId: required(env, 'ALLOWED_USER_ID'),
    channelsFile,
    dbPath: env.DB_PATH || './data/bot.db',
    retentionDays: retentionDays(env.RETENTION_DAYS),
    channels: parseChannels(raw),
  };
}
