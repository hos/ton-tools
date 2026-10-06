# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a bun workspace monorepo (`packages/*`); there is no root build/lint/test aggregator, so run commands from within the relevant package.

- Install (root): `bun install`
- Run ton-watch: `cd packages/ton-watch && bun run start` (= `bun run src/bin/ton-watch.ts run`; needs `DATABASE_URL`)
- Test a package: `cd packages/ton-ls && bun test` or `cd packages/ton-watch && bun test`
- Test a single file: `bun test tests/filter.test.ts`
- Publish `@ton/ls` to JSR: `cd packages/ton-ls && bun run publish` (`bunx jsr publish`); bump both `packages/ton-ls/package.json` and `packages/ton-ls/jsr.json` versions in sync, they are not linked automatically
- Type-check: no dedicated script; all tsconfigs set `noEmit: true` (bun executes TS directly), use `bunx tsc --noEmit` in a package if needed
- No lint/formatter is configured in this repo

Tests use `bun:test` and rely on `spyOn` to mock module functions (see `packages/ton-ls/tests/filter.test.ts`) — mock at the module level (`spyOn(Filter, "benchmark")`), not via DI.

Of the four directories under `packages/`, only `ton-ls` and `ton-watch` are real, git-tracked workspace packages. `nft-collection-editor` and `ton-nft-mint` exist on local disk as empty, untracked scaffolding (no `package.json`) — ignore them.

## Architecture

Two independent packages that share no source, linked only via the bun workspace (`ton-watch` depends on `@ton/ls` as `workspace:*`).

### `@ton/ls` (packages/ton-ls) — LiteServer filtering

Picks the fastest/healthiest TON LiteServer nodes out of a network config, so callers don't hardcode or hand-pick nodes.

- `getServers()` (src/filter.ts) resolves a `ServerDefinition` — `"mainnet"`, `"testnet"`, a config URL, or a literal `LsConfig[]` — into a list of LiteServer configs, fetching `https://ton.org/{,testnet-}global.config.json` for the named networks.
- `filterLiteServers()` benchmarks every server concurrently via `benchmark()` (repeated `getMasterchainInfo()` calls, up to 100 or until `timeout`), then buckets results: `good` = `successCount > 0`, `fast` = within `divergeFromAvg` ms of the `good` average timing.
- Published standalone to JSR as `@ton/ls`.

### `ton-watch` (packages/ton-watch) — embeddable address transaction indexer

Library (`src/index.ts`) plus a service/CLI (`src/bin/ton-watch.ts`, `bun run start`). Indexes every transaction of an explicit address set; not a full-chain indexer. User-facing docs and benchmark numbers live in `packages/ton-watch/README.md`.

- Core rule: **writes in any order, reads in chain order**. Each tx links to its predecessor via `prevLt`/`prevHash`; completeness is derived from those links, never from fetch order. An address's `frontier` is the newest tx with an unbroken chain down to `startLt`; consumers are never handed anything past it.
- `Indexer` (src/indexer.ts) schedules *walks*: backward page-by-page fetches over a missing range (`floorLt`, `topLt`]. Head walks come from change detection, gap walks from `store.findGaps()` — so the store itself is the job queue and a crash just leaves gaps to refill. Pages from all walks share one bounded `concurrency`; long walks are split into parallel pieces via `source.findTxNear()`.
- Change detection: `poll` (one account-state call per address, idle backoff) or `blocks` (list each new shard block once; cost independent of address count); `auto` switches at `autoBlocksThreshold`.
- `syncedLt` = chain lt up to which an address is known complete even without new txs; `min(max(frontier, syncedLt))` over addresses is the cross-address watermark used by `order: "global"` consumers.
- `Consumer` (src/consumer.ts) delivers per address (default) or globally, persists a cursor per (consumer, address), halts and retries on handler failure. With `PgStore` the handler's `ctx.db` writes commit atomically with the cursor.
- `TxSource` (src/source/source.ts) abstracts the chain. `LiteSource` uses `ServerPool` (src/source/pool.ts) for rotation, rate-limit cooldown, timeouts and archival fallback; errors are classified in src/errors.ts. Last-tx lookup parses the state proof directly (src/source/account-proof.ts) because ton-lite-client's account parser throws on some accounts.
- `Store` (src/stores/store.ts): `PgStore` (reference; migrations in src/stores/pg/migrations.ts, default schema `ton_watch`, works with `pg` and PGlite) and `MemoryStore`. Inserts are `on conflict do nothing`; migrations never drop.
- Tests run against a synthetic chain with real tx cells (`tests/fixtures/fake-chain.ts`) and PGlite; set `TEST_DATABASE_URL` to also run the store contract on a real Postgres. `LIVE=1` enables `tests/live.test.ts` (mainnet).
- `ton-watch/toncenter` (src/toncenter/) is an optional `HistorySource` plug-in (indexer option `history`, modes `fallback`/`boost`); the core never imports it. Its pages go through the same `validatePage` as liteserver pages.
- TypeScript 7: tsconfigs must list `"types": ["bun"]` — TS 7 no longer auto-includes `@types/*`. A root `overrides` pins one `@ton/core` for every package (ton-lite-client otherwise pulls an older copy).
- Benchmarks in `bench/` hit mainnet public liteservers and write `bench/results/*.json`; `bench/accounts.ts` fixes the address sets first.
