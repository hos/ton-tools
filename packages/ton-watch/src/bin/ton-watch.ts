#!/usr/bin/env bun
/**
 * Long-running ton-watch service and address management CLI.
 *
 *   ton-watch run                          index until SIGINT/SIGTERM
 *   ton-watch add <address> [--from now|genesis|<lt>]
 *   ton-watch remove <address> [--purge]
 *   ton-watch list
 *
 * Configuration (env):
 *   DATABASE_URL            Postgres connection string (required)
 *   TON_WATCH_SCHEMA        Postgres schema, default "ton_watch"
 *   TON_NETWORK             mainnet | testnet | <global config URL>, default mainnet
 *                           (TON_NETWORK_CONFIG_URL is accepted as an alias)
 *   TON_ARCHIVE_CONFIG      config URL listing archival liteservers (optional)
 *   TON_WATCH_ADDRESSES     comma-separated addresses to ensure on start, each
 *                           optionally "<address>@<now|genesis|lt>" (default now)
 *   TON_WATCH_PORT          health/metrics HTTP port, default 9464 (0 disables)
 *   TON_WATCH_CONCURRENCY   pages in flight, default 16
 *   TON_WATCH_DETECT        poll | blocks | auto, default auto
 *   TON_WATCH_LOG           debug | info | warn | error, default info
 *   TON_WATCH_HISTORY       "toncenter" to enable the toncenter history plug-in (off by default)
 *   TON_WATCH_HISTORY_MODE  fallback (default: only history liteservers pruned) | boost
 *   TONCENTER_API_KEY       optional; raises toncenter's limit from 1 to 10+ requests/s
 *   TONCENTER_ENDPOINT      default https://toncenter.com/api/v2
 */
import { createServer } from "node:http";
import type { ServerDefinition } from "@ton/ls";
import { Pool } from "pg";
import type { DetectMode } from "../indexer";
import { logger } from "../logger";
import { LiteSource } from "../source/lite-source";
import { PgStore } from "../stores/pg/pg-store";
import { type AddAddressOptions, TonWatch } from "../watch";

const env = process.env;

function parseFrom(v: string | undefined): AddAddressOptions["from"] {
  if (!v || v === "now") return "now";
  if (v === "genesis") return "genesis";
  if (/^\d+$/.test(v)) return BigInt(v);
  throw new Error(`invalid --from value: ${v} (now | genesis | <lt>)`);
}

const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main() {
  const [command = "run", ...args] = process.argv.slice(2);
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 20 });
  pool.on("error", (e) => logger.error("postgres pool error:", e.message));
  const store = new PgStore(pool, { schema: env.TON_WATCH_SCHEMA, onClose: () => pool.end() });

  const network = (env.TON_NETWORK ?? env.TON_NETWORK_CONFIG_URL ?? "mainnet") as ServerDefinition;
  const source = await LiteSource.connect({
    servers: network,
    archiveServers: env.TON_ARCHIVE_CONFIG as ServerDefinition | undefined,
    logger,
  });

  const history =
    env.TON_WATCH_HISTORY === "toncenter"
      ? {
          source: new (await import("../toncenter")).ToncenterHistory({
            apiKey: env.TONCENTER_API_KEY,
            endpoint: env.TONCENTER_ENDPOINT,
          }),
          mode: (env.TON_WATCH_HISTORY_MODE as "fallback" | "boost" | undefined) ?? "fallback",
        }
      : undefined;
  if (history) logger.info(`history plug-in: toncenter (${history.mode})`);

  const watch = new TonWatch({
    history,
    store,
    source,
    logger,
    concurrency: Number(env.TON_WATCH_CONCURRENCY ?? 16),
    detect: (env.TON_WATCH_DETECT as DetectMode | undefined) ?? "auto",
  });
  await watch.init();

  switch (command) {
    case "add": {
      const [address, flag, value] = args;
      if (!address) throw new Error("usage: ton-watch add <address> [--from now|genesis|<lt>]");
      const raw = await watch.addAddress(address, {
        from: flag === "--from" ? parseFrom(value) : "now",
      });
      logger.info(`watching ${raw}`);
      await watch.stop();
      process.exit(0);
    }
    case "remove": {
      const [address, flag] = args;
      if (!address) throw new Error("usage: ton-watch remove <address> [--purge]");
      await watch.removeAddress(address, { purge: flag === "--purge" });
      await watch.stop();
      process.exit(0);
    }
    case "list": {
      console.log(json(await watch.addresses()));
      await watch.stop();
      process.exit(0);
    }
    case "run":
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }

  const known = new Set((await watch.addresses()).map((s) => s.address));
  for (const entry of (env.TON_WATCH_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [address, from] = entry.split("@");
    const { toRaw } = await import("../watch");
    if (known.has(toRaw(address!))) continue;
    await watch.addAddress(address!, { from: parseFrom(from) });
    logger.info(`added ${address} from ${from ?? "now"}`);
  }

  await watch.start();
  logger.info(`indexing ${(await watch.addresses()).length} address(es)`);

  const port = Number(env.TON_WATCH_PORT ?? 9464);
  const server =
    port > 0
      ? createServer((req, res) => {
          if (req.url === "/metrics") {
            res.setHeader("content-type", "text/plain; version=0.0.4");
            res.end(watch.metrics.toPrometheus());
          } else if (req.url === "/health") {
            const h = watch.health();
            res.statusCode = h.status === "down" ? 503 : 200;
            res.setHeader("content-type", "application/json");
            res.end(json(h));
          } else if (req.url === "/status") {
            res.setHeader("content-type", "application/json");
            res.end(json({ addresses: watch.status(), servers: source.pool.stats() }));
          } else {
            res.statusCode = 404;
            res.end();
          }
        }).listen(port, () => logger.info(`health on :${port}/health, metrics on :${port}/metrics`))
      : null;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal}: stopping…`);
    const force = setTimeout(() => {
      logger.error("graceful stop timed out, exiting");
      process.exit(1);
    }, 30_000);
    server?.close();
    await watch.stop();
    clearTimeout(force);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
