import type { Server } from "node:http";
import { Pool } from "pg";

import { Consumer } from "../consumer/consumer";
import { errorMessage } from "../core/errors";
import { Metrics } from "../metrics/metrics";
import type { HistoryOptions } from "../source/history";
import { LiteSource } from "../source/liteserver/lite-source";
import { PgStore } from "../stores/pg/pg-store";
import { TonWatch } from "../ton-watch";
import { consoleLogger, type Logger } from "../util/logger";
import { isConsumerCommand, parseCommand } from "./commands";
import { configFromEnv, type ServiceConfig, type ToncenterConfig } from "./config";
import { replayableSpec, runConsumerCommand } from "./consumer-admin";
import { type ServiceProbe, startHttpServer } from "./http-server";
import { addressListResponse, toJson } from "./output";
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
    addressMetrics: config.addressMetrics,
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
      console.log(toJson(addressListResponse(await watch.addresses())));
      return exitAfter(watch);
    case "run":
      return run(watch, source, config, logger);
  }
}

/**
 * Indexes until SIGINT/SIGTERM, delivers to the configured webhooks, and serves
 * health and metrics over HTTP. The HTTP port is bound before any work starts,
 * so a port in use fails the command instead of crashing a running service.
 */
async function run(watch: TonWatch, source: LiteSource, config: ServiceConfig, logger: Logger) {
  const known = new Set((await watch.addresses()).map((state) => state.address));
  for (const { address, from } of config.addresses) {
    if (known.has(address)) continue;
    await watch.addAddress(address, { from });
    logger.info(`added ${address} from ${from}`);
  }

  const webhooks = startingWebhooks(config, logger).map((spec) =>
    watch.process(spec.name, spec.handler, spec.options),
  );
  const probe = indexerProbe(watch, () => source.stats(), webhooks);
  const server = await listenOrStop(probe, config, logger, () => watch.close());
  try {
    await watch.start();
  } catch (error) {
    await closeServer(server);
    await watch.close();
    throw error;
  }
  logger.info(`indexing ${(await watch.addresses()).length} address(es)`);
  stopOnSignal(() => watch.close(), server, logger);
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
  const stop = async () => {
    await Promise.all(webhooks.map((consumer) => consumer.stop()));
    await store.close();
  };
  const probe = deliveryProbe(metrics, webhooks, store);
  const server = await listenOrStop(probe, config, logger, stop);
  try {
    await Promise.all(webhooks.map((consumer) => consumer.start().ready()));
  } catch (error) {
    await closeServer(server);
    await stop();
    throw error;
  }
  stopOnSignal(stop, server, logger);
}

/**
 * Starts the HTTP server unless `config.port` is 0. If it cannot listen, runs
 * `stop` (releasing what was opened so far) and rethrows.
 */
async function listenOrStop(
  probe: ServiceProbe,
  config: ServiceConfig,
  logger: Logger,
  stop: () => Promise<void>,
): Promise<Server | null> {
  if (config.port === 0) return null;
  try {
    return await startHttpServer(probe, config.port, logger);
  } catch (error) {
    await stop();
    throw error;
  }
}

function closeServer(server: Server | null): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

function webhookSpecs(config: ServiceConfig): WebhookConsumerSpec[] {
  return config.webhooks.map((target) => webhookConsumerSpec(target, {}));
}

/** The webhook consumers to start, logging what each delivers. */
function startingWebhooks(config: ServiceConfig, logger: Logger): WebhookConsumerSpec[] {
  for (const target of config.webhooks) {
    if (target.secrets.length === 0) {
      logger.warn(`webhook ${target.name}: no secret, requests are unsigned`);
    }
    logger.info(
      `delivering to webhook ${target.name} (${target.order} order, on error ${target.onError}) as ${webhookConsumerName(target)}`,
    );
  }
  return webhookSpecs(config);
}

/**
 * Stops gracefully on SIGINT/SIGTERM, then exits 0. Exits 1 if the stop fails or
 * takes longer than `SHUTDOWN_TIMEOUT_MS`; a second signal exits 1 at once.
 */
function stopOnSignal(stop: () => Promise<void>, server: Server | null, logger: Logger): void {
  const signals = ["SIGINT", "SIGTERM"] as const;
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      logger.warn(`${signal} while stopping: exiting now`);
      process.exit(1);
      return;
    }
    stopping = true;
    void shutdown(signal);
  };
  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info(`${signal}: stopping…`);
    const forceExit = setTimeout(() => {
      logger.error("graceful stop timed out, exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    let code = 0;
    try {
      server?.close();
      await stop();
    } catch (error) {
      logger.error("stop failed:", errorMessage(error));
      code = 1;
    }
    clearTimeout(forceExit);
    for (const name of signals) process.off(name, onSignal);
    process.exit(code);
  };
  for (const name of signals) process.on(name, onSignal);
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
  await watch.close();
  process.exit(0);
}
