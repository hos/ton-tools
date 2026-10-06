import type { ServerDefinition } from "@ton/ls";

import type { DetectMode } from "../indexer/options";
import type { AddAddressOptions } from "../ton-watch";
import { isLogLevel, type LogLevel } from "../util/logger";

/** Service configuration, read from the environment (see `bin/ton-watch.ts`). */
export interface ServiceConfig {
  databaseUrl: string;
  /** Postgres schema; the store's default when unset. */
  schema?: string;
  network: ServerDefinition;
  archiveNetwork?: ServerDefinition;
  /** Addresses to ensure on start, each with where its history begins. */
  addresses: { address: string; from: AddAddressOptions["from"] }[];
  /** Health/metrics HTTP port; 0 disables the server. */
  port: number;
  concurrency: number;
  detect: DetectMode;
  logLevel: LogLevel;
  history: ToncenterConfig | null;
}

export interface ToncenterConfig {
  mode: "fallback" | "boost";
  apiKey?: string;
  endpoint?: string;
}

type Env = Record<string, string | undefined>;

const DEFAULT_PORT = 9464;
const DEFAULT_CONCURRENCY = 16;
const DETECT_MODES: readonly DetectMode[] = ["poll", "blocks", "auto"];
const HISTORY_MODES: readonly ToncenterConfig["mode"][] = ["fallback", "boost"];
const HISTORY_SOURCES = ["toncenter"] as const;
const MAX_PORT = 65_535;

/** An empty variable (`TON_WATCH_LOG=` in compose/k8s) means "unset", not an invalid value. */
const withoutEmpty = (env: Env): Env =>
  Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));

export function configFromEnv(rawEnv: Env): ServiceConfig {
  const env = withoutEmpty(rawEnv);
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl: env.DATABASE_URL,
    schema: env.TON_WATCH_SCHEMA,
    network: (env.TON_NETWORK ?? env.TON_NETWORK_CONFIG_URL ?? "mainnet") as ServerDefinition,
    archiveNetwork: env.TON_ARCHIVE_CONFIG as ServerDefinition | undefined,
    addresses: parseAddressList(env.TON_WATCH_ADDRESSES ?? ""),
    port: integerInRange("TON_WATCH_PORT", env.TON_WATCH_PORT, DEFAULT_PORT, 0, MAX_PORT),
    concurrency: integerInRange(
      "TON_WATCH_CONCURRENCY",
      env.TON_WATCH_CONCURRENCY,
      DEFAULT_CONCURRENCY,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    detect: oneOf("TON_WATCH_DETECT", env.TON_WATCH_DETECT ?? "auto", DETECT_MODES),
    logLevel: logLevelFromEnv(env),
    history: historyFromEnv(env),
  };
}

/** The toncenter plug-in settings when `TON_WATCH_HISTORY=toncenter`, else null. */
function historyFromEnv(env: Env): ToncenterConfig | null {
  if (env.TON_WATCH_HISTORY === undefined) return null;
  oneOf("TON_WATCH_HISTORY", env.TON_WATCH_HISTORY, HISTORY_SOURCES);
  return {
    mode: oneOf("TON_WATCH_HISTORY_MODE", env.TON_WATCH_HISTORY_MODE ?? "fallback", HISTORY_MODES),
    apiKey: env.TONCENTER_API_KEY,
    endpoint: env.TONCENTER_ENDPOINT,
  };
}

export function logLevelFromEnv(env: Env): LogLevel {
  const level = env.TON_WATCH_LOG || "info";
  if (!isLogLevel(level)) throw new Error(`invalid TON_WATCH_LOG: ${level}`);
  return level;
}

/** `now`, `genesis` or an lt, as given to `add --from` and in `TON_WATCH_ADDRESSES`. */
export function parseFrom(value: string | undefined): AddAddressOptions["from"] {
  if (!value || value === "now") return "now";
  if (value === "genesis") return "genesis";
  if (/^\d+$/.test(value)) return BigInt(value);
  throw new Error(`invalid --from value: ${value} (now | genesis | <lt>)`);
}

/** `addr1,addr2@genesis,addr3@<lt>`: comma-separated, each optionally `@<from>`. */
function parseAddressList(list: string): ServiceConfig["addresses"] {
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [address = "", from] = entry.split("@");
      return { address, from: parseFrom(from) };
    });
}

/** A decimal integer in `[min, max]`, or `fallback` when the variable is unset. */
function integerInRange(
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

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${name}: ${value} (${allowed.join(" | ")})`);
  }
  return value as T;
}
