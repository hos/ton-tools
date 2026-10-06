# ton-watch

Embeddable TON transaction indexer for an explicit set of addresses. Fetches each
address's transaction chain straight from liteservers — in any order, in parallel,
from any starting point — and hands transactions to your code **strictly in chain
order, never past a gap**.

It does not read historical account state and does not depend on scanning every
block in order, so an outage of days or weeks is a backlog to work through, not a
permanent jam.

```ts
import { Pool } from "pg";
import { LiteSource, PgStore, TonWatch } from "ton-watch";

const pool = new Pool({ connectionString: process.env.TON_WATCH_DATABASE_URL });
const watch = new TonWatch({
  store: new PgStore(pool, { onClose: () => pool.end() }), // or new MemoryStore()
  source: await LiteSource.connect({ servers: "mainnet" }),
});

await watch.addAddress("EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMS", { from: "now" });

watch.process("my-consumer", async (tx, ctx) => {
  // tx.address (raw), tx.lt, tx.hash, tx.utime, tx.boc, tx.transaction (@ton/core Transaction)
  // ctx.db is a PgQueryable here: writes through it commit together with the cursor.
  await ctx.db?.query("insert into seen (hash) values ($1)", [tx.hash]);
});

await watch.start();
// … on shutdown: stop consumers and indexing, then close the source and the store
await watch.close();
```

See [`examples/incoming-payments.ts`](examples/incoming-payments.ts) for a complete
consumer.

Requires [Bun](https://bun.sh) ≥ 1.4: the package ships TypeScript sources. `pg` is an
optional peer dependency (needed for `PgStore` with a `pg.Pool` and for the service);
`@ton/core` is a peer dependency.

## Contents

- [How it works](#how-it-works)
- [Library API](#library-api): [`TonWatch`](#tonwatch), [addresses](#addresses),
  [consumers](#consumer-api), [errors](#errors), [entry points](#entry-points)
- [Decoding transactions](#decoding-transactions)
- [Service](#service): [configuration](#configuration), [HTTP endpoints](#http-endpoints),
  [CLI](#managing-consumers-from-the-cli), [webhooks](#webhooks), [metrics](#metrics)
- [Liteservers](#liteservers), [toncenter plug-in](#optional-toncenter-history-plug-in-experimental)
- [Storage](#storage), [Performance](#performance), [Stability policy](#stability-policy)

## How it works

Every TON transaction names its predecessor on the same account (`prev_trans_lt`,
`prev_trans_hash`). That link is the whole design:

- **Writes land in any order.** Fetches walk backwards page by page
  (`liteServer.getTransactions`, 16 per page) from any known transaction. Several
  walks per address, and many addresses, run at once. Inserts are idempotent.
- **Completeness is computed, not assumed.** A stored transaction whose
  predecessor is missing marks a *gap*. An address's **frontier** is the newest
  transaction with an unbroken chain down to its `startLt`.
- **The store is the job queue.** Gaps found in the store become fetch jobs. A
  crash, a restart or a failed fetch just leaves gaps that the next pass refills —
  there is no separate progress state to corrupt.
- **Reads enforce order.** Consumers get each address's transactions in lt order up
  to its frontier and never beyond it.

Long gaps are walked in parallel: the indexer locates real transactions inside the
range from block listings (`lookupBlockByLt` + `listBlockTransactions`, which work as
far back as blocks are kept) and walks each piece separately.

## Library API

### TonWatch

```ts
const watch = new TonWatch({ store, source, /* IndexingOptions */ concurrency: 16, detect: "auto" });
```

`TonWatch<Db>` is generic over the store's transaction handle: with `PgStore` it is
`TonWatch<PgQueryable>` and handlers receive `ctx.db: PgQueryable`; with
`MemoryStore` there is no `ctx.db`. The type is inferred from `store`.

| method | |
|---|---|
| `init()` | runs migrations (never destructive); called by `start()` |
| `start()` | starts every registered consumer, then indexing; rejects with `CONSUMER_LOCKED` (and starts nothing) if a consumer runs elsewhere |
| `stop()` | graceful pause: consumers finish the transaction in hand, in-flight fetches complete; store and source stay open and `start()` resumes |
| `close()` | `stop()`, then closes the source and the store; final — `start()`, `init()` and `addAddress()` reject with `CLOSED` afterwards. Idempotent |
| `addAddress(address, { from })` / `removeAddress(address, { purge })` / `addresses()` | see [Addresses](#addresses) |
| `process(name, handler, options)` | registers a [consumer](#consumer-api) |
| `consumers()`, `consumerLag()`, `rewindConsumer()`, `deleteConsumer()`, `deadLetters()`, `replayDeadLetter()`, `discardDeadLetter()` | see [Managing consumers](#managing-consumers) |
| `watermark(addresses?)` | lowest complete-up-to lt across the addresses |
| `status()` | per-address indexing state as of the last tick |
| `health({ maxLagSeconds = 120 })` | `ok` / `degraded` (lag above `maxLagSeconds`, or a range no liteserver serves) / `down` (not started, or no successful tick for 60s), with `reasons` |

`TonWatch` owns its `store` and `source`: `close()` closes both (with `PgStore`, pass
`onClose: () => pool.end()` to have it end your pool too). It forwards the indexer's
events: `tick`, `frontier`, `synced`, `fetchError`.

### Addresses

Every method taking an address accepts an `@ton/core` `Address` or a string in
friendly (`EQ…`/`UQ…`) or raw (`<workchain>:<hex>`, any hex case) form
(`AddressInput`). Everything ton-watch returns, stores and sends uses the
**lowercase raw** form (`0:83df…`); `toRawAddress()` gives you the same
normalization. An invalid address throws `INVALID_ADDRESS`.

- `addAddress(address, { from })` resolves to the raw address. `from`: `"now"`
  (default — only new transactions), `"earliest"` (the account's full history) or an
  lt (transactions after it). Works at runtime; the running indexer picks it up on
  its next tick, also when added from another process.
- `removeAddress(address)` stops tracking and keeps the data; `{ purge: true }`
  deletes it with its consumer cursors and dead letters.

### Consumer API

```ts
const consumer = watch.process(name, handler, {
  from: "earliest",     // first run only: "earliest" | "now" | <lt>; later runs resume
  order: "address",     // or "global"
  addresses: [...],     // default: every tracked address, including ones added later
  batchSize: 100,
  concurrency: 8,       // addresses processed in parallel ("address" order)
  transactional: true,  // with PgStore: handler's ctx.db writes + cursor in one DB transaction
  onError: "retry",     // or "skip" | "dead-letter" after maxAttempts (see Failures)
  maxAttempts: 5,
  isRetryable: (error) => true, // false: give up at once (see Failures)
  lock: "fail",         // or "wait" (see Running one instance)
  lagIntervalMs: 15_000,
});
consumer.status();      // cursors, failures, last measured lag
await consumer.stop();
```

`handler(tx, ctx)` gets an `IndexedTx` (`address`, `lt`, `hash`, `prevLt`, `prevHash`,
`utime`, `boc`, and the lazily parsed `transaction`) and a `HandlerContext`
(`consumer`, `address`, `db?`, `replay`).

**Ordering guarantees**

- **Per address** (default): lt order, only up to the address's frontier. Addresses
  are independent of each other — a slow or failing one does not hold the others
  back.
- **Global** (`order: "global"`): one stream in `(lt, address)` order across the set,
  released only up to the **watermark** = the lowest *complete-up-to* point among the
  addresses. Use this when the meaning of a transaction depends on other watched
  addresses (lt order respects causality: a message is always created at a lower lt
  than the transaction that receives it). `watch.watermark(addresses)` exposes the
  same value.
- *Complete-up-to* also advances for idle addresses: once the indexer confirms at
  block B that an address's last on-chain transaction is stored, the address is
  complete up to the minimum shard `end_lt` of B. A quiet address therefore does
  not freeze the watermark (it lags by at most one idle-poll interval).

**Delivery guarantee.** The cursor is persisted after every transaction.

- **Exactly once** holds only for writes your handler makes through `ctx.db` with
  `PgStore` and `transactional: true` (the default): they run inside the database
  transaction that commits the cursor, so they commit exactly once even across
  crashes, rollbacks and [cursor conflicts](#running-one-instance).
- **At least once** for everything else: side effects outside that transaction
  (HTTP calls, queues, another database), `MemoryStore`, and `transactional: false`.
  A crash between the effect and the cursor commit repeats the transaction — make
  those effects idempotent (e.g. keyed by `tx.hash`).

### Failures

A throwing handler halts its address (or the whole stream in global order) and the
same transaction is retried with backoff (`retryMinMs` 1s → `retryMaxMs` 60s). What
happens when it keeps failing is `onError`:

| `onError` | after `maxAttempts` (default 5) failed attempts |
|---|---|
| `"retry"` (default) | nothing changes: retried forever, nothing is ever skipped |
| `"skip"` | the cursor moves past it; the stream continues |
| `"dead-letter"` | it is recorded as a dead letter, the cursor moves past it (atomically with `PgStore`); the stream continues |

An error that retrying cannot fix (a validation failure, a receiver rejecting the
request) need not wait for `maxAttempts`: `isRetryable(error)` returning false makes
`"skip"` and `"dead-letter"` give up on the first such failure. `"retry"` ignores it.

Attempt counts are stored with the cursor, so a restart does not reset them (a
halted address retries once right after a restart, then backs off again). In
global order the stream halts while a transaction is being retried — ordering
requires it — but a skipped or dead-lettered one no longer blocks anything.

Every failure emits `handlerError` (`{ consumer, address, lt, hash, error, attempts, action }`);
giving up emits `skip` or `deadLetter`. Metrics:
`ton_watch_consumer_errors_total`, `_skipped_total`, `_dead_letters_total`.

```ts
consumer.on("deadLetter", (letter) => alert(letter));
await consumer.deadLetters();                        // or watch.deadLetters({ consumer, address })
await consumer.replayDeadLetter(address, lt);        // handler again (ctx.replay = true), then delete
await consumer.discardDeadLetter(address, lt);       // delete without redelivering
```

A replay is out of order by nature and may run alongside live delivery. With a
transactional store the handler's `ctx.db` writes commit together with the dead
letter's deletion, so a replay takes effect once; if the handler throws, the dead
letter stays with the new error and attempt count. A dead letter whose transaction
was deleted (see [retention](#retention)) cannot be replayed (`TRANSACTION_NOT_FOUND`).

### Running one instance

Two processes running the same consumer name would deliver everything twice, so a
consumer delivers only while holding its lock. `PgStore` takes a session-level
advisory lock, `pg_advisory_lock(hashtext('ton_watch:<schema>'), hashtext(<name>))`
(visible in `pg_locks` with `objsubid = 2`); two names whose hashes collide merely
exclude each other. `MemoryStore` guards within the process.

> **Each running consumer keeps one pool connection for itself.** With a `pg.Pool`,
> size `max` for the number of consumers started on it **plus** the connections
> deliveries (one per transactional delivery in flight, up to `concurrency`), the
> indexer and your own code use at once. `pg` waits forever for a free connection
> by default, so a pool that is too small would hang; instead, starting a consumer
> that would leave the pool no connection for queries fails at once with
> `PG_POOL_TOO_SMALL`. PGlite has a single session and needs none of this.

- `lock: "fail"` (default): a second instance is refused with
  `ConsumerLockedError` (code `CONSUMER_LOCKED`) — `watch.start()` rejects (and
  starts nothing), and so do `consumer.ready()` after `consumer.start()`, and
  `consumer.runOnce()`.
- `lock: "wait"`: `start()` succeeds; the consumer waits (`status().waitingForLock`)
  and takes over when the other instance stops — a simple hot standby.
- `stop()` releases the lock; so does the database when the process dies. If the
  lock's connection breaks, the consumer stops delivering after the transaction
  being handled and re-takes the lock before going on.
- As a second line of defence every cursor move is a compare-and-set: it commits
  only if the cursor is still where this instance last saw it. If another writer
  moved it (an instance that took over before this one noticed its lock was gone),
  the delivery is rolled back together with the handler's `ctx.db` writes, the
  round ends with `CursorConflictError` (code `CURSOR_CONFLICT`; logged by a
  started consumer, thrown by `runOnce()`), and the consumer reloads its positions
  before delivering again.
- `runOnce()` outside `start()` holds the lock for that round only.
- `start()` and `stop()` may be called in any order: a `start()` while a `stop()` is
  finishing starts again once it is done, and `stop()` always resolves after the
  transaction being handled.

### Managing consumers

```ts
await watch.consumers();                     // name, order, per-address cursors (lt, updatedAt, attempts, lastError)
await watch.consumerLag("payments");         // { transactions, lt, seconds, addresses: [...] }
await watch.rewindConsumer("payments", "earliest");                 // redeliver everything
await watch.rewindConsumer("payments", lt, { addresses: [addr] });  // deliver what comes after lt
await watch.rewindConsumer("payments", "now");                      // skip to each frontier
await watch.deleteConsumer("old-consumer");  // record, cursors and dead letters
```

They work for consumers running in other processes too. A cursor's `updatedAt` is
its last delivery (or skip, or rewind). The service has the same operations as
[commands](#managing-consumers-from-the-cli).

- **Rewind** of a consumer registered in this `TonWatch` (or `consumer.rewind()`)
  is applied between rounds: the round in progress ends after the transaction being
  handled, the cursors move, and delivery resumes from there. A consumer running in
  another process holds its lock, and the rewind is refused with
  `CONSUMER_LOCKED` — stop it first. Rewinding clears failure counts; dead letters
  are kept (discard the ones the rewind redelivers).
- **Delete** is refused while the consumer runs anywhere (`CONSUMER_LOCKED`), and
  for a consumer registered in the calling `TonWatch` (`CONSUMER_REGISTERED`).
- **Lag** is the consumer's own backlog: stored transactions it may deliver but has
  not — up to each frontier, or up to the watermark in global order. `seconds` is
  the age of the oldest of them (0 when caught up), `lt` the newest one's lt minus
  the cursor. Indexing lag is separate (`AddressStatus.lagSeconds`). A started
  consumer measures it every `lagIntervalMs` into `status().lag` and the gauges
  `ton_watch_consumer_lag_transactions{consumer}` and
  `ton_watch_consumer_lag_seconds{consumer}`.

### Errors

Every error ton-watch throws on purpose is a `TonWatchError` with a `code`. **The
codes are the contract; messages are not** — messages may change in any release, a
code is only removed or repurposed in a major one. Match with `isTonWatchError`,
which (unlike `instanceof`) also recognizes errors from another copy of the package:

```ts
import { isTonWatchError } from "ton-watch";

try {
  await watch.start();
} catch (error) {
  if (isTonWatchError(error, "CONSUMER_LOCKED")) { /* another instance runs it */ }
  else throw error;
}
```

| code | |
|---|---|
| `INVALID_OPTION` | an option or argument has a value that cannot work |
| `INVALID_ADDRESS` | neither a valid friendly nor raw address |
| `UNKNOWN_ADDRESS` | the address is not tracked |
| `UNKNOWN_CONSUMER` | no consumer of that name (in the store, or registered here where the operation needs a local one) |
| `CONSUMER_REGISTERED` | a consumer of that name is already registered in this `TonWatch` |
| `CONSUMER_LOCKED` | another instance holds the consumer's lock (`ConsumerLockedError`) |
| `CURSOR_CONFLICT` | the cursor was moved by someone else (`CursorConflictError`) |
| `DEAD_LETTER_NOT_FOUND` | no such dead letter (any more) |
| `TRANSACTION_NOT_FOUND` | the transaction is no longer stored |
| `CLOSED` | the `TonWatch` was closed |
| `PG_POOL_TOO_SMALL` | a `pg.Pool` has too few connections for the running consumers |
| `MIGRATION_MODIFIED`, `MIGRATION_TOO_NEW`, `MIGRATION_DIVERGED` | `migrate()` refused the schema (`MigrationError`; see [docs/migrations.md](docs/migrations.md)) |
| `SOURCE_RATE_LIMIT`, `SOURCE_TIMEOUT`, `SOURCE_ARCHIVE_UNAVAILABLE`, `SOURCE_NOT_READY`, `SOURCE_BAD_RESPONSE`, `SOURCE_NETWORK`, `SOURCE_UNKNOWN` | a chain request failed (`SourceError`, with `kind`) |

The underlying error, if any, is the standard `cause`.

### Entry points

| import | |
|---|---|
| `ton-watch` | `TonWatch`, `PgStore`, `MemoryStore`, `LiteSource`, `Metrics`, errors, types |
| `ton-watch/parse` | [transaction decoding](#decoding-transactions) |
| `ton-watch/webhook` | receiver side of the [webhooks](#webhooks): `verifySignature`, header names, `WebhookPayload` types; depends only on `node:crypto` |
| `ton-watch/toncenter` | the [toncenter history plug-in](#optional-toncenter-history-plug-in-experimental) (experimental) |
| `ton-watch/advanced` | **experimental**: the building blocks behind `TonWatch` — standalone `Indexer` and `Consumer`, the `Store`, `ConsumerStateStore`, `TxSource` and `HistorySource` contracts, chain helpers (`validatePage`, `analyzeChain`, `recordFromCell`, `classifyError`) |

`ton-watch/advanced` may change in any 0.x minor release. **Custom `Store`,
`ConsumerStateStore` and `TxSource` implementations are unsupported in 0.x**:
methods may be added to these interfaces in minor versions. Use `PgStore` or
`MemoryStore`, and `LiteSource`.

## Decoding transactions

`ton-watch/parse` decodes a transaction (`tx` from a handler, or any `@ton/core`
`Transaction`): outcome and bounce flags, comments, TEP-74 jetton and TEP-62 NFT
messages. Two helpers answer what payment processing asks:

```ts
import { incomingJettonTransfer, incomingPayment } from "ton-watch/parse";

const payment = incomingPayment(tx);
// TON credited by an inbound internal message: not outgoing, not a bounce, not
// bounced back. Also extraCurrencies. Credit only plain transfers:
if (payment && (payment.body.kind === "empty" || payment.body.kind === "text-comment")) {
  credit(payment.sender, payment.amount, payment.comment);
}

// Your jetton wallet(s) — the master's get_wallet_address(owner). Required:
// anyone can send a transfer_notification with any amount.
const jettons = incomingJettonTransfer(tx, { jettonWallet: [usdtWallet, notWallet] });
if (jettons) credit(jettons.sender, jettons.amount, jettons.comment, jettons.jettonWallet);
```

`incomingPayment` also returns `excesses` refunds and the TON attached to jetton
notifications — credited the same way but not payments — hence the body check.
"Credited" covers this transaction only: the account's code may have sent value
onward in it (`parseTransaction(tx).valueOut`). `incomingJettonTransfer` returns
`null` for a notification from any other sender; `{ trustAnySender: true }` opts
out of the check, leaving it to you. A forward payload that does not decode is
`{ kind: "malformed" }` and the transfer is still returned. Both throw on a record
whose BOC is not a transaction, an `address` option that is invalid or names
another account (hash or workchain), and a `jettonWallet` that is not an address.

## Service

`ton-watch run` (`bun run start` in this repo) runs the indexer, and delivers to the
configured [webhooks](#webhooks), until SIGINT/SIGTERM, then finishes in-flight
work and exits (0; 1 if stopping fails or takes over 30s; a second signal exits 1
at once). Configuration is validated before connecting to anything. The HTTP port is
bound before any work starts, so a port in use exits 1 right away. It never drops
data: schema changes are versioned, append-only migrations
(`<schema>.schema_migrations`); see [docs/migrations.md](docs/migrations.md) for
the rules and what happens during a rolling deploy.

```sh
TON_WATCH_DATABASE_URL=postgres://… ton-watch run
ton-watch deliver                       # webhooks only, no indexing (see below)
ton-watch add <address> [--from now|earliest|<lt>]
ton-watch remove <address> [--purge]
ton-watch list                          # JSON (stable, see below)
ton-watch consumers                     # and other consumer commands (below)
```

### Configuration

Every setting is an environment variable prefixed `TON_WATCH_`. An empty value
counts as unset. The full list (the source of truth is `ENV_VARS` in
[`src/service/env.ts`](src/service/env.ts)):

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
| `TON_WATCH_HISTORY` | — | `toncenter` enables the [toncenter plug-in](#optional-toncenter-history-plug-in-experimental) (experimental) |
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
consumers](#managing-consumers) (`transactions` summed, `lt` and `seconds` the
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
HTTP endpoints. Each target is a [consumer](#consumer-api) named
`webhook:<name>`, so delivery has the same guarantees: per address (or global)
chain order, never past a gap, position stored after each transaction and
resumed after a restart.

| env | default | |
|---|---|---|
| `TON_WATCH_WEBHOOK_URL` | — | one target, named `default` |
| `TON_WATCH_WEBHOOKS` | — | JSON array of named targets (below) |
| `TON_WATCH_WEBHOOK_SECRET` | — | HMAC-SHA256 signing secret for every target; unsigned when unset |
| `TON_WATCH_WEBHOOK_SECRET_PREVIOUS` | — | while [rotating](#rotating-the-secret): the previous secret, signed with as well |
| `TON_WATCH_WEBHOOK_ORDER` | `address` | `address` or `global` (see [ordering](#consumer-api)) |
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
policy](#failures)):

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

**Payload, version 1** (`WebhookPayload` in `ton-watch/webhook`). A real body, from
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
[`tests/fixtures/golden/`](tests/fixtures/golden/). Encodings: lts and amounts
(nanotons, jetton units) are decimal strings; hashes lowercase hex; addresses
lowercase raw (`<workchain>:<hex>`); cells base64 BOCs, other binary data base64;
unix times, opcodes, exit codes and counts JSON numbers. `prev` is null for the
account's first transaction; `parsed` is null if the BOC could not be decoded. The
field names in `parsed` follow `ParsedTransaction` in [`ton-watch/parse`](src/parse/types.ts).

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
key to drop replays inside the window. `ton-watch/webhook` does all of this and
depends only on `node:crypto`:

```ts
import { SIGNATURE_HEADER, verifySignature, type WebhookPayload } from "ton-watch/webhook";

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
[`src/metrics/registry.ts`](src/metrics/registry.ts). Label values are bounded:
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
| `ton_watch_consumer_lag_transactions{consumer}`, `ton_watch_consumer_lag_seconds{consumer}` | gauge | the consumer's backlog (see [Managing consumers](#managing-consumers)) |
| `ton_watch_consumer_watermark_lt{consumer}` | gauge | global order: lt the stream is released up to (float64: use for `changes()`, not lt lookups) |

## Liteservers

`LiteSource` connects to every server in the config and spreads calls over them:
fastest and least loaded first, a bounded number of requests per server, and per
error kind:

- **rate limited** → that server cools down (exponential, capped at 30s); the call
  moves on.
- **timeout / network** → short cooldown, retry elsewhere.
- **not found** → try the other servers, then the archival ones
  (`archiveServers` / `TON_WATCH_ARCHIVE_NETWORK`). A range nobody serves is retried
  every 10 minutes and reported as stuck — it is never skipped.
- Queries carry `waitMasterchainSeqno`, so a server a few blocks behind waits
  instead of answering "not found" for something it has not seen yet.
- Every page is checked before it is written: it must start at the requested
  transaction and every prev link inside it must hold.

### How far back public liteservers go

Measured 2026-10-06 (full table in [`bench/RESULTS.md`](bench/RESULTS.md)): 11 of the
12 reachable public mainnet liteservers serve account transactions back **35–41
days**; one (185.86.79.9) is archival back past a year but missing roughly days
3–50. Old **account state** is served for less than a day — which is why an indexer
that reads state "as of" each block cannot recover from a multi-day stall, while
this one can.

**For more than ~a month of history** (including recovery from an outage longer
than that), configure an archival liteserver or plug in toncenter (below).

## Optional: toncenter history plug-in (experimental)

A separate import that the core never loads on its own. Leave it out and nothing
changes.

> **Experimental**, outside the [stability policy](#stability-policy). Tested
> without paying: unit tests replay a recorded toncenter response, and
> `LIVE=1 bun test tests/live.test.ts` checks it against liteservers on mainnet
> using the free tier (no key, 1 request/s). Paid-plan rate limits and long runs at
> volume are **not** tested. The safety net still applies: every page is re-hashed
> and chain-checked, so a wrong answer is refetched, never stored.

```ts
import { ToncenterHistory } from "ton-watch/toncenter";

new TonWatch({
  store,
  source,
  history: {
    source: new ToncenterHistory({ apiKey: process.env.TON_WATCH_TONCENTER_API_KEY }), // key optional
    mode: "fallback",  // or "boost"
    enabled: true,     // flip off without unwiring
  },
});
```

- **`fallback`** (default): liteservers first. toncenter is asked only for ranges no
  liteserver serves any more. It is archival, so outages of months recover without
  your own archival node.
- **`boost`**: also used whenever it has spare request budget. It serves up to 1000
  transactions per request where liteservers serve 16, and liteservers take whatever
  it can't.
- toncenter pages are raw transaction BOCs. ton-watch re-hashes them and checks every
  prev link exactly like liteserver pages (verified on mainnet: byte-identical). A
  wrong answer is rejected and refetched from liteservers, never stored.
- Rate-limited client side: 1 request/s without a key, 10 with one (`rps` to change).
  It retries 429 and 5xx with backoff.
- Service: `TON_WATCH_HISTORY=toncenter`, `TON_WATCH_HISTORY_MODE=fallback|boost`,
  `TON_WATCH_TONCENTER_API_KEY`, `TON_WATCH_TONCENTER_ENDPOINT`.
- Another provider plugs in the same way by implementing `HistorySource` from
  `ton-watch/advanced` (`getTransactions(address, from, count)`, optionally `busy()`).

## Storage

`PgStore` is the reference store (works with `pg` and PGlite); `MemoryStore` keeps
everything in process memory, for tests and short-lived tools. Both implement the
`Store` contract (`ton-watch/advanced`, experimental; custom implementations are
unsupported in 0.x).

`PgStore` keeps its tables in schema `ton_watch` (option `schema`, env
`TON_WATCH_SCHEMA`): `addresses`, `transactions` (primary key `(address_id, lt)`,
which serves ordered reads, prev-link lookups and gap floors — no other index
needed), `cursors` (with the failure state of the transaction after each cursor),
`consumers`, `dead_letters`, `schema_migrations`. Schema changes follow
[docs/migrations.md](docs/migrations.md): never destructive, safe to run from
several processes at once, and checked against frozen copies of every released
migration.

### Querying the tables

You may read these columns directly; they are covered by the [stability
policy](#stability-policy) (columns are only ever added, never removed or retyped):

| table | stable columns |
|---|---|
| `addresses` | `id`, `address` (lowercase raw), `start_lt`, `active`, `frontier_lt`, `frontier_hash`, `synced_lt` |
| `transactions` | `address_id`, `lt`, `hash`, `prev_lt`, `prev_hash`, `utime`, `boc` |
| `cursors` | `consumer`, `address_id`, `lt` (last delivered) |

Everything else — other columns, `consumers`, `dead_letters`, `schema_migrations` —
is internal: read it through the API or the CLI. Never write to any table, except
the retention delete below.

### Retention

A transaction is stored as its BOC (667 bytes on average in our benchmarks) plus
~110 bytes of row data and index — roughly **1 GB per million transactions**. There
is no automatic retention. To prune, delete old `transactions` rows that are both
below the address's frontier and at or below every consumer's cursor on it:

```sql
delete from ton_watch.transactions t
using ton_watch.addresses a
where t.address_id = a.id
  and t.lt < a.frontier_lt                                   -- keep the frontier and above
  and t.utime < extract(epoch from now() - interval '90 days')
  and not exists (                                           -- keep what a consumer has yet to deliver
    select 1 from ton_watch.cursors c where c.address_id = t.address_id and c.lt < t.lt
  );
```

Rows below the frontier are never re-checked for gaps, so they are not refetched.
What you delete is gone for good: a consumer started later with `from: "earliest"`,
a rewind to `earliest`, and a replay of a dead letter for a deleted transaction
(`TRANSACTION_NOT_FOUND`) no longer see it.

## Performance

All numbers measured against mainnet **public** liteservers; methodology, raw data
and every run in [`bench/RESULTS.md`](bench/RESULTS.md).

Same 1-hour window, same liteserver pool, same parallelism (64):

| | ton-watch | scan every block | |
|---|---:|---:|---|
| 10 busy addresses | 14 s, 1.9k calls | 149 s, 44k calls | **~10× faster, ~23× fewer calls** |
| 1000 addresses | 45 s, 6.3k calls | 326 s, 72k calls | **~7× faster, ~11× fewer calls** |

- **Parallelism** (1000 addresses, 1h): 712 s sequential → 45 s at concurrency 64.
- **Long ranges** (iteration on the measurements): one address's history is a sequential walk (~120 tx/s, one page per round trip). Splitting long ranges via block listings made a single busy address **2.6× faster** (32.7 s → 12.6 s) and 10 addresses **2.8×** (39.9 s → 14.2 s), at the cost of more calls.
- **7-day outage, 10 busy addresses (~100k tx/day combined)**: 709,477 transactions caught up in **8.5 minutes** into Postgres, all complete, no stuck ranges. Without range splitting the same catch-up took 28 minutes.
- **Watching 1000 addresses, steady state** (4-minute runs): detection costs **~330 calls/min in `blocks` mode** (list each new shard block once) versus **~3,650/min in `poll` mode**, about 11× less, and lag drops from ~28 s to ~0–2 s. Fetching the transactions themselves comes on top (these sampled addresses made ~1,000 tx/min). `blocks` mode also re-checks every address directly once per 10 minutes (~100 calls/min at 1000 addresses), so a transaction the listing missed is found within that bound. `auto` picks `blocks` from 50 addresses up.
- **toncenter plug-in in `boost` mode, free tier (1 request/s)**: a single busy address's hour (3.9k tx) took **4.2 s and 35 calls**, against 12.6 s / 659 calls with liteservers and splitting. At 10 addresses the 1 request/s budget is the limit (13.8 s, same as without it). An API key raises it.

## When to use this, and when not

Use ton-watch when you care about a **known set of addresses** — a marketplace's
contracts and fee wallets, a project's treasury, user deposit wallets — and need
every one of their transactions, in order, without running your own node.

Use a full-chain indexer ([ton-indexer](https://github.com/toncenter/ton-indexer),
[ton-index-worker](https://github.com/toncenter/ton-index-worker)) or a node when:

- you need *every* account, or accounts you can't name in advance (e.g. all NFT
  items of a collection as they get deployed — though watching the collection and
  the marketplace contracts usually covers that);
- the watched addresses together produce a large share of all chain traffic —
  in our 1-hour measurement a block scan costs ~5–8 calls per masterchain block (~9k blocks/h) regardless of how many addresses it watches, while ton-watch costs ~1 call per 16 watched transactions plus detection; ton-watch stays cheaper until the watched addresses produce on the order of 16 × 8 ≈ 100+ transactions per masterchain block, i.e. a large fraction of the whole chain;
- you need account state at past blocks (this indexes transactions, not state).

## Stability policy

ton-watch follows [semver](https://semver.org) adapted to 0.x: **a minor release
(0.x → 0.y) may break the contracts below, a patch release (0.x.y) never does.**
Breaking changes are listed in [CHANGELOG.md](CHANGELOG.md).

**Covered:**

- the exports of `ton-watch`, `ton-watch/webhook` and `ton-watch/parse` (runtime
  names and types; `api/*.d.ts` snapshots every one);
- error codes (`TonWatchErrorCode`) — not messages;
- the webhook payload, `version: 1`, and its headers;
- the stable service JSON: `/health`, `/consumers`, and `list`, `consumers`,
  `dead-letters` output (`version: 1`);
- CLI commands and arguments, and the environment variables;
- metric names, types and label names;
- the database schema, changed only through [migrations](docs/migrations.md), and
  the [stable columns](#querying-the-tables).

**Not covered:** `ton-watch/advanced` (experimental; custom `Store` and `TxSource`
implementations are unsupported in 0.x), `ton-watch/toncenter` (experimental),
`/status`, log output, error messages, and the internal tables and columns.

**Deprecation.** Before something covered is removed or changed, it is marked
`@deprecated` (and listed in the changelog) for at least one minor release, and
using it logs a runtime warning.

## Development

```sh
bun test                                   # unit, indexer, consumer, service, end-to-end on PGlite; deterministic
TEST_DATABASE_URL=postgres://… bun test    # also run the store contract on real Postgres
LIVE=1 bun test tests/live.test.ts         # mainnet: last 3000 txs of a busy address vs toncenter,
                                           # toncenter pages vs liteserver pages
bun run typecheck                          # strict tsc over src/, tests/, bench/, plus the API declarations
bun run lint                               # Biome (root biome.json); `bun run format` applies fixes
```

Contract snapshots, each regenerated deliberately and reviewed as a diff:

- `api/*.d.ts` — public types per entry point: `UPDATE_API_SNAPSHOT=1 bun test tests/api-snapshot.test.ts`;
- `tests/fixtures/golden/` — webhook payloads: `UPDATE_GOLDEN=1 bun test`;
- `tests/fixtures/migrations/` — frozen migrations and the schema snapshot:
  `UPDATE_MIGRATION_FIXTURES=1 bun test tests/stores/migrations.test.ts` (see
  [docs/migrations.md](docs/migrations.md)).

Source layout (`src/`): `core/` domain types, errors and chain-link rules,
`indexer/` (the `Indexer` orchestrator plus walk scheduling, fetching, splitting,
change detection and maintenance), `consumer/`, `source/` (`TxSource`,
`liteserver/`), `stores/` (`memory/`, `pg/` with `migrations.ts` and `migrator.ts`),
`parse/`, `webhook/` (receiver side), `plugins/toncenter/`, `service/` + `bin/` (the
CLI), `metrics/`, `util/`. Tests mirror it.

Benchmarks (`bench/`, mainnet): `accounts.ts` picks the address sets, then
`archive-depth.ts`, `backfill.ts`, `block-scan.ts`, `outage.ts`, `idle.ts`;
`report.ts` renders `bench/RESULTS.md`.
