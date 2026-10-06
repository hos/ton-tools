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
  assertDuration("pollMs", settings.pollMs, 1);
  assertDuration("retryMinMs", settings.retryMinMs, 0);
  assertDuration("retryMaxMs", settings.retryMaxMs, settings.retryMinMs);
  assertDuration("lagIntervalMs", settings.lagIntervalMs, 0);
  return settings;
}

/** Throws unless `value` is a finite number of milliseconds of at least `min`. */
function assertDuration(name: string, value: number, min: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new RangeError(`${name} must be a finite number of ms, at least ${min}; got ${value}`);
  }
}
