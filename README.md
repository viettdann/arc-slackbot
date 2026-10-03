# Slack Claude Bot

A Slack bot built on the Claude Agent SDK. Mentioning the bot in a configured channel starts a Claude agent run in the project folder mapped to that channel. Progress is shown live in a thread, the run can be stopped at any time, replies in the thread continue the same session, and tool approvals and `AskUserQuestion` prompts are answered with Slack buttons. Only one Slack user (`ALLOWED_USER_ID`) can use the bot; everyone else is ignored.

## Requirements

- Node.js >= 24 and pnpm
- A non-root user (the bot refuses to start as uid 0)
- A Claude login on the machine running the bot (see below)

## Setup

### 1. Create the Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest**, pick your workspace, and paste the contents of `slack-manifest.yaml`.
2. **Install to Workspace**.
3. Collect the tokens:
   - Bot token: **OAuth & Permissions** → Bot User OAuth Token (`xoxb-...`).
   - App-level token: **Basic Information** → **App-Level Tokens** → Generate Token with the `connections:write` scope (`xapp-...`).

### 2. Find IDs

- Your user ID: click your profile picture → **Profile** → **⋯** → **Copy member ID** (`U...`).
- Channel IDs: open the channel → click the channel name → the ID is at the bottom of the details dialog (`C...`).

### 3. Invite the bot

Run `/invite @<bot>` in every channel you map in `channels.json`. At startup and after a reload the bot logs a warning for every mapped channel it is not a member of.

### 4. Log in to Claude

Use one of:

- Run `claude` once as the user that will run the bot and complete the interactive login (stored in `~/.claude/.credentials.json`).
- Run `claude setup-token` and export the result: `export CLAUDE_CODE_OAUTH_TOKEN=...`.

Do not set `ANTHROPIC_API_KEY`; the bot refuses to start when it is present.

### 5. Configure

```sh
cp .env.example .env
cp channels.example.json channels.json
```

`.env`:

| Key | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (`xapp-...`) |
| `ALLOWED_USER_ID` | Slack user ID allowed to use the bot |
| `CHANNELS_FILE` | Path to the channel mapping JSON (default `./channels.json`) |
| `DB_PATH` | SQLite file path (default `./data/bot.db`) |
| `RETENTION_DAYS` | Days to keep finished runs in the history and downloaded attachments (default `30`, `0` keeps them forever) |

`channels.json` maps a channel ID to its settings:

| Field | Required | Default |
|---|---|---|
| `cwd` | yes | — (absolute path to an existing directory) |
| `permissionMode` | no | `bypassPermissions` (one of `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`) |
| `disallowedTools` | no | `[]` |
| `model` | no | SDK default |
| `requireMention` | no | `true` (`false` makes every top-level message in the channel a prompt, no mention needed; ignored for `"direct"`) |
| `thirdParty` | no | — (runs the channel against an Anthropic-compatible third-party API, see below) |

The special key `"direct"` takes the same fields and enables direct messages with the bot (see Usage); other keys starting with `D` are rejected.

`thirdParty` takes `baseUrl` (required, `http` or `https`), exactly one of `apiKey` (sent as `ANTHROPIC_API_KEY`) or `authToken` (sent as `ANTHROPIC_AUTH_TOKEN`), and an optional `env` object of extra variables such as `ANTHROPIC_DEFAULT_HAIKU_MODEL`. `env` must not set the variables the named fields own, Claude credentials (`CLAUDE_CODE_OAUTH_TOKEN` and related), `CLAUDE_CODE_ENTRYPOINT`, or `CLAUDE_CODE_USE_*` provider switches. The values go only to that channel's CLI process, which inherits the bot's environment without those variables and without `ANTHROPIC_CUSTOM_HEADERS`; channels without `thirdParty` keep using the Claude login. Set `model` and the `ANTHROPIC_DEFAULT_*_MODEL` variables to model names the provider accepts. An `env` block in `~/.claude/settings.json` overrides these values, so keep `ANTHROPIC_*` out of it, and an `apiKeyHelper` there is sent to the provider too. Third-party runs show no cost.

Startup validates every field and fails on the first invalid entry. Set `disallowedTools: ["AskUserQuestion"]` to keep the agent from asking questions in that channel.

Edits to `channels.json` are picked up automatically, or with `/claude reload`. An invalid file keeps the previous mapping. Active runs keep the config they started with.

### 6. Install and run

```sh
pnpm install
pnpm start
```

## Usage

- **Start a run**: mention the bot in a mapped channel, e.g. `@claude fix the failing tests`, or just post the prompt in a channel with `requireMention: false`. The run starts in a thread with a live status message and a [Stop] button. The result is posted in the thread (as `result.md` when longer than 12,000 characters).
- **One run per channel and per folder**: mentioning the bot while a run is active in that channel, or in another channel mapped to the same folder (symlinks resolved), gets an ephemeral "Busy" reply with a link to the active thread.
- **Direct messages**: with a `"direct"` entry in `channels.json`, every message you send the bot in its Messages tab is a prompt, no mention needed. Each top-level message starts a run in its own thread; reply in the thread to continue.
- **Reactions** on the triggering message: 👀 accepted, ⏳ running, ✋ waiting for an answer, ✅ done, ❌ error, ⏹ stopped. Replies queued into a running run get 📨.
- **Stop**: press [Stop] on the status message.
- **Add instructions / resume**: reply in the thread. During a run, the reply is queued as a further turn (📨). After the run ends, a reply resumes the same session. Sessions survive bot restarts. Replies with attachments and replies also sent to the channel count too. Claude deletes session transcripts after `cleanupPeriodDays` (default 30 days); a reply to a thread whose transcript is gone gets an error instead of a run, and a new mention in the channel starts over.
- **Attachments**: files attached to a mention or reply (up to 50 MB each) are downloaded to `<dir of DB_PATH>/files/<channel>/<thread>/` and their absolute paths are appended to the prompt, so the agent can read them. A file-only message is a valid prompt. An app installed before `files:read` was added to the manifest needs that scope added and the app reinstalled.
- **Approvals and questions**: tool approval prompts ([Approve], [Always allow (session)], [Deny], [Deny + note…]) and `AskUserQuestion` prompts (options, "Other…", [Submit]) appear in the thread and wait until answered.
- **`/claude status`**: lists active runs with elapsed time, state, and thread link.
- **`/claude stop [#channel|direct]`**: stops the active run in the current or given channel, or the direct message run.
- **`/claude channels`**: lists the mapped channels with their folder, permission mode, model, membership warnings and active run.
- **`@claude /skills`** (or `/skills` in a direct message): lists the skills and plugin commands the channel's folder loads, visible only to you. Run one with `@claude /<name> args`.
- **`/claude reload`**: reloads `channels.json` and reports what changed, or the validation error.
- **App Home**: shows active runs (with [Stop]) and the last 20 runs.
- **Crash recovery**: if the bot dies without a clean shutdown, the next start rewrites the status messages of the runs it left behind to "Interrupted" and replaces their reaction with ⏹. Buttons on messages of runs or prompts that are no longer active answer with an ephemeral "no longer active".
- **Retention**: once at startup and then daily, finished runs and attachment folders older than `RETENTION_DAYS` are deleted. Thread-to-session mappings are kept.

### Permissions

Runs have no turn, budget, or time limit. `bypassPermissions` (the default) runs every tool, including shell commands and file edits, in the mapped `cwd` without asking: only map folders the agent may modify. Set `"permissionMode": "default"` on a channel to get approval prompts in Slack instead.

### Upgrading an installed app

The manifest now requests `channels:read`, `groups:read` (membership check) and `im:history` with the `message.im` event and a writable Messages tab (direct messages). Update the app from `slack-manifest.yaml` and reinstall it; until then `/claude channels` reports a missing scope and direct messages do not reach the bot.

## Development

```sh
pnpm test
pnpm typecheck
```
