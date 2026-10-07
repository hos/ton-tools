# Running the service

[← @ton/watch](../README.md)

The `ton-watch` command: configuration, HTTP endpoints and the consumer commands. Webhooks and metrics have their own pages.

`ton-watch run` runs the indexer, and delivers to the
configured [webhooks](webhooks.md), until SIGINT/SIGTERM, then `close()`s: requests in
flight get 5s, webhook deliveries in progress finish, and it exits (0; 1 if stopping
fails or takes over 30s; a second signal exits 1 at once). Configuration is validated before connecting to anything. The HTTP port is
bound before any work starts, so a port in use exits 1 right away. It never drops
data: schema changes are versioned, append-only migrations
(`<schema>.schema_migrations`); see [docs/migrations.md](migrations.md) for
the rules and what happens during a rolling deploy.

```sh
TON_WATCH_DATABASE_URL=postgres://… ton-watch run
ton-watch deliver                       # webhooks only, no indexing (see below)
ton-watch add <address> [--from now|earliest|<lt>]
ton-watch remove <address> [--purge]
ton-watch list                          # JSON (stable, see below)
ton-watch consumers                     # and other consumer commands (below)
```

## Running the service

JSR packages have no `bin`, so `ton-watch` is a one-line file in your project
that hands the command line to `@ton/watch/cli`:

```ts
// ton-watch.ts
import { run } from "@ton/watch/cli";

await run();
```

```sh
TON_WATCH_DATABASE_URL=postgres://… bun run ton-watch.ts run
bun run ton-watch.ts add EQ… --from now
```

`run(argv?, env?)` defaults to `process.argv.slice(2)` and `process.env`. In a
checkout of this repository: `bun run start` (= `ton-watch run`) and
`bun run cli <command>`. Below, `ton-watch` stands for either.

## Configuration

Every setting is an environment variable prefixed `TON_WATCH_`. An empty value
counts as unset. The full list (the source of truth is `ENV_VARS` in
[`src/service/env.ts`](../src/service/env.ts)):

| env | default | |
|---|---|---|
| `TON_WATCH_DATABASE_URL` | — | Postgres connection string; required |
| `DATABASE_URL` | — | used when `TON_WATCH_DATABASE_URL` is unset |
| `TON_WATCH_SCHEMA` | `ton_watch` | Postgres schema for all tables |
| `TON_WATCH_NETWORK` | `mainnet` | `mainnet`, `testnet` or a global config URL |
| `TON_WATCH_ARCHIVE_NETWORK` | — | global config URL listing archival liteservers, used only for history the others pruned |
| `TON_WATCH_ADDRESSES` | — | `addr[@now\|earliest\|<lt>],…` added on start if missing (default `now`); checked at startup |
| `TON_WATCH_PORT` | `9464` | HTTP port of `/health`, `/metrics`, `/status`, `/consumers`; `0` disables it |
| `TON_WATCH_CONCURRENCY` | `16` | liteserver pages in flight |
| `TON_WATCH_DETECT` | `auto` | `poll`, `blocks` or `auto` |
| `TON_WATCH_LOG` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `TON_WATCH_ADDRESS_METRICS` | `false` | `true` exports per-address gauges (one series per address) |
| `TON_WATCH_HISTORY` | — | `toncenter` enables the [toncenter plug-in](liteservers.md#optional-toncenter-history-plug-in-experimental) (experimental) |
| `TON_WATCH_HISTORY_MODE` | `fallback` | `fallback` or `boost` |
| `TON_WATCH_TONCENTER_API_KEY` | — | toncenter API key; raises its limit from 1 to 10+ requests/s |
| `TON_WATCH_TONCENTER_ENDPOINT` | `https://toncenter.com/api/v2` | toncenter API v2 endpoint |

Webhook variables (`TON_WATCH_WEBHOOK_*`) are listed under [Webhooks](webhooks.md).

## HTTP endpoints

Served on `TON_WATCH_PORT` by `run` and `deliver`. They answer GET and HEAD (other
methods get 405) and ignore query strings.

| path | | stability |
|---|---|---|
| `/health` | JSON, 200, or 503 when `status` is `down` | stable (`version: 1`) |
| `/consumers` | JSON: every consumer in the database, same as `ton-watch consumers`; 500 if the query fails | stable (`version: 1`) |
| `/metrics` | Prometheus text format 0.0.4 | stable [metric names and labels](metrics.md) |
| `/status` | JSON debugging view: per-address progress, liteservers, webhook consumers | **unstable**, may change in any release |

```jsonc
// GET /health
{
  "version": 1,
  "status": "degraded",                 // worst of the components: ok | degraded | down
  "reasons": ["webhook:billing: retrying 0:83df…: webhook billing: HTTP 503"],
  "components": {
    "indexer": {                        // null under `deliver`, which does not index
      "status": "ok", "reasons": [], "running": true,
      "tip": { "seqno": 51234567, "utime": 1791300482, "ageSeconds": 3 },
      "addresses": 12, "maxLagSeconds": 4, "gapsOpen": 0, "stuckRanges": 0,
      "txWrittenPerSecond": 1.5
    },
    "webhooks": [
      { "name": "webhook:billing", "status": "degraded", "reasons": ["retrying 0:83df…: webhook billing: HTTP 503"],
        "running": true, "waitingForLock": false, "retrying": 1 }
    ]
  }
}
```

The indexer is `degraded` when an address lags more than 120s or a range is not
served by any liteserver, and `down` when not running or without a successful tick
for 60s. A webhook consumer is `degraded` while an address is retrying a failed
request and `down` when not running (e.g. waiting for its lock).

**Stable JSON** — `/health`, `/consumers`, and the output of `ton-watch list`,
`consumers` and `dead-letters` — carries `"version": 1`. Fields may be added in any
release; removing, renaming or changing the meaning of one bumps `version`. Readers
must ignore fields and enum values they do not know. In all of them, lts are
decimal strings, hashes lowercase hex, times ISO 8601 strings (unix seconds where
the field says `utime`), addresses lowercase raw.

## Managing consumers from the CLI

These commands need only the database — no liteserver connection — so they can
run next to a live service. Arguments are checked before connecting.

```sh
ton-watch consumers                                   # JSON: name, order, createdAt, addresses, failing, lag, deadLetters
ton-watch rewind <consumer> <earliest|now|lt> [--address <address>]...
ton-watch dead-letters [<consumer>]                   # JSON, oldest first
ton-watch replay <consumer> <address> <lt>            # send a dead letter again, then delete it
ton-watch discard <consumer> <address> <lt>           # delete a dead letter without sending it
ton-watch delete-consumer <consumer>                  # record, cursors and dead letters
```

`lag` in `consumers` is the backlog described in [Managing
consumers](consumers.md#managing-consumers) (`transactions` summed, `lt` and `seconds` the
maximum over the addresses); `failing` counts addresses whose next transaction has
failed at least once.

`rewind` and `delete-consumer` change a consumer's position, so they are refused
with `CONSUMER_LOCKED` while it runs anywhere: stop the service (or the `deliver`
process) first, then start it again. `replay` and `discard` work while it runs.
`replay` needs the consumer's handler, which the CLI has only for the configured
[webhook](webhooks.md) targets (`webhook:<name>`, with the same webhook variables as
the service); replay your own consumers with `consumer.replayDeadLetter()` in the
process that runs them. A failed replay keeps the dead letter, with the new error,
and exits 1.
