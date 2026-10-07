# Consumers

[← @ton/watch](../README.md)

`watch.process()`: ordering, delivery guarantees, retries and dead letters, running one instance, and managing consumers.

## Consumer API

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

## Failures

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
was deleted (see [retention](storage.md#retention)) cannot be replayed (`TRANSACTION_NOT_FOUND`).

## Running one instance

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

## Managing consumers

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
