/**
 * Entrypoint: boots the authoritative Mech Arena Fight server with env-driven
 * configuration (PORT, TICK_MS, LOG_LEVEL, BALANCE_PRESET). Tests import
 * startServer from ./server directly and boot in-process on an ephemeral port.
 */
import { startServer } from './server';

startServer().catch((err: unknown) => {
  console.error('fatal: failed to start server', err);
  process.exit(1);
});
