#!/usr/bin/env bun
/**
 * Long-running ton-watch service and address management CLI.
 *
 *   ton-watch run                          index (and deliver webhooks) until SIGINT/SIGTERM
 *   ton-watch deliver                      deliver webhooks only, without indexing
 *   ton-watch add <address> [--from now|earliest|<lt>]
 *   ton-watch remove <address> [--purge]
 *   ton-watch list
 *
 * Consumer management (database only, no liteserver connection):
 *   ton-watch consumers                    every consumer with order, lag and dead letters (JSON)
 *   ton-watch rewind <consumer> <earliest|now|lt> [--address <address>]...
 *   ton-watch dead-letters [<consumer>]    dead letters (JSON)
 *   ton-watch replay <consumer> <address> <lt>   re-send a webhook dead letter, then delete it
 *   ton-watch discard <consumer> <address> <lt>  delete a dead letter without re-sending it
 *   ton-watch delete-consumer <consumer>
 *
 * Configuration comes from the environment: every variable, its default and
 * meaning are listed once, in `ENV_VARS` (src/service/env.ts). The essentials:
 *   TON_WATCH_DATABASE_URL  Postgres connection string (required; DATABASE_URL is the fallback)
 *   TON_WATCH_NETWORK       mainnet | testnet | <global config URL>, default mainnet
 *   TON_WATCH_ADDRESSES     addresses to ensure on start: addr[@now|earliest|<lt>],...
 *   TON_WATCH_WEBHOOK_URL   deliver every transaction to this URL (see README "Webhooks")
 */
import { errorMessage } from "../core/errors";
import { main } from "../service/cli";
import { consoleLogger } from "../util/logger";

main(process.argv.slice(2), process.env).catch((error) => {
  consoleLogger("error").error(errorMessage(error));
  process.exit(1);
});
