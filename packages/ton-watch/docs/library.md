# Using ton-watch as a library

The API in full. For a first look, start with the [README](../README.md).

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
| `stop()` | prompt pause: starts and retries nothing new, gives requests in flight `stopTimeoutMs` (default 5000) to finish, then abandons them; consumers finish the transaction in hand. Store and source stay open and `start()` resumes |
| `close()` | `stop()`, then closes the source (rejecting its pending requests) and the store; final — `start()`, `init()` and `addAddress()` reject with `CLOSED` afterwards. Idempotent |
| `addAddress(address, { from })` / `removeAddress(address, { purge })` / `addresses()` | see [Addresses](#addresses) |
| `process(name, handler, options)` | registers a [consumer](#consumer-api) |
| `consumers()`, `consumerLag()`, `rewindConsumer()`, `deleteConsumer()`, `deadLetters()`, `replayDeadLetter()`, `discardDeadLetter()` | see [Managing consumers](#managing-consumers) |
| `watermark(addresses?)` | lowest complete-up-to lt across the addresses |
| `status()` | per-address indexing state as of the last tick |
| `health({ maxLagSeconds = 120 })` | `ok` / `degraded` (lag above `maxLagSeconds`, or a range no liteserver serves) / `down` (not started, or no successful tick for 60s), with `reasons` |

`stop()` and `close()` always resolve, and never wait on the chain longer than
`stopTimeoutMs` (`0` abandons at once). Pages that arrive within it are stored;
anything abandoned leaves only a gap, refetched after the next `start()` — nothing
half-written reaches frontiers or cursors. The one thing they wait for without a
deadline is a consumer handler call in progress: it is never interrupted, and its
cursor (and `ctx.db` writes) commit — give your handler its own timeouts. `close()`
rejects only if closing the source or the store itself fails (both are attempted).

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
was deleted (see [retention](operations.md#retention)) cannot be replayed (`TRANSACTION_NOT_FOUND`).

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
[commands](service.md#managing-consumers-from-the-cli).

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
import { isTonWatchError } from "@ton/watch";

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
| `MIGRATION_MODIFIED`, `MIGRATION_TOO_NEW`, `MIGRATION_DIVERGED` | `migrate()` refused the schema (`MigrationError`; see [docs/migrations.md](migrations.md)) |
| `SOURCE_RATE_LIMIT`, `SOURCE_TIMEOUT`, `SOURCE_ARCHIVE_UNAVAILABLE`, `SOURCE_NOT_READY`, `SOURCE_BAD_RESPONSE`, `SOURCE_NETWORK`, `SOURCE_UNKNOWN` | a chain request failed (`SourceError`, with `kind`) |

The underlying error, if any, is the standard `cause`.

### Entry points

| import | |
|---|---|
| `@ton/watch` | `TonWatch`, `PgStore`, `MemoryStore`, `LiteSource`, `Metrics`, errors, types |
| `@ton/watch/parse` | [transaction decoding](#decoding-transactions) |
| `@ton/watch/webhook` | receiver side of the [webhooks](service.md#webhooks): `verifySignature`, header names, `WebhookPayload` types; depends only on `node:crypto` |
| `@ton/watch/toncenter` | the [toncenter history plug-in](operations.md#optional-toncenter-history-plug-in-experimental) (experimental) |
| `@ton/watch/cli` | `run()`: the [service and CLI](service.md#running-the-service) as a module |
| `@ton/watch/advanced` | **experimental**: the building blocks behind `TonWatch` — standalone `Indexer` and `Consumer`, the `Store`, `ConsumerStateStore`, `TxSource` and `HistorySource` contracts, chain helpers (`validatePage`, `analyzeChain`, `recordFromCell`, `classifyError`) |

`@ton/watch/advanced` may change in any 0.x minor release. **Custom `Store`,
`ConsumerStateStore` and `TxSource` implementations are unsupported in 0.x**:
methods may be added to these interfaces in minor versions. Use `PgStore` or
`MemoryStore`, and `LiteSource`.

## Decoding transactions

`@ton/watch/parse` decodes a transaction (`tx` from a handler, or any `@ton/core`
`Transaction`): outcome and bounce flags, comments, TEP-74 jetton and TEP-62 NFT
messages. Two helpers answer what payment processing asks:

```ts
import { incomingJettonTransfer, incomingPayment } from "@ton/watch/parse";

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
