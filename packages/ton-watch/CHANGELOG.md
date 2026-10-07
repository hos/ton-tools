# Changelog

All notable changes to ton-watch are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
[stability policy](docs/stability.md) (semver, where a 0.x minor release
may break and a patch release never does).

## [0.1.3] - 2026-10-07

### Changed

- Documentation only: the reference is one page per topic under `docs/`
  (consumers, API, decoding, service, webhooks, metrics, liteservers, storage,
  performance, stability, development), listed by feature in the README.

## [0.1.2] - 2026-10-07

### Changed

- Documentation only: the README is now a short introduction (quickstart and
  recipes for TON payments, jettons and webhooks); the full reference moved,
  unchanged, to `docs/library.md`, `docs/service.md` and `docs/operations.md`.

## [0.1.1] - 2026-10-07

### Changed

- Documentation only: `@ton/watch/parse` has a module doc, and README links to
  files that are not part of the published package (examples, benchmarks, test
  fixtures, release steps) point to GitHub instead of breaking on jsr.io.

## [0.1.0] - 2026-10-07

First release, published on JSR as [`@ton/watch`](https://jsr.io/@ton/watch)
(Bun only; not on npm). Requires [`@ton/ls`](https://jsr.io/@ton/ls) 0.0.4, which
must be published first (it provides `LiteConnection`).

### Added

- `TonWatch`: indexes every transaction of an explicit set of addresses from TON
  liteservers — fetched in any order and in parallel, delivered strictly in chain
  order and never past a gap. Outages of days or weeks are a backlog, not a jam.
- Consumers (`watch.process()`): per-address or global (`order: "global"`,
  watermark-based) delivery; persisted cursors; exactly-once handler writes through
  `ctx.db` with the transactional `PgStore`, at-least-once otherwise; retry, skip
  and dead-letter failure policies with replay and discard; single-instance locks
  with hot standby (`lock: "wait"`); rewind, delete and lag across processes.
  `TonWatch<Db>` types `ctx.db` from the store.
- Addresses as `Address` or friendly/raw strings; every output uses lowercase raw.
  `addAddress(address, { from: "now" | "earliest" | lt })` at runtime.
- Change detection by polling or by listing new shard blocks (`detect: "auto"`
  switches by address count); long missing ranges split into parallel walks.
- `LiteSource`: liteserver pool with rotation, rate-limit cooldown, timeouts,
  archival fallback and per-page chain validation.
- Stores: `PgStore` (`pg` or PGlite; schema `ton_watch`) and `MemoryStore`.
  Never-destructive, checksummed, concurrent-safe migrations with a compatibility
  guard for rolling deploys ([docs/migrations.md](docs/migrations.md)).
- `TonWatchError` with stable codes and the `isTonWatchError` guard;
  `ConsumerLockedError`, `CursorConflictError`, `MigrationError`, `SourceError`.
- `health({ maxLagSeconds })`, `status()`, `watermark()`; `stop()` (pause) vs
  `close()` (final, closes store and source).
- Prompt `stop()`/`close()`: nothing new starts and nothing is retried once
  stopping; requests in flight get `stopTimeoutMs` (default 5s, `0` abandons at
  once), then are abandoned through an `AbortSignal` and refetched after the next
  start as gaps. Both always resolve; a consumer handler in progress is never
  interrupted and is waited for. `close()` rejects only if closing the source or
  store fails. `TxSource` and `HistorySource` methods take an optional
  `{ signal }` (`SourceCallOptions`; `findTxNear` takes `FindTxNearOptions`).
- `@ton/watch/parse`: transaction decoding — outcome and bounce flags, comments,
  TEP-74 jettons, TEP-62 NFTs, `incomingPayment` and `incomingJettonTransfer`.
- `@ton/watch/webhook`: receiver side of the service webhooks — `verifySignature`
  (several secrets, for rotation), header names, `WebhookPayload` types.
- `@ton/watch/toncenter` (experimental): toncenter as a history plug-in, in
  `fallback` or `boost` mode.
- `@ton/watch/advanced` (experimental): standalone `Indexer` and `Consumer`, the
  `Store` and `TxSource` contracts, chain helpers.
- Service and CLI (`ton-watch`): `run`, `deliver`, `add`, `remove`, `list`, and
  consumer management (`consumers`, `rewind`, `dead-letters`, `replay`, `discard`,
  `delete-consumer`); configuration through `TON_WATCH_*` environment variables.
  Run from the installed package through `run()` in `@ton/watch/cli`.
- Webhook delivery (payload `version: 1`): signed with HMAC-SHA256
  (`TON-Watch-Signature`, rotation via `TON_WATCH_WEBHOOK_SECRET_PREVIOUS`),
  `Idempotency-Key`, per-target ordering, retry, skip or dead-letter.
- HTTP endpoints: `/health` and `/consumers` (stable JSON, `version: 1`),
  `/metrics` (Prometheus, with `ton_watch_build_info` and opt-in per-address
  series), `/status` (unstable).

[0.1.1]: https://github.com/hos/ton-tools/releases/tag/ton-watch-v0.1.1
[0.1.0]: https://github.com/hos/ton-tools/releases/tag/ton-watch-v0.1.0
