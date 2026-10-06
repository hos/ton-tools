import type { FailurePolicy } from "../../consumer/types";
import { toRawAddress } from "../../core/address";
import { type Env, integerInRange, oneOf } from "../env";

/** One webhook endpoint and how transactions are delivered to it. */
export interface WebhookTarget {
  /** Identifies the target; its consumer (and stored cursor) is `webhook:<name>`. */
  name: string;
  url: string;
  /**
   * HMAC-SHA256 signing secret; null sends unsigned requests. An entry's
   * `"secret": null` turns signing off for that target despite a global secret.
   */
  secret: string | null;
  /** Raw addresses to deliver; null for every tracked address. */
  addresses: string[] | null;
  order: "address" | "global";
  /** Where a target begins on its first run; later runs resume from the stored cursor. */
  from: "start" | "now" | bigint;
  /** Per-request timeout. */
  timeoutMs: number;
  /** First retry delay after a failed request; doubles per failure up to `retryMaxMs`. */
  retryMinMs: number;
  retryMaxMs: number;
  /**
   * What happens to a transaction the receiver keeps refusing: retried forever
   * (`"retry"`), or after `maxAttempts` skipped or dead-lettered. A rejection that
   * retrying cannot fix (3xx, 4xx other than 408 and 429) is given up on at once.
   */
  onError: FailurePolicy;
  /** Failed requests before `"skip"` or `"dead-letter"` gives up on a retryable failure. */
  maxAttempts: number;
}

/** Name of the target configured by `TON_WATCH_WEBHOOK_URL`. */
export const DEFAULT_WEBHOOK_NAME = "default";

const ORDERS: readonly WebhookTarget["order"][] = ["address", "global"];
const FAILURE_POLICIES: readonly FailurePolicy[] = ["retry", "skip", "dead-letter"];
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MIN_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const MAX_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_ATTEMPTS = 1_000_000;
/** Keys accepted in a `TON_WATCH_WEBHOOKS` entry. */
const ENTRY_KEYS = new Set([
  "name",
  "url",
  "secret",
  "addresses",
  "order",
  "from",
  "timeoutMs",
  "retryMinMs",
  "retryMaxMs",
  "onError",
  "maxAttempts",
]);

/**
 * Webhook targets from `TON_WATCH_WEBHOOK_URL` (one target named `default`) and
 * `TON_WATCH_WEBHOOKS` (a JSON array of named targets). The other
 * `TON_WATCH_WEBHOOK_*` variables are defaults for every target.
 */
export function webhooksFromEnv(env: Env): WebhookTarget[] {
  const defaults = defaultsFromEnv(env);
  const targets: WebhookTarget[] = [];
  if (env.TON_WATCH_WEBHOOK_URL !== undefined) {
    const target = {
      ...defaults,
      name: DEFAULT_WEBHOOK_NAME,
      url: parseUrl("TON_WATCH_WEBHOOK_URL", env.TON_WATCH_WEBHOOK_URL),
    };
    checkRetryRange("TON_WATCH_WEBHOOK_RETRY_MIN_MS", "TON_WATCH_WEBHOOK_RETRY_MAX_MS", target);
    targets.push(target);
  }
  if (env.TON_WATCH_WEBHOOKS !== undefined) {
    targets.push(...parseTargets(env.TON_WATCH_WEBHOOKS, defaults));
  }
  const names = new Set<string>();
  for (const { name } of targets) {
    if (names.has(name)) throw new Error(`duplicate webhook name: ${name}`);
    names.add(name);
  }
  return targets;
}

type TargetDefaults = Omit<WebhookTarget, "name" | "url">;

function defaultsFromEnv(env: Env): TargetDefaults {
  const ms = (name: string, fallback: number) =>
    integerInRange(name, env[name], fallback, 1, MAX_MS);
  return {
    secret: env.TON_WATCH_WEBHOOK_SECRET ?? null,
    addresses: null,
    order: oneOf("TON_WATCH_WEBHOOK_ORDER", env.TON_WATCH_WEBHOOK_ORDER ?? "address", ORDERS),
    from: parseWebhookFrom("TON_WATCH_WEBHOOK_FROM", env.TON_WATCH_WEBHOOK_FROM ?? "start"),
    timeoutMs: ms("TON_WATCH_WEBHOOK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    retryMinMs: ms("TON_WATCH_WEBHOOK_RETRY_MIN_MS", DEFAULT_RETRY_MIN_MS),
    retryMaxMs: ms("TON_WATCH_WEBHOOK_RETRY_MAX_MS", DEFAULT_RETRY_MAX_MS),
    onError: oneOf(
      "TON_WATCH_WEBHOOK_ON_ERROR",
      env.TON_WATCH_WEBHOOK_ON_ERROR ?? "retry",
      FAILURE_POLICIES,
    ),
    maxAttempts: integerInRange(
      "TON_WATCH_WEBHOOK_MAX_ATTEMPTS",
      env.TON_WATCH_WEBHOOK_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
      1,
      MAX_ATTEMPTS,
    ),
  };
}

/** Rejects a first retry delay longer than the longest one. */
function checkRetryRange(
  minName: string,
  maxName: string,
  { retryMinMs, retryMaxMs }: Pick<WebhookTarget, "retryMinMs" | "retryMaxMs">,
): void {
  if (retryMinMs > retryMaxMs) {
    throw new Error(`invalid ${minName}: ${retryMinMs} is above ${maxName} (${retryMaxMs})`);
  }
}

function parseTargets(json: string, defaults: TargetDefaults): WebhookTarget[] {
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch (error) {
    throw new Error(`invalid TON_WATCH_WEBHOOKS: not JSON (${(error as Error).message})`);
  }
  if (!Array.isArray(entries)) throw new Error("invalid TON_WATCH_WEBHOOKS: expected an array");
  return entries.map((entry, index) => parseTarget(entry, index, defaults));
}

function parseTarget(entry: unknown, index: number, defaults: TargetDefaults): WebhookTarget {
  const where = `TON_WATCH_WEBHOOKS[${index}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`invalid ${where}: expected an object`);
  }
  const fields = entry as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!ENTRY_KEYS.has(key)) throw new Error(`invalid ${where}: unknown key "${key}"`);
  }
  const string = (key: string): string | undefined => {
    const value = fields[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`invalid ${where}.${key}: expected a string`);
    return value;
  };
  const integer = (key: "timeoutMs" | "retryMinMs" | "retryMaxMs" | "maxAttempts", max: number) => {
    const value = fields[key];
    if (value === undefined) return defaults[key];
    if (!(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max)) {
      throw new Error(`invalid ${where}.${key}: an integer from 1 to ${max}`);
    }
    return value as number;
  };

  const name = string("name");
  if (name === undefined || !NAME_PATTERN.test(name)) {
    throw new Error(`invalid ${where}.name: required, 1-64 of [A-Za-z0-9._-]`);
  }
  const url = string("url");
  if (url === undefined) throw new Error(`invalid ${where}.url: required`);
  const order = string("order");
  const from = string("from");
  const onError = string("onError");
  const target: WebhookTarget = {
    name,
    url: parseUrl(`${where}.url`, url),
    secret: parseSecret(where, fields.secret, defaults.secret),
    addresses: parseAddresses(where, fields.addresses),
    order: order === undefined ? defaults.order : oneOf(`${where}.order`, order, ORDERS),
    from: from === undefined ? defaults.from : parseWebhookFrom(`${where}.from`, from),
    timeoutMs: integer("timeoutMs", MAX_MS),
    retryMinMs: integer("retryMinMs", MAX_MS),
    retryMaxMs: integer("retryMaxMs", MAX_MS),
    onError:
      onError === undefined
        ? defaults.onError
        : oneOf(`${where}.onError`, onError, FAILURE_POLICIES),
    maxAttempts: integer("maxAttempts", MAX_ATTEMPTS),
  };
  checkRetryRange(`${where}.retryMinMs`, "retryMaxMs", target);
  return target;
}

/** A non-empty string, `null` for unsigned, or the default when absent. */
function parseSecret(where: string, value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string" || value === "") {
    throw new Error(`invalid ${where}.secret: a non-empty string, or null for unsigned requests`);
  }
  return value;
}

function parseAddresses(where: string, value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`invalid ${where}.addresses: expected a non-empty array of addresses`);
  }
  return value.map((address) => {
    try {
      return toRawAddress(String(address));
    } catch {
      throw new Error(`invalid ${where}.addresses: ${address} is not an address`);
    }
  });
}

/** An absolute http(s) URL. */
function parseUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid ${name}: not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid ${name}: only http and https URLs are supported`);
  }
  return url.href;
}

/** `start`, `now` or an lt. */
function parseWebhookFrom(name: string, value: string): WebhookTarget["from"] {
  if (value === "start" || value === "now") return value;
  if (/^\d+$/.test(value)) return BigInt(value);
  throw new Error(`invalid ${name}: ${value} (start | now | <lt>)`);
}
