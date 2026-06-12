/**
 * Structured logging: single-line JSON records on stdout, e.g.
 * {"ts":"2026-06-12T12:00:00.000Z","level":"info","msg":"match started","roomId":"abc123","seed":42}
 *
 * The LOG_LEVEL env var (debug|info|warn|error|silent) gates output; default
 * is 'info'. 'silent' is used by the in-process test harness.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function isLogLevel(v: unknown): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' || v === 'silent';
}

/** Resolve the level from the LOG_LEVEL env var; invalid values fall back to 'info'. */
export function logLevelFromEnv(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return isLogLevel(raw) ? raw : 'info';
}

export function createLogger(level: LogLevel = logLevelFromEnv()): Logger {
  const threshold = LEVEL_ORDER[level];
  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const record = { ts: new Date().toISOString(), level: lvl, msg, ...fields };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };
  return {
    level,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
