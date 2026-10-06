import type { ServerDefinition } from "@ton/ls";

import { toRawAddress } from "../core/address";
import type { DetectMode } from "../indexer/options";
import type { AddAddressOptions } from "../ton-watch";
import { isLogLevel, type LogLevel } from "../util/logger";
import { boolean, type Env, integerInRange, oneOf, withoutEmpty } from "./env";
import { type WebhookTarget, webhooksFromEnv } from "./webhook/config";

/** Service configuration, read from the environment (every variable is listed in `ENV_VARS`). */
export interface ServiceConfig {
  databaseUrl: string;
  /** Postgres schema; the store's default when unset. */
  schema?: string;
  network: ServerDefinition;
  archiveNetwork?: ServerDefinition;
  /** Addresses (raw) to ensure on start, each with where its history begins. */
  addresses: { address: string; from: AddAddressOptions["from"] }[];
  /** Health/metrics HTTP port; 0 disables the server. */
  port: number;
  concurrency: number;
  detect: DetectMode;
  logLevel: LogLevel;
  /** Export per-address gauges (the indexer's `addressMetrics`). */
  addressMetrics: boolean;
  history: ToncenterConfig | null;
  /** Webhook targets, each delivered by its own consumer; empty when none are configured. */
  webhooks: WebhookTarget[];
}

export interface ToncenterConfig {
  mode: "fallback" | "boost";
  apiKey?: string;
  endpoint?: string;
}

const DEFAULT_PORT = 9464;
const DEFAULT_CONCURRENCY = 16;
const DETECT_MODES: readonly DetectMode[] = ["poll", "blocks", "auto"];
const HISTORY_MODES: readonly ToncenterConfig["mode"][] = ["fallback", "boost"];
const HISTORY_SOURCES = ["toncenter"] as const;
const MAX_PORT = 65_535;

export function configFromEnv(rawEnv: Env): ServiceConfig {
  const env = withoutEmpty(rawEnv);
  const databaseUrl = env.TON_WATCH_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("TON_WATCH_DATABASE_URL (or DATABASE_URL) is required");
  return {
    databaseUrl,
    schema: env.TON_WATCH_SCHEMA,
    network: (env.TON_WATCH_NETWORK ?? "mainnet") as ServerDefinition,
    archiveNetwork: env.TON_WATCH_ARCHIVE_NETWORK as ServerDefinition | undefined,
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
    addressMetrics: boolean("TON_WATCH_ADDRESS_METRICS", env.TON_WATCH_ADDRESS_METRICS, false),
    history: historyFromEnv(env),
    webhooks: webhooksFromEnv(env),
  };
}

/** The toncenter plug-in settings when `TON_WATCH_HISTORY=toncenter`, else null. */
function historyFromEnv(env: Env): ToncenterConfig | null {
  if (env.TON_WATCH_HISTORY === undefined) return null;
  oneOf("TON_WATCH_HISTORY", env.TON_WATCH_HISTORY, HISTORY_SOURCES);
  return {
    mode: oneOf("TON_WATCH_HISTORY_MODE", env.TON_WATCH_HISTORY_MODE ?? "fallback", HISTORY_MODES),
    apiKey: env.TON_WATCH_TONCENTER_API_KEY,
    endpoint: env.TON_WATCH_TONCENTER_ENDPOINT,
  };
}

export function logLevelFromEnv(env: Env): LogLevel {
  const level = env.TON_WATCH_LOG || "info";
  if (!isLogLevel(level)) throw new Error(`invalid TON_WATCH_LOG: ${level}`);
  return level;
}

/** `now`, `earliest` or an lt, as given to `add --from` and in `TON_WATCH_ADDRESSES`. */
export function parseFrom(value: string | undefined): AddAddressOptions["from"] {
  if (!value || value === "now") return "now";
  if (value === "earliest") return "earliest";
  if (/^\d+$/.test(value)) return BigInt(value);
  throw new Error(`invalid --from value: ${value} (now | earliest | <lt>)`);
}

/**
 * `addr1,addr2@earliest,addr3@<lt>`: comma-separated, each optionally `@<from>`.
 * Addresses are validated here and returned raw.
 */
function parseAddressList(list: string): ServiceConfig["addresses"] {
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [address = "", from] = entry.split("@");
      return { address: parseListedAddress(address), from: parseFrom(from) };
    });
}

function parseListedAddress(address: string): string {
  try {
    return toRawAddress(address);
  } catch {
    throw new Error(`invalid TON_WATCH_ADDRESSES: ${address || "(empty)"} is not an address`);
  }
}
