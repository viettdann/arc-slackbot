import { dirname, resolve } from 'node:path';
import { Channels, describeDiff, isEmptyDiff, watchFile } from './channels.ts';
import { loadChannels, loadConfig, ConfigError } from './config.ts';
import { createFileSaver, pruneFiles } from './files.ts';
import { PendingRegistry } from './permissions.ts';
import { assistantText, progressLine } from './render.ts';
import { Runner } from './runner.ts';
import { Controller, createSlackApp, registerHandlers, type ReloadOutcome } from './slack.ts';
import { Store } from './store.ts';
import { errorMessage } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`config: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const bootedAt = Date.now();
  const store = new Store(config.dbPath);
  const filesDir = resolve(dirname(config.dbPath), 'files');
  const registry = new PendingRegistry();
  const channels = new Channels(config.channels);
  const app = createSlackApp(config);
  const auth = await app.client.auth.test();
  if (!auth.user_id) throw new Error('auth.test returned no bot user id');

  // Runner and Controller reference each other; the closure defers the lookup until the first run starts.
  let controller: Controller | undefined;
  const runner = new Runner({
    channels,
    store,
    pending: registry,
    canUseTool: (run) => controller!.canUseToolFor(run),
    describe: (msg) => ({ lines: progressLine(msg), text: assistantText(msg) }),
  });
  controller = new Controller({
    client: app.client,
    runner,
    store,
    registry,
    config,
    channels,
    loadChannels: () => loadChannels(config.channelsFile),
    botUserId: auth.user_id,
    saveFiles: createFileSaver({ token: config.slackBotToken, dir: filesDir }),
    teamUrl: auth.url,
  });
  registerHandlers(app, controller);

  let unwatch: (() => void) | undefined;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    unwatch?.();
    console.log(`${signal}: stopping ${runner.active().length} run(s)`);
    try {
      await runner.stopAll();
      await controller.drain();
      await app.stop();
    } catch (err) {
      console.error('shutdown:', err);
    } finally {
      store.close();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.start();
  console.log(`Slack Claude bot connected as ${auth.user ?? auth.user_id}; channels: ${Object.keys(config.channels).join(', ') || '(none)'}`);
  // Recovered only once connected, so a failed start leaves the rows for the next start to fix.
  const interrupted = store.recoverStaleRuns(bootedAt);
  if (interrupted.length > 0) {
    console.log(`marking ${interrupted.length} run(s) interrupted by the previous crash`);
    void controller.cleanupInterrupted(interrupted).catch((err) => console.error('cleanup interrupted:', errorMessage(err)));
  }

  void controller
    .membershipWarnings()
    .then((warnings) => warnings.forEach((w) => console.warn(`channels: ${w}`)))
    .catch((err) => console.error('membership check:', errorMessage(err)));

  const logReload = (outcome: ReloadOutcome) => {
    if (!outcome.ok) console.error(`channels reload failed, keeping the previous mapping: ${outcome.error}`);
    else if (!isEmptyDiff(outcome.diff)) console.log(`channels reloaded: ${describeDiff(outcome.diff)}`);
    if (outcome.ok) outcome.warnings.forEach((w) => console.warn(`channels: ${w}`));
  };
  try {
    unwatch = watchFile(config.channelsFile, () => void controller.reloadChannels().then(logReload));
  } catch (err) {
    console.error(`cannot watch ${config.channelsFile}; use /claude reload:`, errorMessage(err));
  }

  if (config.retentionDays > 0) {
    const prune = async () => {
      const cutoff = Date.now() - config.retentionDays * DAY_MS;
      try {
        const runs = store.pruneRuns(cutoff);
        const threads = await pruneFiles(filesDir, cutoff);
        if (runs || threads) console.log(`pruned ${runs} run(s) and ${threads} attachment folder(s) older than ${config.retentionDays} days`);
      } catch (err) {
        console.error('prune:', errorMessage(err));
      }
    };
    void prune();
    setInterval(() => void prune(), DAY_MS).unref();
  }
}

await main();
