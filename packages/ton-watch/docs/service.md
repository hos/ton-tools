# Running ton-watch as a service

The `ton-watch` command: indexing into Postgres, webhooks, the HTTP endpoints, metrics and the consumer commands. For a first look, start with the [README](../README.md).

## Service

`ton-watch run` runs the indexer, and delivers to the
configured [webhooks](#webhooks), until SIGINT/SIGTERM, then `close()`s: requests in
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

### Running the service

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

### Configuration

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
| `TON_WATCH_HISTORY` | — | `toncenter` enables the [toncenter plug-in](operations.md#optional-toncenter-history-plug-in-experimental) (experimental) |
| `TON_WATCH_HISTORY_MODE` | `fallback` | `fallback` or `boost` |
| `TON_WATCH_TONCENTER_API_KEY` | — | toncenter API key; raises its limit from 1 to 10+ requests/s |
| `TON_WATCH_TONCENTER_ENDPOINT` | `https://toncenter.com/api/v2` | toncenter API v2 endpoint |

Webhook variables (`TON_WATCH_WEBHOOK_*`) are listed under [Webhooks](#webhooks).

### HTTP endpoints

Served on `TON_WATCH_PORT` by `run` and `deliver`. They answer GET and HEAD (other
methods get 405) and ignore query strings.

| path | | stability |
|---|---|---|
| `/health` | JSON, 200, or 503 when `status` is `down` | stable (`version: 1`) |
| `/consumers` | JSON: every consumer in the database, same as `ton-watch consumers`; 500 if the query fails | stable (`version: 1`) |
| `/metrics` | Prometheus text format 0.0.4 | stable [metric names and labels](#metrics) |
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

### Managing consumers from the CLI

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
consumers](library.md#managing-consumers) (`transactions` summed, `lt` and `seconds` the
maximum over the addresses); `failing` counts addresses whose next transaction has
failed at least once.

`rewind` and `delete-consumer` change a consumer's position, so they are refused
with `CONSUMER_LOCKED` while it runs anywhere: stop the service (or the `deliver`
process) first, then start it again. `replay` and `discard` work while it runs.
`replay` needs the consumer's handler, which the CLI has only for the configured
[webhook](#webhooks) targets (`webhook:<name>`, with the same webhook variables as
the service); replay your own consumers with `consumer.replayDeadLetter()` in the
process that runs them. A failed replay keeps the dead letter, with the new error,
and exits 1.

### Webhooks

The service POSTs every transaction of the watched addresses to one or more
HTTP endpoints. Each target is a [consumer](library.md#consumer-api) named
`webhook:<name>`, so delivery has the same guarantees: per address (or global)
chain order, never past a gap, position stored after each transaction and
resumed after a restart.

| env | default | |
|---|---|---|
| `TON_WATCH_WEBHOOK_URL` | — | one target, named `default` |
| `TON_WATCH_WEBHOOKS` | — | JSON array of named targets (below) |
| `TON_WATCH_WEBHOOK_SECRET` | — | HMAC-SHA256 signing secret for every target; unsigned when unset |
| `TON_WATCH_WEBHOOK_SECRET_PREVIOUS` | — | while [rotating](#rotating-the-secret): the previous secret, signed with as well |
| `TON_WATCH_WEBHOOK_ORDER` | `address` | `address` or `global` (see [ordering](library.md#consumer-api)) |
| `TON_WATCH_WEBHOOK_FROM` | `earliest` | first run only: `earliest` (all indexed history), `now` or an lt |
| `TON_WATCH_WEBHOOK_TIMEOUT_MS` | `10000` | per request |
| `TON_WATCH_WEBHOOK_RETRY_MIN_MS` | `1000` | first retry delay, doubling per failure… |
| `TON_WATCH_WEBHOOK_RETRY_MAX_MS` | `60000` | …up to this |
| `TON_WATCH_WEBHOOK_ON_ERROR` | `retry` | `retry`, `skip` or `dead-letter`: what happens to a transaction the receiver keeps refusing (below) |
| `TON_WATCH_WEBHOOK_MAX_ATTEMPTS` | `5` | failed requests before `skip` / `dead-letter` gives up |

The `TON_WATCH_WEBHOOK_*` settings are defaults for every target; a
`TON_WATCH_WEBHOOKS` entry can override them and restrict the addresses:

```sh
TON_WATCH_WEBHOOKS='[
  {"name": "billing", "url": "https://billing.example/ton", "addresses": ["EQ…", "0:…"]},
  {"name": "ledger", "url": "https://ledger.example/in", "order": "global", "secret": "…"}
]'
```

`name` (`[A-Za-z0-9._-]`, at most 64) is required and identifies the stored
position: renaming a target starts it over from `from`, changing its URL does
not. Other keys: `url`, `secret`, `addresses`, `order`, `from`, `timeoutMs`,
`retryMinMs`, `retryMaxMs`, `onError`, `maxAttempts`; unknown keys are rejected.
`secret` is a string, or an array of them (current first) while rotating;
`"secret": null` sends that target unsigned even when `TON_WATCH_WEBHOOK_SECRET` is
set. An empty secret is rejected, and so is a `retryMinMs` above the target's
`retryMaxMs`.

**Delivery.** One request per transaction. A 2xx response is a delivery; the
position advances only after it. Anything else halts that address (in global
order: the whole stream), is logged and reported on `/health` (`degraded`) and
`/status`, and the same transaction is retried with backoff. What happens when it
keeps failing is the target's `onError` (the [consumer
policy](library.md#failures)):

| `onError` | retryable failure: network error, timeout, 408, 429, 5xx | rejection: redirect, other 4xx |
|---|---|---|
| `retry` (default) | retried forever; nothing is skipped | retried forever |
| `skip` | skipped after `maxAttempts` failed requests | skipped at once |
| `dead-letter` | dead-lettered after `maxAttempts` failed requests | dead-lettered at once |

A rejection is the receiver saying the request itself is wrong, so sending it
again unchanged will not help. Dead letters are listed with `ton-watch
dead-letters`, sent again with `ton-watch replay` once the receiver is fixed, or
dropped with `ton-watch discard` (see [the CLI](#managing-consumers-from-the-cli)).

Over HTTP this is **at least once**: a request that times out may still have been
processed, and a crash after the receiver answered but before the position was
stored re-sends that transaction. Deduplicate on the `Idempotency-Key` header
(= `id` in the body), which is the same for every attempt.

**Request.** `POST` with `content-type: application/json`, `user-agent:
ton-watch/<version>` and these headers:

| header | |
|---|---|
| `Idempotency-Key` | the payload's `id`: `<raw address>:<lt>:<hex hash>` |
| `TON-Watch-Event` | the payload's `type` (`transaction`), to route before parsing |
| `TON-Watch-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=…]`, one `v1` per secret; only when a secret is set |
| `TON-Watch-Replay` | `1` on a replayed dead letter; absent otherwise |

**Payload, version 1** (`WebhookPayload` in `@ton/watch/webhook`). A real body, from
`tests/fixtures/golden/webhook-payload-ton-transfer-comment.json` (`boc` shortened):

```json
{
  "version": 1,
  "type": "transaction",
  "id": "0:852443f8599fe6a5da34fe43049ac4e0beb3071bb2bfb56635ea9421287c283a:108207748000020:47c766d5144f24f6945222f2885aa5038dae580b4c8bddaae0de58734236e8bc",
  "webhook": "default",
  "address": "0:852443f8599fe6a5da34fe43049ac4e0beb3071bb2bfb56635ea9421287c283a",
  "lt": "108207748000020",
  "hash": "47c766d5144f24f6945222f2885aa5038dae580b4c8bddaae0de58734236e8bc",
  "utime": 1791300482,
  "prev": {
    "lt": "108207746000012",
    "hash": "56fe46f45ef8a234d2055fdc2257c84d1974d57c65b2dd0c7118440f704b4f40"
  },
  "boc": "te6ccgECBwEAAbYAA7N4UkQ/hZn+al2jT+QwSaxOC+swcbsr…",
  "parsed": {
    "type": "generic",
    "success": true,
    "aborted": false,
    "compute": { "type": "vm", "success": true, "exitCode": 0, "gasUsed": "577" },
    "action": { "success": true, "resultCode": 0, "totalActions": 0, "skippedActions": 0 },
    "receivedBounce": false,
    "bouncedBack": false,
    "direction": "incoming",
    "inMessage": {
      "type": "internal",
      "src": "0:bb13003ac17ac2201a7124b7181d3b0c85fc54f254bc60c2eab319880047fc64",
      "dest": "0:852443f8599fe6a5da34fe43049ac4e0beb3071bb2bfb56635ea9421287c283a",
      "value": "962600000",
      "extraCurrencies": {},
      "bounce": false,
      "bounced": false,
      "fwdFee": "44446",
      "extraFlags": "0",
      "createdLt": "108207748000019",
      "createdAt": 1791300482,
      "op": 0,
      "queryId": null,
      "comment": "100 Telegram Stars \n\nRef#Ukt0LZIJA",
      "body": { "kind": "text-comment", "text": "100 Telegram Stars \n\nRef#Ukt0LZIJA" }
    },
    "outMessages": [],
    "totalFees": "38469",
    "valueIn": "962600000",
    "valueOut": "0"
  },
  "replay": false
}
```

Other golden bodies (jetton notification, NFT transfer, bounces) are in
[`tests/fixtures/golden/`](https://github.com/hos/ton-tools/tree/main/packages/ton-watch/tests/fixtures/golden). Encodings: lts and amounts
(nanotons, jetton units) are decimal strings; hashes lowercase hex; addresses
lowercase raw (`<workchain>:<hex>`); cells base64 BOCs, other binary data base64;
unix times, opcodes, exit codes and counts JSON numbers. `prev` is null for the
account's first transaction; `parsed` is null if the BOC could not be decoded. The
field names in `parsed` follow `ParsedTransaction` in [`@ton/watch/parse`](../src/parse/types.ts).

**Compatibility rules for receivers.**

- **Ignore fields you do not know.** New fields may appear in any object in any
  release without changing `version`.
- **Ignore event `type`s and body `kind`s you do not know**, and treat other
  enum-like strings (`direction`, the transaction `type`, …) as open sets too: new
  kinds of events, bodies or transactions may appear without changing `version`.
- `version` changes only when an existing field is removed, renamed or changes
  meaning, and only in a release announced as breaking.

A replay (`"replay": true`) arrives out of order — later transactions of the
address were delivered meanwhile — with the same `id` as the original attempts.
Deduplicate it like any other request: if an earlier attempt was processed after
all (e.g. one that timed out), answer 2xx without processing it again.

**Verifying the signature.** Compute the HMAC over the raw body bytes as received
(before any JSON parsing), compare in constant time, and reject old timestamps so
a captured request cannot be replayed later. Every retry is signed afresh, so a
five-minute window never rejects a legitimate retry. Pair it with the idempotency
key to drop replays inside the window. `@ton/watch/webhook` does all of this and
depends only on `node:crypto`:

```ts
import { SIGNATURE_HEADER, verifySignature, type WebhookPayload } from "@ton/watch/webhook";

// e.g. Bun.serve / fetch handlers:
const body = await request.text();
if (!verifySignature(SECRET, body, request.headers.get(SIGNATURE_HEADER))) {
  return new Response(null, { status: 401 });
}
const payload: WebhookPayload = JSON.parse(body);
if (payload.type !== "transaction") return new Response(null, { status: 204 }); // unknown event
```

`verifySignature(secrets, body, header, { toleranceSeconds = 300 })` takes one
secret or an array of them and is true if any `v1` signature in the header matches
any of them. Signature schemes other than `v1` are ignored.

#### Rotating the secret

1. Set `TON_WATCH_WEBHOOK_SECRET=<new>` and `TON_WATCH_WEBHOOK_SECRET_PREVIOUS=<old>`
   (per target: `"secret": ["<new>", "<old>"]`) and restart. Every request now
   carries two `v1` signatures, so receivers still on the old secret keep verifying.
2. Switch the receivers to the new secret (or have them accept both during the
   switch: `verifySignature([NEW, OLD], …)`).
3. Remove `TON_WATCH_WEBHOOK_SECRET_PREVIOUS` and restart.

**Delivery apart from indexing.** `ton-watch deliver` runs only the webhook
consumers: no liteserver connection, same database and webhook settings. Run the
indexer with no webhook variables and one `deliver` process next to it to
restart, deploy or scale delivery without touching indexing. A `deliver` process
learns about new transactions by polling the store (every second). Run each
target in one process at a time: `deliver` exits 1 with `CONSUMER_LOCKED` if
a target already runs elsewhere (and starts none of them). `/health` and
`/status` report the webhook consumers; `/metrics` their counters; `/consumers`
every consumer in the database.

### Metrics

`/metrics` (and `watch.metrics.toPrometheus()` in the library) exports exactly the
metrics below, each with `# HELP` and `# TYPE`; the list is `METRICS` in
[`src/metrics/registry.ts`](../src/metrics/registry.ts). Label values are bounded:
`method` and `where` take values from closed sets (anything else is `other`), and
`address` series exist only with the opt-in `addressMetrics` indexer option
(`TON_WATCH_ADDRESS_METRICS=true`), since with many addresses they multiply the
series Prometheus has to keep.

| metric | type | |
|---|---|---|
| `ton_watch_build_info{version}` | gauge | always 1; `version` is the running ton-watch version |
| `ton_watch_addresses` | gauge | addresses being indexed |
| `ton_watch_tip_seqno`, `ton_watch_tip_utime` | gauge | newest chain tip seen |
| `ton_watch_max_lag_seconds` | gauge | largest address lag: chain tip time minus the time the address was last known complete |
| `ton_watch_gaps_open` | gauge | missing ranges currently known |
| `ton_watch_walks`, `ton_watch_walks_stuck` | gauge | ranges being fetched / waiting for an archival server |
| `ton_watch_address_lag_seconds{address}` | gauge | per-address lag; **opt-in** (`addressMetrics`) |
| `ton_watch_address_gaps_open{address}` | gauge | per-address missing ranges; **opt-in** (`addressMetrics`) |
| `ton_watch_walks_started_total{kind}` | counter | walks started, `head` or `gap` |
| `ton_watch_pages_total{kind}` | counter | pages fetched and stored, by walk kind |
| `ton_watch_tx_written_total` | counter | transactions newly stored; use `rate()` for throughput |
| `ton_watch_splits_total`, `ton_watch_split_points_total` | counter | long walks split into parallel pieces / split points found |
| `ton_watch_detect_fallbacks_total` | counter | block listings that failed, so every address was polled instead |
| `ton_watch_reconcile_misses_total` | counter | transactions the block listing missed, found by reconciliation polling |
| `ton_watch_history_pages_total{source,why}` | counter | pages served by the history plug-in, `why` = `fallback` or `boost` |
| `ton_watch_source_calls_total{method}` | counter | chain calls by method |
| `ton_watch_errors_total{kind,where}` | counter | failures by `kind` (`rate_limit`, `timeout`, `archive_unavailable`, `not_ready`, `bad_response`, `network`, `unknown`) and where they happened |
| `ton_watch_consumer_delivered_total{consumer}` | counter | transactions handed to the handler and committed |
| `ton_watch_consumer_errors_total{consumer}` | counter | failed handler calls |
| `ton_watch_consumer_skipped_total{consumer}`, `ton_watch_consumer_dead_letters_total{consumer}` | counter | transactions given up on (`onError`) |
| `ton_watch_consumer_replayed_total{consumer}` | counter | dead letters replayed successfully |
| `ton_watch_consumer_lag_transactions{consumer}`, `ton_watch_consumer_lag_seconds{consumer}` | gauge | the consumer's backlog (see [Managing consumers](library.md#managing-consumers)) |
| `ton_watch_consumer_watermark_lt{consumer}` | gauge | global order: lt the stream is released up to (float64: use for `changes()`, not lt lookups) |
