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
});
consumer.status();
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

**Failures never skip.** A throwing handler halts its address (or the whole stream
in global order) and the same transaction is retried with backoff (1s → 60s).

**Exactly once.** The cursor is persisted after every transaction. With `PgStore`
and `transactional: true` (default) the handler runs inside the transaction that
commits the cursor and receives it as `ctx.db`; writes made through it are exactly
once even across crashes. Side effects outside that database (HTTP calls, messages)
are at-least-once — make them idempotent (e.g. keyed by `tx.hash`). Run each
consumer name in one process at a time.

## Service

`bun run start` (= `ton-watch run`) runs the indexer until SIGINT/SIGTERM, then
finishes in-flight work and exits. It never drops data: schema changes are
versioned migrations (`<schema>.schema_migrations`).

```sh
DATABASE_URL=postgres://… bun run start
bun run cli add <address> [--from now|genesis|<lt>]
bun run cli remove <address> [--purge]
bun run cli list
```

| env | default | |
|---|---|---|
| `DATABASE_URL` | — | required |
| `TON_WATCH_SCHEMA` | `ton_watch` | Postgres schema for all tables |
| `TON_NETWORK` | `mainnet` | `mainnet`, `testnet` or a global config URL |
| `TON_ARCHIVE_CONFIG` | — | config URL with archival liteservers, used only for history the others pruned |
| `TON_WATCH_ADDRESSES` | — | `addr[@now\|genesis\|lt],…` added on start if missing |
| `TON_WATCH_PORT` | `9464` | `/health`, `/metrics` (Prometheus), `/status` |
| `TON_WATCH_CONCURRENCY` | `16` | liteserver pages in flight |
| `TON_WATCH_DETECT` | `auto` | `poll`, `blocks` or `auto` |
| `TON_WATCH_LOG` | `info` | `debug`, `info`, `warn`, `error` |

`/health` is `ok`, `degraded` (lag above 120s, or a range no liteserver serves) or
`down` (503: not running, or no successful tick for 60s).

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

## Addresses

- `addAddress(addr, { from })`: `"now"` (default — only new transactions),
  `"genesis"` (full history) or an lt. Works at runtime; the running indexer picks
  it up on its next tick, also when added from another process.
- `removeAddress(addr)` stops tracking and keeps the data; `{ purge: true }` deletes
  it with its consumer cursors.

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

## Optional: toncenter history plug-in

A separate import that the core never loads on its own. Leave it out and nothing
changes.

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
gap floors — no other index needed), `cursors`, `schema_migrations`.

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
bun test                                   # 91 tests: unit, indexer, consumer, end-to-end, PGlite; deterministic
TEST_DATABASE_URL=postgres://… bun test    # also run the store contract on real Postgres
LIVE=1 bun test tests/live.test.ts         # mainnet: last 3000 txs of a busy address vs toncenter,
                                           # toncenter pages vs liteserver pages
bun run typecheck
```

Benchmarks (`bench/`, mainnet): `accounts.ts` picks the address sets, then
`archive-depth.ts`, `backfill.ts`, `block-scan.ts`, `outage.ts`, `idle.ts`;
`report.ts` renders `bench/RESULTS.md`.
