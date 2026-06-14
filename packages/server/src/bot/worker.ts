/**
 * Opponent-AI worker thread: a thin wrapper that runs the bot connection
 * (see ./runner) and exits the thread when it finishes or the parent says stop.
 *
 * tsx transpiles this entry file but does not register its loader for the
 * worker's own imports, so we pull the runner in through tsx's programmatic
 * `tsImport` API, which transpiles it (and its TypeScript imports) on the fly.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
import type { BotConfig } from './runner.ts';

const { runBot } = (await tsImport('./runner.ts', import.meta.url)) as typeof import('./runner.ts');

const stop = runBot(workerData as BotConfig, () => setTimeout(() => process.exit(0), 50));

parentPort?.on('message', (m: unknown) => {
  if (m === 'stop') stop();
});
