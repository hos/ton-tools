# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a bun workspace monorepo (`packages/*`); there is no root build/lint/test aggregator, so run commands from within the relevant package.

- Install (root): `bun install`
- Run ton-watch: `cd packages/ton-watch && bun run start` (= `bun run src/bin/ton-watch.ts run`; needs `TON_WATCH_DATABASE_URL`; every env var is listed once in `ENV_VARS`, src/service/env.ts, and a test checks docs/ documents each)
- Test a package: `cd packages/ton-ls && bun test` or `cd packages/ton-watch && bun test`
- Test a single file: `bun test tests/filter.test.ts`
- Publish: JSR only, never npm (`@ton/ls` from packages/ton-ls, `@ton/watch` from packages/ton-watch). Pushing a tag `ton-ls-v<version>` / `ton-watch-v<version>` runs `.github/workflows/publish.yml` (checks, then `bunx jsr publish` via GitHub OIDC); steps in `RELEASING.md`. Bump the version in both `package.json` and `jsr.json` (plus ton-watch's `src/version.ts`); `tests/manifest.test.ts` in each package fails until name, version and exports agree. Check with `bunx jsr publish --dry-run --allow-dirty` in the package dir. On publish, `workspace:*` becomes `jsr:@ton/ls@^<ton-ls jsr.json version>` and npm deps become `npm:` specifiers; npm subpath imports need the file extension (`ton-lite-client/dist/schema.js`) and published modules must not import `package.json`
- Type-check: `cd packages/ton-watch && bun run typecheck` (= `tsc --noEmit -p .` over src/, tests/ and bench/, plus `tsconfig.api.json` which enforces `isolatedDeclarations` on the public entries); all tsconfigs set `noEmit: true` (bun executes TS directly). ton-watch's tsconfig is strict incl. `noUncheckedIndexedAccess` and `noUnused*`
- Lint + format: Biome, configured once in the root `biome.json`. `bun run lint` (check) / `bun run format` (write fixes) at the root or in either package

Tests use `bun:test` and rely on `spyOn` to mock module functions (see `packages/ton-ls/tests/filter.test.ts`) — mock at the module level (`spyOn(Filter, "benchmark")`), not via DI.

Of the four directories under `packages/`, only `ton-ls` and `ton-watch` are real, git-tracked workspace packages. `nft-collection-editor` and `ton-nft-mint` exist on local disk as empty, untracked scaffolding (no `package.json`) — ignore them.

## Architecture

Two independent packages that share no source, linked only via the bun workspace (`@ton/watch` depends on `@ton/ls` as `workspace:*`).

### `@ton/ls` (packages/ton-ls) — LiteServer filtering

Picks the fastest/healthiest TON LiteServer nodes out of a network config, so callers don't hardcode or hand-pick nodes.

- `getServers()` (src/filter.ts) resolves a `ServerDefinition` — `"mainnet"`, `"testnet"`, a config URL, or a literal `LsConfig[]` — into a list of LiteServer configs, fetching `https://ton.org/{,testnet-}global.config.json` for the named networks.
- `filterLiteServers()` benchmarks every server concurrently via `benchmark()` (repeated `getMasterchainInfo()` calls, up to 100 or until `timeout`), then buckets results: `good` = `successCount > 0`, `fast` = within `divergeFromAvg` ms of the `good` average timing.
- Published standalone to JSR as `@ton/ls`.

### `ton-watch` (packages/ton-watch) — embeddable address transaction indexer

Library plus a service/CLI (`src/bin/ton-watch.ts` → `src/cli.ts` → `src/service/`, `bun run start`; installed users run it through `run()` from `@ton/watch/cli`, JSR has no `bin`). Package name `@ton/watch`; the CLI command, DB schema (`ton_watch`), env prefix (`TON_WATCH_`) and metric prefix keep `ton-watch`/`ton_watch`. Domain types and chain-link rules live in `src/core/`; `src/util/` holds logger/backoff/async helpers. Indexes every transaction of an explicit address set; not a full-chain indexer. User-facing docs: a short `README.md` (quickstart + recipes) linking to one page per topic in `docs/` (consumers, api, decoding, service, webhooks, metrics, liteservers, storage, performance, stability, …); release notes in `CHANGELOG.md`.

- Entry points (package.json `exports`): `.` (src/index.ts), `./parse`, `./webhook` (receiver side: `verifySignature`, payload types; only `node:crypto`), `./cli` (`run()`), `./toncenter` and `./advanced` (both experimental; advanced = `Indexer`, `Consumer`, `Store`/`TxSource` contracts). Errors are `TonWatchError` with stable `code`s (src/core/errors.ts).
- Contract snapshots, regenerate deliberately and review the diff: `api/*.d.ts` (public types, `UPDATE_API_SNAPSHOT=1 bun test tests/api-snapshot.test.ts`), `tests/fixtures/golden/` (webhook payloads, `UPDATE_GOLDEN=1 bun test`), `tests/fixtures/migrations/` (frozen migrations + schema snapshot, `UPDATE_MIGRATION_FIXTURES=1 bun test tests/stores/migrations.test.ts`).
- Core rule: **writes in any order, reads in chain order**. Each tx links to its predecessor via `prevLt`/`prevHash`; completeness is derived from those links, never from fetch order. An address's `frontier` is the newest tx with an unbroken chain down to `startLt`; consumers are never handed anything past it.
- `Indexer` (src/indexer/indexer.ts) only orchestrates; the pieces live beside it: `walk-scheduler.ts` (shared concurrency, head-first priority, retry timers), `walk-runner.ts` (one page: fetch, write, advance/finish/retry), `page-fetcher.ts` (liteserver vs history plug-in), `walk-splitter.ts`, `change-detector.ts`, `maintenance.ts` (frontier, gaps, synced), `options.ts` (defaults). It schedules *walks*: backward page-by-page fetches over a missing range (`floorLt`, `topLt`]. Head walks come from change detection, gap walks from `store.findGaps()` — so the store itself is the job queue and a crash just leaves gaps to refill. Pages from all walks share one bounded `concurrency`; long walks are split into parallel pieces via `source.findTxNear()`.
- Change detection: `poll` (one account-state call per address, idle backoff) or `blocks` (list each new shard block once; cost independent of address count); `auto` switches at `autoBlocksThreshold`.
- `syncedLt` = chain lt up to which an address is known complete even without new txs; `min(max(frontier, syncedLt))` over addresses is the cross-address watermark used by `order: "global"` consumers.
- `Consumer` (src/consumer/consumer.ts) delivers per address (default) or globally, persists a cursor per (consumer, address), halts and retries on handler failure. With `PgStore` the handler's `ctx.db` writes commit atomically with the cursor.
- `TxSource` (src/source/source.ts) abstracts the chain. `LiteSource` (src/source/liteserver/) uses `ServerPool` (server-pool.ts) for rotation, rate-limit cooldown, timeouts and archival fallback; errors are classified in src/core/errors.ts. Last-tx lookup parses the state proof directly (src/source/liteserver/account-proof.ts) because ton-lite-client's account parser throws on some accounts.
- `Store` (src/stores/store.ts): `PgStore` (reference, src/stores/pg/; migrations in migrations.ts, runner in migrator.ts, rules in docs/migrations.md; default schema `ton_watch`, works with `pg` and PGlite) and `MemoryStore` (src/stores/memory/). Inserts are `on conflict do nothing`; migrations are append-only, checksummed and never drop.
- Tests run against a synthetic chain with real tx cells (`tests/fixtures/fake-chain.ts`) and PGlite; test files mirror the `src/` layout; set `TEST_DATABASE_URL` to also run the store contract on a real Postgres. `LIVE=1` enables `tests/live.test.ts` (mainnet).
- `@ton/watch/toncenter` (src/plugins/toncenter/) is an optional `HistorySource` plug-in (indexer option `history`, modes `fallback`/`boost`); the core never imports it. Its pages go through the same `validatePage` as liteserver pages.
- TypeScript 7: tsconfigs must list `"types": ["bun"]` — TS 7 no longer auto-includes `@types/*`. A root `overrides` pins one `@ton/core` for every package (ton-lite-client otherwise pulls an older copy).
- Benchmarks in `bench/` hit mainnet public liteservers and write `bench/results/*.json`; `bench/accounts.ts` fixes the address sets first.
