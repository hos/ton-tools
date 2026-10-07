# Development

[← @ton/watch](../README.md)

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
