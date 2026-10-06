#!/usr/bin/env bun
/**
 * Long-running ton-watch service and address management CLI.
 *
 *   ton-watch run                          index (and deliver webhooks) until SIGINT/SIGTERM
 *   ton-watch deliver                      deliver webhooks only, without indexing
 *   ton-watch add <address> [--from now|genesis|<lt>]
 *   ton-watch remove <address> [--purge]
 *   ton-watch list
 *
 * Consumer management (database only, no liteserver connection):
 *   ton-watch consumers                    every consumer with order, lag and dead letters (JSON)
 *   ton-watch rewind <consumer> <start|now|lt> [--address <address>]...
 *   ton-watch dead-letters [<consumer>]    dead letters (JSON)
 *   ton-watch replay <consumer> <address> <lt>   re-send a webhook dead letter, then delete it
 *   ton-watch discard <consumer> <address> <lt>  delete a dead letter without re-sending it
 *   ton-watch delete-consumer <consumer>
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
 *
 * Webhooks (see README "Webhooks"):
 *   TON_WATCH_WEBHOOK_URL   one target, named "default"
 *   TON_WATCH_WEBHOOKS      JSON array of named targets: {name, url, secret?, addresses?,
 *                           order?, from?, timeoutMs?, retryMinMs?, retryMaxMs?,
 *                           onError?, maxAttempts?}; "secret": null sends unsigned
 *   TON_WATCH_WEBHOOK_SECRET          HMAC-SHA256 signing secret (default for all targets)
 *   TON_WATCH_WEBHOOK_ORDER           address | global, default address
 *   TON_WATCH_WEBHOOK_FROM            start | now | <lt>, default start (first run only)
 *   TON_WATCH_WEBHOOK_TIMEOUT_MS      per request, default 10000
 *   TON_WATCH_WEBHOOK_RETRY_MIN_MS    first retry delay, default 1000 (doubles per failure)
 *   TON_WATCH_WEBHOOK_RETRY_MAX_MS    longest retry delay, default 60000
 *   TON_WATCH_WEBHOOK_ON_ERROR        retry (default) | skip | dead-letter, for a transaction
 *                                     the receiver keeps refusing (a 3xx/4xx at once)
 *   TON_WATCH_WEBHOOK_MAX_ATTEMPTS    failed requests before skip/dead-letter, default 5
 */
import { errorMessage } from "../core/errors";
import { main } from "../service/cli";
import { consoleLogger } from "../util/logger";

main(process.argv.slice(2), process.env).catch((error) => {
  consoleLogger("error").error(errorMessage(error));
  process.exit(1);
});
