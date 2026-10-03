import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { DIRECT_KEY, isDirectChannel } from './channels.ts';
import { errorMessage, isRecord, type ChannelConfig, type Config, type ThirdPartyConfig } from './types.ts';

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

/** Variables the named thirdParty fields own, or that make the CLI send Claude credentials or bypass baseUrl. */
const THIRD_PARTY_RESERVED_ENV: ReadonlySet<string> = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
]);

export const isThirdPartyReservedEnv = (key: string) => THIRD_PARTY_RESERVED_ENV.has(key) || key.startsWith('CLAUDE_CODE_USE_');

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

function parseThirdParty(channelId: string, raw: unknown): ThirdPartyConfig {
  const at = `channel ${channelId}: thirdParty`;
  if (!isRecord(raw)) throw new ConfigError(`${at} must be an object`);
  const { baseUrl, apiKey, authToken, env = {} } = raw;
  const protocol = isNonEmptyString(baseUrl) ? URL.parse(baseUrl)?.protocol : undefined;
  if (protocol !== 'https:' && protocol !== 'http:') throw new ConfigError(`${at}.baseUrl must be an http(s) URL`);
  if (apiKey !== undefined && !isNonEmptyString(apiKey)) throw new ConfigError(`${at}.apiKey must be a non-empty string`);
  if (authToken !== undefined && !isNonEmptyString(authToken)) throw new ConfigError(`${at}.authToken must be a non-empty string`);
  if ((apiKey === undefined) === (authToken === undefined)) throw new ConfigError(`${at} needs exactly one of apiKey and authToken`);
  if (!isRecord(env) || !Object.values(env).every((v) => typeof v === 'string')) throw new ConfigError(`${at}.env must be an object of strings`);
  const reserved = Object.keys(env).filter(isThirdPartyReservedEnv);
  if (reserved.length) throw new ConfigError(`${at}.env must not set ${reserved.join(', ')}`);
  const credential = isNonEmptyString(apiKey) ? { apiKey } : { authToken: authToken as string };
  return { baseUrl: baseUrl as string, ...credential, env: env as Record<string, string> };
}

export function parseChannels(raw: unknown): Record<string, ChannelConfig> {
  if (!isRecord(raw)) throw new ConfigError('channels file must contain a JSON object keyed by channel ID');
  const channels: Record<string, ChannelConfig> = {};
  for (const [channelId, entry] of Object.entries(raw)) {
    if (channelId !== DIRECT_KEY && isDirectChannel(channelId)) throw new ConfigError(`channel ${channelId}: direct message channels are configured with the "${DIRECT_KEY}" key`);
    if (!isRecord(entry)) throw new ConfigError(`channel ${channelId}: entry must be an object`);
    const { cwd, permissionMode = 'bypassPermissions', disallowedTools = [], model, requireMention = true, thirdParty } = entry;
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
    if (typeof requireMention !== 'boolean') throw new ConfigError(`channel ${channelId}: requireMention must be a boolean`);
    channels[channelId] = {
      cwd,
      permissionMode: permissionMode as PermissionMode,
      disallowedTools: disallowedTools as string[],
      ...(model !== undefined ? { model: model as string } : {}),
      ...(requireMention ? {} : { requireMention: false as const }),
      ...(thirdParty !== undefined ? { thirdParty: parseThirdParty(channelId, thirdParty) } : {}),
    };
  }
  return channels;
}

export function loadChannels(channelsFile: string): Record<string, ChannelConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(channelsFile, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read ${channelsFile}: ${errorMessage(err)}`);
  }
  return parseChannels(raw);
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
  const channels = loadChannels(channelsFile);

  return {
    slackBotToken: required(env, 'SLACK_BOT_TOKEN'),
    slackAppToken: required(env, 'SLACK_APP_TOKEN'),
    allowedUserId: required(env, 'ALLOWED_USER_ID'),
    channelsFile,
    dbPath: env.DB_PATH || './data/bot.db',
    retentionDays: retentionDays(env.RETENTION_DAYS),
    channels,
  };
}
