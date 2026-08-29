# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a bun workspace monorepo (`packages/*`); there is no root build/lint/test aggregator, so run commands from within the relevant package.

- Install (root): `bun install`
- Run ton-watch: `cd packages/ton-watch && bun run start` (equivalent to `bun run src/index.ts`)
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

### `ton-watch` (packages/ton-watch) — address transaction indexer

Incrementally indexes transactions for a small, explicit set of TON addresses into Postgres. Per its README, this is deliberately not built for full-chain indexing (points to `ton-indexer`/`ton-index-worker` for that); it targets ~1000 tx/min for a handful of watched addresses.

- `getLiteClient()` (src/lite-client.ts) builds a `LiteRoundRobinEngine` from `@ton/ls`'s `fast` server list and caches the resulting `LiteClient` in-memory, keyed by an md5 hash of the server config (or the network name).
- `Watch` (src/watch.ts) is the poll loop: for each stored address, `getCursor()` picks where to resume — it prefers repairing gaps found by `store.getOldestNoPrevTx()` (transactions whose `prev_lt`/`prev_hash` link is missing) before comparing on-chain `lastTx` against the store's latest transaction — then pages backward through `liteClient.getAccountTransactions()` (max page size 16) and writes results through the `Store` interface.
- `Store` (src/stores/store.ts) is the storage abstraction (`start`, `setAddress`, `allAddresses`, `getOldestTx`/`getLatestTx`/`getOldestNoPrevTx`, `write`, `close`); `PgStore` (src/stores/pg/pg-store.ts) is the only implementation. It creates the `addresses`/`transactions` tables, dedupes via `existsList` before insert, and serializes `@ton/core` `Transaction`s (only `internal` or `external-in` messages) to BOC bytes + row data.
- `InsertQuery()` (src/stores/pg/pg-client.ts) is a small typed multi-row insert builder used by `PgStore.write`. The same file monkey-patches `pg`'s `Query.prototype.submit` so any query containing `--debug` gets logged with params interpolated inline.
- Config is env-based (src/config.ts): `TON_NETWORK_CONFIG_URL`, `DATABASE_URL`.
- `src/index.ts` is currently a one-off manual driver script with a hardcoded address, not a long-running service — building an actual entrypoint/listener is tracked in `hos/ton-tools#1`.
