import { assertPositiveInteger } from "../util/validate";
import type { ProcessOptions } from "./types";

export type ConsumerSettings = Required<Omit<ProcessOptions, "addresses">>;

const DEFAULT_SETTINGS: ConsumerSettings = {
  from: "start",
  order: "address",
  batchSize: 100,
  concurrency: 8,
  pollMs: 1_000,
  retryMinMs: 1_000,
  retryMaxMs: 60_000,
  transactional: true,
  onError: "retry",
  maxAttempts: 5,
  isRetryable: () => true,
  lock: "fail",
  lagIntervalMs: 15_000,
};

const FAILURE_POLICIES = new Set(["retry", "skip", "dead-letter"]);
const LOCK_MODES = new Set(["fail", "wait"]);

/** Options with defaults applied. Throws on a value that would silently do nothing useful. */
export function resolveSettings(options: ProcessOptions): ConsumerSettings {
  const settings: ConsumerSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ConsumerSettings)[]) {
    if (options[key] !== undefined) Object.assign(settings, { [key]: options[key] });
  }
  assertPositiveInteger("batchSize", settings.batchSize);
  assertPositiveInteger("concurrency", settings.concurrency);
  assertPositiveInteger("maxAttempts", settings.maxAttempts);
  if (!FAILURE_POLICIES.has(settings.onError)) {
    throw new RangeError(
      `onError must be "retry", "skip" or "dead-letter", got ${settings.onError}`,
    );
  }
  if (typeof settings.isRetryable !== "function") {
    throw new TypeError("isRetryable must be a function");
  }
  if (!LOCK_MODES.has(settings.lock)) {
    throw new RangeError(`lock must be "fail" or "wait", got ${settings.lock}`);
  }
  if (!(settings.lagIntervalMs >= 0)) {
    throw new RangeError(`lagIntervalMs must be 0 or more, got ${settings.lagIntervalMs}`);
  }
  return settings;
}
