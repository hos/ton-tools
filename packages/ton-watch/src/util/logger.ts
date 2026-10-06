/** Minimal logging interface; `console` satisfies it, as do most logging libraries. */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

/** Lowest level a `consoleLogger` prints; `silent` prints nothing. */
export type LogLevel = (typeof LOG_LEVELS)[number];

const PREFIX = "[ton-watch]";

/** Whether a string names a log level. */
export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Logs to the console with a `[ton-watch]` prefix, dropping messages below `level`. */
export function consoleLogger(level: LogLevel = "info"): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const at = (messageLevel: LogLevel, write: (...args: unknown[]) => void) =>
    LOG_LEVELS.indexOf(messageLevel) >= threshold ? write : () => {};
  return {
    debug: at("debug", console.debug.bind(console, PREFIX)),
    info: at("info", console.info.bind(console, PREFIX)),
    warn: at("warn", console.warn.bind(console, PREFIX)),
    error: at("error", console.error.bind(console, PREFIX)),
  };
}

/** Discards everything. The default for library components. */
export const silentLogger: Logger = consoleLogger("silent");
