# ton-watch

Embeddable TON transaction indexer for an explicit set of addresses. Fetches each
address's transaction chain straight from liteservers — in any order, in parallel,
from any starting point — and hands transactions to your code **strictly in chain
order, exactly once, never past a gap**.

It does not read historical account state and does not depend on scanning every
block in order, so an outage of days or weeks is a backlog to work through, not a
permanent jam.

```ts
import { Pool } from "pg";
import { LiteSource, PgStore, TonWatch } from "ton-watch";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const watch = new TonWatch({
  store: new PgStore(pool),                       // or new MemoryStore()
  source: await LiteSource.connect({ servers: "mainnet" }),
});

await watch.addAddress("EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMS", { from: "now" });

watch.process("my-consumer", async (tx, ctx) => {
  // tx.lt, tx.hash, tx.utime, tx.boc, tx.transaction (parsed @ton/core Transaction)
  // With PgStore, write through ctx.db: it commits together with the cursor.
});

await watch.start();
// … on shutdown
await watch.stop();
```

See [`examples/incoming-payments.ts`](examples/incoming-payments.ts) for a complete
consumer.

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

## Consumer API

```ts
const consumer = watch.process(name, handler, {
  from: "start",        // first run only: "start" | "now" | <lt>; later runs resume
  order: "address",     // or "global"
  addresses: [...],     // default: every tracked address, including ones added later
  batchSize: 100,
  concurrency: 8,       // addresses processed in parallel ("address" order)
  transactional: true,  // with PgStore: handler effects + cursor in one DB transaction
  onError: "retry",     // or "skip" | "dead-letter" after maxAttempts (see Failures)
  maxAttempts: 5,
  isRetryable: (error) => true, // false: give up at once (see Failures)
  lock: "fail",         // or "wait" (see Running one instance)
  lagIntervalMs: 15_000,
});
consumer.status();      // cursors, failures, last measured lag
await consumer.stop();
```

**Ordering guarantees**

- **Per address** (default): lt order, each transaction exactly once, only up to the
  address's frontier. Addresses are independent of each other — a slow or failing
  one does not hold the others back.
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

**Exactly once.** The cursor is persisted after every transaction. With `PgStore`
and `transactional: true` (default) the handler runs inside the transaction that
commits the cursor and receives it as `ctx.db`; writes made through it are exactly
once even across crashes. Side effects outside that database (HTTP calls, messages)
are at-least-once — make them idempotent (e.g. keyed by `tx.hash`).

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

Every failure emits `handlerError` (`{ address, lt, attempts, error, action }`);
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
letter stays with the new error and attempt count.

### Running one instance

Two processes running the same consumer name would deliver everything twice, so a
consumer delivers only while holding its lock. `PgStore` takes a session-level
advisory lock, `pg_advisory_lock(hashtext('ton_watch:<schema>'), hashtext(<name>))`
(visible in `pg_locks` with `objsubid = 2`); two names whose hashes collide merely
exclude each other. `MemoryStore` guards within the process. A custom `Store`
without `lockConsumer` is not guarded.

> **Each running consumer keeps one pool connection for itself.** With a `pg.Pool`,
> size `max` for the number of consumers started on it **plus** the connections
> deliveries (one per transactional delivery in flight, up to `concurrency`), the
> indexer and your own code use at once. `pg` waits forever for a free connection
> by default, so a pool that is too small would hang; instead, starting a consumer
> that would leave the pool no connection for queries fails at once with
> `pg Pool too small`. PGlite has a single session and needs none of this.

- `lock: "fail"` (default): a second instance is refused with
  `ConsumerLockedError` — `watch.start()` rejects (and starts nothing), and so do
  `consumer.ready()` after `consumer.start()`, and `consumer.runOnce()`.
- `lock: "wait"`: `start()` succeeds; the consumer waits (`status().waitingForLock`)
  and takes over when the other instance stops — a simple hot standby.
- `stop()` releases the lock; so does the database when the process dies. If the
  lock's connection breaks, the consumer stops delivering after the transaction
  being handled and re-takes the lock before going on.
- As a second line of defence every cursor move is a compare-and-set: it commits
  only if the cursor is still where this instance last saw it. If another writer
  moved it (an instance that took over before this one noticed its lock was gone),
  the delivery is rolled back together with the handler's `ctx.db` writes, the
  round ends with `CursorConflictError` (logged by a started consumer, thrown by
  `runOnce()`), and the consumer reloads its positions before delivering again.
- `runOnce()` outside `start()` holds the lock for that round only.
- `start()` and `stop()` may be called in any order: a `start()` while a `stop()` is
  finishing starts again once it is done, and `stop()` always resolves after the
  transaction being handled.

### Managing consumers

```ts
await watch.consumers();                     // name, order, per-address cursors (lt, updatedAt, attempts, lastError)
await watch.consumerLag("payments");         // { transactions, lt, seconds, addresses: [...] }
await watch.rewindConsumer("payments", "start");                    // redeliver everything
await watch.rewindConsumer("payments", lt, { addresses: [addr] });   // deliver what comes after lt
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
  `ConsumerLockedError` — stop it first. Rewinding clears failure counts; dead
  letters are kept (discard the ones the rewind redelivers).
- **Delete** is refused while the consumer runs anywhere, and for a consumer
  registered in the calling `TonWatch`.
- **Lag** is the consumer's own backlog: stored transactions it may deliver but has
  not — up to each frontier, or up to the watermark in global order. `seconds` is
  the age of the oldest of them (0 when caught up), `lt` the newest one's lt minus
  the cursor. Indexing lag is separate (`ton_watch_address_lag_seconds`). A started
  consumer measures it every `lagIntervalMs` into `status().lag` and the gauges
  `ton_watch_consumer_lag_transactions{consumer}` and
  `ton_watch_consumer_lag_seconds{consumer}`.

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

`bun run start` (= `ton-watch run`) runs the indexer, and delivers to the
configured [webhooks](#webhooks), until SIGINT/SIGTERM, then finishes in-flight
work and exits (0; 1 if stopping fails or takes over 30s; a second signal exits 1
at once). The HTTP port is bound before any work starts, so a port in use exits 1
right away. It never drops data: schema changes are
versioned migrations (`<schema>.schema_migrations`).

```sh
DATABASE_URL=postgres://… bun run start
bun run cli deliver                     # webhooks only, no indexing (see below)
bun run cli add <address> [--from now|genesis|<lt>]
bun run cli remove <address> [--purge]
bun run cli list
bun run cli consumers                   # and other consumer commands (below)
```

| env | default | |
|---|---|---|
| `DATABASE_URL` | — | required |
| `TON_WATCH_SCHEMA` | `ton_watch` | Postgres schema for all tables |
| `TON_NETWORK` | `mainnet` | `mainnet`, `testnet` or a global config URL |
| `TON_ARCHIVE_CONFIG` | — | config URL with archival liteservers, used only for history the others pruned |
| `TON_WATCH_ADDRESSES` | — | `addr[@now\|genesis\|lt],…` added on start if missing; checked at startup |
| `TON_WATCH_PORT` | `9464` | `/health`, `/metrics` (Prometheus), `/status`, `/consumers` |
| `TON_WATCH_CONCURRENCY` | `16` | liteserver pages in flight |
| `TON_WATCH_DETECT` | `auto` | `poll`, `blocks` or `auto` |
| `TON_WATCH_LOG` | `info` | `debug`, `info`, `warn`, `error` |

`/health` is `ok`, `degraded` (lag above 120s, or a range no liteserver serves) or
`down` (503: not running, or no successful tick for 60s), made worse by the
webhook consumers: `degraded` while one is retrying, `down` if one has stopped.
`/consumers` is the output of `ton-watch consumers` (below), read-only. The
endpoints answer GET and HEAD (other methods get 405) and ignore query strings.

### Managing consumers from the CLI

These commands need only the database — no liteserver connection — so they can
run next to a live service. Arguments are checked before connecting.

```sh
ton-watch consumers                                   # JSON: name, order, addresses, failing, lag, deadLetters
ton-watch rewind <consumer> <start|now|lt> [--address <address>]...
ton-watch dead-letters [<consumer>]                   # JSON, oldest first; hash in hex
ton-watch replay <consumer> <address> <lt>            # send a dead letter again, then delete it
ton-watch discard <consumer> <address> <lt>           # delete a dead letter without sending it
ton-watch delete-consumer <consumer>                  # record, cursors and dead letters
```

`lag` in `consumers` is the backlog described in [Managing
consumers](#managing-consumers) (`transactions`, `lt`, `seconds`); `failing` counts
addresses whose next transaction has failed at least once.

`rewind` and `delete-consumer` change a consumer's position, so they are refused
with `ConsumerLockedError` while it runs anywhere: stop the service (or the
`deliver` process) first, then start it again. `replay` and `discard` work while
it runs. `replay` needs the consumer's handler, which the CLI has only for the
configured [webhook](#webhooks) targets (`webhook:<name>`, with the same webhook
variables as the service); replay your own consumers with
`consumer.replayDeadLetter()` in the process that runs them. A failed replay keeps
the dead letter, with the new error, and exits 1.

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
| `TON_WATCH_WEBHOOK_SECRET` | — | HMAC-SHA256 signing secret; unsigned when unset |
| `TON_WATCH_WEBHOOK_ORDER` | `address` | `address` or `global` (see [ordering](#consumer-api)) |
| `TON_WATCH_WEBHOOK_FROM` | `start` | first run only: `start` (all indexed history), `now` or an lt |
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
`retryMinMs`, `retryMaxMs`, `onError`, `maxAttempts`. `"secret": null` sends that
target unsigned even when `TON_WATCH_WEBHOOK_SECRET` is set; an empty secret is
rejected, and so is a `retryMinMs` above the target's `retryMaxMs`.

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

**Request.** `POST` with `content-type: application/json` and these headers:

| header | |
|---|---|
| `Idempotency-Key` | `<raw address>:<lt>:<hex hash>` |
| `TON-Watch-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, when a secret is set |
| `TON-Watch-Replay` | `1` on a replayed dead letter; absent otherwise |

```jsonc
{
  "id": "0:83df…:47213860000001:9c1f…",  // idempotency key
  "webhook": "billing",                  // target name
  "address": { "raw": "0:83df…", "friendly": "EQCD…" },
  "lt": "47213860000001",                // decimal string
  "hash": { "hex": "9c1f…", "base64": "nB8…" },
  "utime": 1717000000,
  "prev": { "lt": "47213850000003", "hash": { "hex": "…", "base64": "…" } },  // null for the account's first tx
  "boc": "te6cck…",                      // the transaction cell, base64
  "parsed": {                            // ton-watch/parse summary; null if the BOC does not parse
    "type": "generic", "success": true, "aborted": false,
    "compute": { "type": "vm", "success": true, "exitCode": 0, "gasUsed": "309" },
    "action": { "success": true, "resultCode": 0, "totalActions": 0, "skippedActions": 0 },
    "receivedBounce": false, "bouncedBack": false, "direction": "incoming",
    "inMessage": {
      "type": "internal", "src": "0:…", "dest": "0:83df…", "value": "1500000000",
      "op": 0, "queryId": null, "comment": "order 42",
      "body": { "kind": "text-comment", "text": "order 42" },
      "bounce": false, "bounced": false, "fwdFee": "266669", "extraFlags": "0",
      "extraCurrencies": {}, "createdLt": "47213860000000", "createdAt": 1717000000
    },
    "outMessages": [],
    "totalFees": "102415", "valueIn": "1500000000", "valueOut": "0"
  },
  "replay": false                        // true when a dead letter is replayed
}
```

In `parsed`, bigints are decimal strings, nested addresses are raw strings
(`0:<hex>`), cells are base64 BOCs and binary data is base64; the field names
are those of `ParsedTransaction` in [`ton-watch/parse`](src/parse/types.ts)
(without `raw`, and without the fields already at the top level). The friendly
address is the bounceable form (testnet form when `TON_NETWORK=testnet`).

A replay (`"replay": true`) arrives out of order — later transactions of the
address were delivered meanwhile — with the same `id` as the original attempts.
Deduplicate it like any other request: if an earlier attempt was processed after
all (e.g. one that timed out), answer 2xx without processing it again.

**Verifying the signature.** Compute the HMAC over the raw body bytes as received
(before any JSON parsing), compare in constant time, and reject old timestamps so
a captured request cannot be replayed later. Five minutes is a reasonable window;
every retry is signed afresh, so it never rejects a legitimate retry. Pair it with
the idempotency key to drop replays inside the window.

`ton-watch/webhook` has the check (and the body's `WebhookPayload` type); it
depends only on `node:crypto`:

```ts
import { SIGNATURE_HEADER, verifySignature, type WebhookPayload } from "ton-watch/webhook";

// e.g. Bun.serve / fetch handlers:
const body = await request.text();
if (!verifySignature(SECRET, body, request.headers.get(SIGNATURE_HEADER))) {
  return new Response(null, { status: 401 });
}
const payload: WebhookPayload = JSON.parse(body);
```

`verifySignature(secret, body, header, { toleranceSeconds = 300 })` checks the
HMAC in constant time and rejects timestamps further than the tolerance from now.

**Delivery apart from indexing.** `ton-watch deliver` runs only the webhook
consumers: no liteserver connection, same database and webhook settings. Run the
indexer with no webhook variables and one `deliver` process next to it to
restart, deploy or scale delivery without touching indexing. A `deliver` process
learns about new transactions by polling the store (every second). Run each
target in one process at a time: `deliver` exits 1 with `ConsumerLockedError` if
a target already runs elsewhere (and starts none of them). `/health` and
`/status` report the webhook consumers; `/metrics` their counters; `/consumers`
every consumer in the database.

### Metrics

| metric | |
|---|---|
| `ton_watch_address_lag_seconds{address}` | chain tip time minus the time the address was last known complete |
| `ton_watch_address_gaps_open{address}`, `ton_watch_gaps_open` | missing ranges currently known |
| `ton_watch_tx_written_total`, `ton_watch_tx_written_per_second` | write throughput |
| `ton_watch_errors_total{kind,where}` | `rate_limit`, `timeout`, `archive_unavailable`, `not_ready`, `bad_response`, `network`, `unknown` |
| `ton_watch_source_calls_total{method}` | liteserver calls |
| `ton_watch_walks`, `ton_watch_walks_stuck` | ranges being fetched / waiting for an archival server |
| `ton_watch_tip_seqno`, `ton_watch_max_lag_seconds` | |
| `ton_watch_consumer_delivered_total{consumer}` | transactions handed to the handler and committed |
| `ton_watch_consumer_errors_total{consumer}` | failed handler calls |
| `ton_watch_consumer_skipped_total{consumer}`, `ton_watch_consumer_dead_letters_total{consumer}` | transactions given up on (`onError`) |
| `ton_watch_consumer_replayed_total{consumer}` | dead letters replayed successfully |
| `ton_watch_consumer_lag_transactions{consumer}`, `ton_watch_consumer_lag_seconds{consumer}` | the consumer's backlog (see [Managing consumers](#managing-consumers)) |
| `ton_watch_consumer_watermark_lt{consumer}` | global order: lt the stream is released up to |

## Addresses

- `addAddress(addr, { from })`: `"now"` (default — only new transactions),
  `"genesis"` (full history) or an lt. Works at runtime; the running indexer picks
  it up on its next tick, also when added from another process.
- `removeAddress(addr)` stops tracking and keeps the data; `{ purge: true }` deletes
  it with its consumer cursors and dead letters.

## Liteservers

`LiteSource` connects to every server in the config and spreads calls over them:
fastest and least loaded first, a bounded number of requests per server, and per
error kind:

- **rate limited** → that server cools down (exponential, capped at 30s); the call
  moves on.
- **timeout / network** → short cooldown, retry elsewhere.
- **not found** → try the other servers, then the archival ones
  (`archiveServers` / `TON_ARCHIVE_CONFIG`). A range nobody serves is retried every
  10 minutes and reported as stuck — it is never skipped.
- Queries carry `waitMasterchainSeqno`, so a server a few blocks behind waits
  instead of answering "not found" for something it has not seen yet.
- Every page is checked before it is written: it must start at the requested
  transaction and every prev link inside it must hold.

### How far back public liteservers go

Measured 2026-10-06 (full table in [`bench/RESULTS.md`](bench/RESULTS.md)): 11 of the 12 reachable public mainnet liteservers serve account transactions back **35–41 days**; one (185.86.79.9) is archival back past a year but missing roughly days 3–50. Old **account state** is served for less than a day — which is why an indexer that reads state "as of" each block cannot recover from a multi-day stall, while this one can.

**For more than ~a month of history** (including recovery from an outage longer
than that), configure an archival liteserver or plug in toncenter (below).

## Optional: toncenter history plug-in (experimental)

A separate import that the core never loads on its own. Leave it out and nothing
changes.

> **Experimental.** Tested without paying: unit tests replay a recorded toncenter
> response, and `LIVE=1 bun test tests/live.test.ts` checks it against liteservers
> on mainnet using the free tier (no key, 1 request/s). Paid-plan rate limits and
> long runs at volume are **not** tested. The safety net still applies: every page
> is re-hashed and chain-checked, so a wrong answer is refetched, never stored.

```ts
import { ToncenterHistory } from "ton-watch/toncenter";

new TonWatch({
  store,
  source,
  history: {
    source: new ToncenterHistory({ apiKey: process.env.TONCENTER_API_KEY }), // key optional
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
  `TONCENTER_API_KEY`, `TONCENTER_ENDPOINT`.
- Any other provider plugs in the same way: implement `HistorySource`
  (`getTransactions(address, from, count)`, optionally `busy()`).

## Storage

`Store` is an interface (`src/stores/store.ts`); `PgStore` is the reference
implementation (works with `pg` and PGlite), `MemoryStore` the minimal one.

Postgres tables in schema `ton_watch`: `addresses`, `transactions`
(primary key `(address_id, lt)`, which serves ordered reads, prev-link lookups and
gap floors — no other index needed), `cursors` (with the failure state of the
transaction after each cursor), `consumers`, `dead_letters`, `schema_migrations`.

Size: a transaction is stored as its BOC (667 bytes on average in our
benchmarks) plus ~110 bytes of row data and index — roughly **1 GB per million
transactions**. There is no automatic retention; delete old rows per address with
plain SQL if you need to (keep rows at or above each consumer's cursor).

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

## Development

```sh
bun test                                   # 93 tests: unit, indexer, consumer, end-to-end, PGlite; deterministic
TEST_DATABASE_URL=postgres://… bun test    # also run the store contract on real Postgres
LIVE=1 bun test tests/live.test.ts         # mainnet: last 3000 txs of a busy address vs toncenter,
                                           # toncenter pages vs liteserver pages
bun run typecheck                           # strict tsc over src/, tests/, bench/
bun run lint                                # Biome (root biome.json); `bun run format` applies fixes
```

Source layout (`src/`): `core/` domain types and chain-link rules, `indexer/`
(the `Indexer` orchestrator plus walk scheduling, fetching, splitting, change
detection and maintenance), `consumer/`, `source/` (`TxSource`, `liteserver/`),
`stores/` (`memory/`, `pg/`), `plugins/toncenter/`, `service/` + `bin/` (the
CLI), `metrics/`, `util/`. Tests mirror it.

Benchmarks (`bench/`, mainnet): `accounts.ts` picks the address sets, then
`archive-depth.ts`, `backfill.ts`, `block-scan.ts`, `outage.ts`, `idle.ts`;
`report.ts` renders `bench/RESULTS.md`.
