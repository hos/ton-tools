# The TonWatch API

[← @ton/watch](../README.md)

Every `TonWatch` method, how addresses are written, error codes and the package entry points.

## TonWatch

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
| `process(name, handler, options)` | registers a [consumer](consumers.md#consumer-api) |
| `consumers()`, `consumerLag()`, `rewindConsumer()`, `deleteConsumer()`, `deadLetters()`, `replayDeadLetter()`, `discardDeadLetter()` | see [Managing consumers](consumers.md#managing-consumers) |
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

## Addresses

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

## Errors

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

## Entry points

| import | |
|---|---|
| `@ton/watch` | `TonWatch`, `PgStore`, `MemoryStore`, `LiteSource`, `Metrics`, errors, types |
| `@ton/watch/parse` | [transaction decoding](decoding.md) |
| `@ton/watch/webhook` | receiver side of the [webhooks](webhooks.md): `verifySignature`, header names, `WebhookPayload` types; depends only on `node:crypto` |
| `@ton/watch/toncenter` | the [toncenter history plug-in](liteservers.md#optional-toncenter-history-plug-in-experimental) (experimental) |
| `@ton/watch/cli` | `run()`: the [service and CLI](service.md#running-the-service) as a module |
| `@ton/watch/advanced` | **experimental**: the building blocks behind `TonWatch` — standalone `Indexer` and `Consumer`, the `Store`, `ConsumerStateStore`, `TxSource` and `HistorySource` contracts, chain helpers (`validatePage`, `analyzeChain`, `recordFromCell`, `classifyError`) |

`@ton/watch/advanced` may change in any 0.x minor release. **Custom `Store`,
`ConsumerStateStore` and `TxSource` implementations are unsupported in 0.x**:
methods may be added to these interfaces in minor versions. Use `PgStore` or
`MemoryStore`, and `LiteSource`.
