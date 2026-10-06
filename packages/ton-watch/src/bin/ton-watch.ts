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
import { errorMessage } from "../core/errors";
import { main } from "../service/cli";
import { consoleLogger } from "../util/logger";

main(process.argv.slice(2), process.env).catch((error) => {
  consoleLogger("error").error(errorMessage(error));
  process.exit(1);
});
