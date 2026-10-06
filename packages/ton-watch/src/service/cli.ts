import { Pool } from "pg";

import { toRawAddress } from "../core/address";
import type { HistoryOptions } from "../source/history";
import { LiteSource } from "../source/liteserver/lite-source";
import { PgStore } from "../stores/pg/pg-store";
import { TonWatch } from "../ton-watch";
import { consoleLogger, type Logger } from "../util/logger";
import { configFromEnv, parseFrom, type ServiceConfig, type ToncenterConfig } from "./config";
import { startHttpServer, toJson } from "./http-server";

const PG_POOL_SIZE = 20;
/** A graceful stop that takes longer than this exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/** Runs a `ton-watch` command (`run`, `add`, `remove`, `list`). */
export async function main(argv: string[], env: Record<string, string | undefined>) {
  const [command = "run", ...args] = argv;
  const config = configFromEnv(env);
  const logger = consoleLogger(config.logLevel);

  const pool = new Pool({ connectionString: config.databaseUrl, max: PG_POOL_SIZE });
  pool.on("error", (error) => logger.error("postgres pool error:", error.message));
  const store = new PgStore(pool, { schema: config.schema, onClose: () => pool.end() });
  const source = await LiteSource.connect({
    servers: config.network,
    archiveServers: config.archiveNetwork,
    logger,
  });
  const history = config.history ? await toncenterHistory(config.history) : undefined;
  if (history) logger.info(`history plug-in: toncenter (${history.mode})`);

  const watch = new TonWatch({
    history,
    store,
    source,
    logger,
    concurrency: config.concurrency,
    detect: config.detect,
  });
  await watch.init();

  switch (command) {
    case "add": {
      const [address, flag, value] = args;
      if (!address) throw new Error("usage: ton-watch add <address> [--from now|genesis|<lt>]");
      const from = flag === "--from" ? parseFrom(value) : "now";
      const rawAddress = await watch.addAddress(address, { from });
      logger.info(`watching ${rawAddress}`);
      return exitAfter(watch);
    }
    case "remove": {
      const [address, flag] = args;
      if (!address) throw new Error("usage: ton-watch remove <address> [--purge]");
      await watch.removeAddress(address, { purge: flag === "--purge" });
      return exitAfter(watch);
    }
    case "list":
      console.log(toJson(await watch.addresses()));
      return exitAfter(watch);
    case "run":
      return run(watch, source, config, logger);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

/** Indexes until SIGINT/SIGTERM, serving health and metrics over HTTP. */
async function run(watch: TonWatch, source: LiteSource, config: ServiceConfig, logger: Logger) {
  const known = new Set((await watch.addresses()).map((state) => state.address));
  for (const { address, from } of config.addresses) {
    if (known.has(toRawAddress(address))) continue;
    await watch.addAddress(address, { from });
    logger.info(`added ${address} from ${from}`);
  }

  await watch.start();
  logger.info(`indexing ${(await watch.addresses()).length} address(es)`);

  const server =
    config.port > 0 ? startHttpServer(watch, () => source.pool.stats(), config.port, logger) : null;

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
    await watch.stop();
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
