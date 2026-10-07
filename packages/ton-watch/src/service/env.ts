/** Environment variables as read by the service; `process.env` satisfies it. */
export type Env = Record<string, string | undefined>;

/** One environment variable the service reads. */
export interface EnvVar {
  name: string;
  /** Default, as documented; null when unset means "off" or "none". */
  default: string | null;
  description: string;
}

/**
 * Every environment variable the service reads: the one list docs/ and
 * `bin/ton-watch.ts` document. An empty value counts as unset.
 */
export const ENV_VARS = [
  {
    name: "TON_WATCH_DATABASE_URL",
    default: null,
    description: "Postgres connection string (required; DATABASE_URL is the fallback)",
  },
  {
    name: "DATABASE_URL",
    default: null,
    description: "used when TON_WATCH_DATABASE_URL is unset",
  },
  { name: "TON_WATCH_SCHEMA", default: "ton_watch", description: "Postgres schema for all tables" },
  {
    name: "TON_WATCH_NETWORK",
    default: "mainnet",
    description: "mainnet | testnet | <global config URL>",
  },
  {
    name: "TON_WATCH_ARCHIVE_NETWORK",
    default: null,
    description:
      "global config URL listing archival liteservers, used only for history the others pruned",
  },
  {
    name: "TON_WATCH_ADDRESSES",
    default: null,
    description: "addresses to ensure on start: addr[@now|earliest|<lt>],... (default now)",
  },
  {
    name: "TON_WATCH_PORT",
    default: "9464",
    description: "HTTP port of /health, /metrics, /status and /consumers; 0 disables it",
  },
  { name: "TON_WATCH_CONCURRENCY", default: "16", description: "liteserver pages in flight" },
  { name: "TON_WATCH_DETECT", default: "auto", description: "poll | blocks | auto" },
  { name: "TON_WATCH_LOG", default: "info", description: "debug | info | warn | error | silent" },
  {
    name: "TON_WATCH_ADDRESS_METRICS",
    default: "false",
    description: "true exports per-address gauges (one series per address)",
  },
  {
    name: "TON_WATCH_HISTORY",
    default: null,
    description: "toncenter enables the toncenter history plug-in (experimental)",
  },
  {
    name: "TON_WATCH_HISTORY_MODE",
    default: "fallback",
    description: "fallback (only history liteservers pruned) | boost",
  },
  {
    name: "TON_WATCH_TONCENTER_API_KEY",
    default: null,
    description: "toncenter API key; raises its limit from 1 to 10+ requests/s",
  },
  {
    name: "TON_WATCH_TONCENTER_ENDPOINT",
    default: "https://toncenter.com/api/v2",
    description: "toncenter API v2 endpoint",
  },
  {
    name: "TON_WATCH_WEBHOOK_URL",
    default: null,
    description: 'one webhook target, named "default"',
  },
  {
    name: "TON_WATCH_WEBHOOKS",
    default: null,
    description: "JSON array of named webhook targets",
  },
  {
    name: "TON_WATCH_WEBHOOK_SECRET",
    default: null,
    description: "HMAC-SHA256 signing secret for every target; unsigned when unset",
  },
  {
    name: "TON_WATCH_WEBHOOK_SECRET_PREVIOUS",
    default: null,
    description: "while rotating: the previous secret, signed with as well",
  },
  { name: "TON_WATCH_WEBHOOK_ORDER", default: "address", description: "address | global" },
  {
    name: "TON_WATCH_WEBHOOK_FROM",
    default: "earliest",
    description: "first run only: earliest | now | <lt>",
  },
  { name: "TON_WATCH_WEBHOOK_TIMEOUT_MS", default: "10000", description: "per request" },
  {
    name: "TON_WATCH_WEBHOOK_RETRY_MIN_MS",
    default: "1000",
    description: "first retry delay, doubling per failure",
  },
  { name: "TON_WATCH_WEBHOOK_RETRY_MAX_MS", default: "60000", description: "longest retry delay" },
  {
    name: "TON_WATCH_WEBHOOK_ON_ERROR",
    default: "retry",
    description: "retry | skip | dead-letter, for a transaction the receiver keeps refusing",
  },
  {
    name: "TON_WATCH_WEBHOOK_MAX_ATTEMPTS",
    default: "5",
    description: "failed requests before skip / dead-letter gives up",
  },
] as const;
// A separate statement: `as const satisfies` on the declaration defeats
// `isolatedDeclarations`, which this module is under through `@ton/watch/cli`.
ENV_VARS satisfies readonly EnvVar[];

export type EnvName = (typeof ENV_VARS)[number]["name"];

/** An empty variable (`TON_WATCH_LOG=` in compose/k8s) means "unset", not an invalid value. */
export const withoutEmpty = (env: Env): Env =>
  Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));

/** A decimal integer in `[min, max]`, or `fallback` when the variable is unset. */
export function integerInRange(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max)) {
    throw new Error(`invalid ${name}: ${value} (an integer from ${min} to ${max})`);
  }
  return parsed;
}

/** `value` if it is one of `allowed`; otherwise throws naming the variable and the options. */
export function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${name}: ${value} (${allowed.join(" | ")})`);
  }
  return value as T;
}

/** `true` or `false`; `fallback` when unset. */
export function boolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return oneOf(name, value, ["true", "false"]) === "true";
}
