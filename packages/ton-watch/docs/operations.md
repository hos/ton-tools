# Operating ton-watch

Liteservers and how far back they go, the toncenter plug-in, storage and retention, benchmarks, the stability policy and development. For a first look, start with the [README](../README.md).

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

Measured 2026-10-06 (full table in [`bench/RESULTS.md`](https://github.com/hos/ton-tools/blob/main/packages/ton-watch/bench/RESULTS.md)): 11 of the
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
import { ToncenterHistory } from "@ton/watch/toncenter";

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
  `@ton/watch/advanced` (`getTransactions(address, from, count)`, optionally `busy()`).

## Storage

`PgStore` is the reference store (works with `pg` and PGlite); `MemoryStore` keeps
everything in process memory, for tests and short-lived tools. Both implement the
`Store` contract (`@ton/watch/advanced`, experimental; custom implementations are
unsupported in 0.x).

`PgStore` keeps its tables in schema `ton_watch` (option `schema`, env
`TON_WATCH_SCHEMA`): `addresses`, `transactions` (primary key `(address_id, lt)`,
which serves ordered reads, prev-link lookups and gap floors — no other index
needed), `cursors` (with the failure state of the transaction after each cursor),
`consumers`, `dead_letters`, `schema_migrations`. Schema changes follow
[docs/migrations.md](migrations.md): never destructive, safe to run from
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
and every run in [`bench/RESULTS.md`](https://github.com/hos/ton-tools/blob/main/packages/ton-watch/bench/RESULTS.md).

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
Breaking changes are listed in [CHANGELOG.md](../CHANGELOG.md).

**Covered:**

- the exports of `@ton/watch`, `@ton/watch/webhook`, `@ton/watch/parse` and
  `@ton/watch/cli` (runtime
  names and types; `api/*.d.ts` snapshots every one);
- error codes (`TonWatchErrorCode`) — not messages;
- the webhook payload, `version: 1`, and its headers;
- the stable service JSON: `/health`, `/consumers`, and `list`, `consumers`,
  `dead-letters` output (`version: 1`);
- CLI commands and arguments, and the environment variables;
- metric names, types and label names;
- the database schema, changed only through [migrations](migrations.md), and
  the [stable columns](#querying-the-tables).

**Not covered:** `@ton/watch/advanced` (experimental; custom `Store` and `TxSource`
implementations are unsupported in 0.x), `@ton/watch/toncenter` (experimental),
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
  [docs/migrations.md](migrations.md)).

Source layout (`src/`): `core/` domain types, errors and chain-link rules,
`indexer/` (the `Indexer` orchestrator plus walk scheduling, fetching, splitting,
change detection and maintenance), `consumer/`, `source/` (`TxSource`,
`liteserver/`), `stores/` (`memory/`, `pg/` with `migrations.ts` and `migrator.ts`),
`parse/`, `webhook/` (receiver side), `plugins/toncenter/`, `service/` + `cli.ts` +
`bin/` (the CLI), `metrics/`, `util/`. Tests mirror it.

Releasing (version bumps, tags, JSR publishing): [RELEASING.md](https://github.com/hos/ton-tools/blob/main/RELEASING.md).

Benchmarks (`bench/`, mainnet): `accounts.ts` picks the address sets, then
`archive-depth.ts`, `backfill.ts`, `block-scan.ts`, `outage.ts`, `idle.ts`;
`report.ts` renders `bench/RESULTS.md`.
