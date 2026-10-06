import type { Server } from "node:http";
import { Pool } from "pg";

import { Consumer } from "../consumer/consumer";
import { toRawAddress } from "../core/address";
import { Metrics } from "../metrics/metrics";
import type { HistoryOptions } from "../source/history";
import { LiteSource } from "../source/liteserver/lite-source";
import { PgStore } from "../stores/pg/pg-store";
import { TonWatch } from "../ton-watch";
import { consoleLogger, type Logger } from "../util/logger";
import { isConsumerCommand, parseCommand } from "./commands";
import { configFromEnv, type ServiceConfig, type ToncenterConfig } from "./config";
import { replayableSpec, runConsumerCommand } from "./consumer-admin";
import { startHttpServer, toJson } from "./http-server";
import { deliveryProbe, indexerProbe } from "./probes";
import {
  type WebhookConsumerSpec,
  webhookConsumerName,
  webhookConsumerSpec,
} from "./webhook/consumers";

const PG_POOL_SIZE = 20;
/** A graceful stop that takes longer than this exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Runs a `ton-watch` command (see `commands.ts`). Arguments and configuration are
 * validated before connecting to anything.
 */
export async function main(argv: string[], env: Record<string, string | undefined>) {
  const command = parseCommand(argv);
  const config = configFromEnv(env);
  if (command.name === "deliver" && config.webhooks.length === 0) {
    throw new Error("deliver needs TON_WATCH_WEBHOOK_URL or TON_WATCH_WEBHOOKS");
  }
  const logger = consoleLogger(config.logLevel);
  // Only a configured webhook target can be replayed: say so before connecting.
  if (command.name === "replay") replayableSpec(command.consumer, webhookSpecs(config));

  const pool = new Pool({ connectionString: config.databaseUrl, max: PG_POOL_SIZE });
  pool.on("error", (error) => logger.error("postgres pool error:", error.message));
  const store = new PgStore(pool, { schema: config.schema, onClose: () => pool.end() });
  if (command.name === "deliver") return deliver(store, config, logger);
  if (isConsumerCommand(command)) {
    try {
      await store.migrate();
      await runConsumerCommand(command, { store, webhooks: webhookSpecs(config), logger });
    } finally {
      await store.close();
    }
    return process.exit(0);
  }

  const source = await LiteSource.connect({
    servers: config.network,
    archiveServers: config.archiveNetwork,
    logger,
  });
  const history = config.history ? await toncenterHistory(config.history) : undefined;
  if (history) logger.info(`history plug-in: toncenter (${history.mode}, experimental)`);

  const watch = new TonWatch({
    history,
    store,
    source,
    logger,
    concurrency: config.concurrency,
    detect: config.detect,
  });
  await watch.init();

  switch (command.name) {
    case "add": {
      const rawAddress = await watch.addAddress(command.address, { from: command.from });
      logger.info(`watching ${rawAddress}`);
      return exitAfter(watch);
    }
    case "remove":
      await watch.removeAddress(command.address, { purge: command.purge });
      return exitAfter(watch);
    case "list":
      console.log(toJson(await watch.addresses()));
      return exitAfter(watch);
    case "run":
      return run(watch, source, config, logger);
  }
}

/**
 * Indexes until SIGINT/SIGTERM, delivers to the configured webhooks, and serves
 * health and metrics over HTTP.
 */
async function run(watch: TonWatch, source: LiteSource, config: ServiceConfig, logger: Logger) {
  const known = new Set((await watch.addresses()).map((state) => state.address));
  for (const { address, from } of config.addresses) {
    if (known.has(toRawAddress(address))) continue;
    await watch.addAddress(address, { from });
    logger.info(`added ${address} from ${from}`);
  }

  const webhooks = startingWebhooks(config, logger).map((spec) =>
    watch.process(spec.name, spec.handler, spec.options),
  );
  await watch.start();
  logger.info(`indexing ${(await watch.addresses()).length} address(es)`);

  const probe = indexerProbe(watch, () => source.pool.stats(), webhooks);
  const server = config.port > 0 ? startHttpServer(probe, config.port, logger) : null;
  stopOnSignal(() => watch.stop(), server, logger);
}

/**
 * Delivers to the configured webhooks without indexing, so delivery can run and
 * scale apart from the indexer. Needs no liteserver connection; consumers poll
 * the store since no indexer events reach this process. Rejects with
 * `ConsumerLockedError` (and delivers nothing) if a target runs elsewhere.
 */
async function deliver(store: PgStore, config: ServiceConfig, logger: Logger) {
  await store.migrate();
  const metrics = new Metrics();
  const webhooks = startingWebhooks(config, logger).map(
    (spec) => new Consumer(spec.name, store, spec.handler, spec.options, { logger, metrics }),
  );
  try {
    await Promise.all(webhooks.map((consumer) => consumer.start().ready()));
  } catch (error) {
    await Promise.all(webhooks.map((consumer) => consumer.stop()));
    await store.close();
    throw error;
  }
  const probe = deliveryProbe(metrics, webhooks, store);
  const server = config.port > 0 ? startHttpServer(probe, config.port, logger) : null;
  stopOnSignal(
    async () => {
      await Promise.all(webhooks.map((consumer) => consumer.stop()));
      await store.close();
    },
    server,
    logger,
  );
}

function webhookSpecs(config: ServiceConfig): WebhookConsumerSpec[] {
  const testOnly = config.network === "testnet";
  return config.webhooks.map((target) => webhookConsumerSpec(target, { testOnly }));
}

/** The webhook consumers to start, logging what each delivers. */
function startingWebhooks(config: ServiceConfig, logger: Logger): WebhookConsumerSpec[] {
  for (const target of config.webhooks) {
    if (target.secret === null) {
      logger.warn(`webhook ${target.name}: no secret, requests are unsigned`);
    }
    logger.info(
      `delivering to webhook ${target.name} (${target.order} order, on error ${target.onError}) as ${webhookConsumerName(target)}`,
    );
  }
  return webhookSpecs(config);
}

/** Stops gracefully on SIGINT/SIGTERM, then exits; a second signal is ignored. */
function stopOnSignal(stop: () => Promise<void>, server: Server | null, logger: Logger): void {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal}: stopping…`);
    const forceExit = setTimeout(() => {
      logger.error("graceful stop timed out, exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    server?.close();
    await stop();
    clearTimeout(forceExit);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function toncenterHistory(config: ToncenterConfig): Promise<Required<HistoryOptions>> {
  // Loaded only when enabled: the core never depends on the plug-in.
  const { ToncenterHistory } = await import("../plugins/toncenter");
  return {
    source: new ToncenterHistory({ apiKey: config.apiKey, endpoint: config.endpoint }),
    mode: config.mode,
    enabled: true,
  };
}

/** One-shot commands: close connections and exit. */
async function exitAfter(watch: TonWatch): Promise<never> {
  await watch.stop();
  process.exit(0);
}
