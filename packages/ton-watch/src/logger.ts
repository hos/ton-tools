export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const levels = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof levels)[number];

export function consoleLogger(level: LogLevel = "info"): Logger {
  const min = levels.indexOf(level);
  const at = (l: LogLevel, fn: (...a: unknown[]) => void) =>
    levels.indexOf(l) >= min ? fn : () => {};
  return {
    debug: at("debug", console.debug.bind(console, "[ton-watch]")),
    info: at("info", console.info.bind(console, "[ton-watch]")),
    warn: at("warn", console.warn.bind(console, "[ton-watch]")),
    error: at("error", console.error.bind(console, "[ton-watch]")),
  };
}

export const silentLogger: Logger = consoleLogger("silent");

export const logger: Logger = consoleLogger(
  (process.env.TON_WATCH_LOG as LogLevel | undefined) ?? "info",
);
