# Schema migrations

`PgStore.migrate()` (run by `TonWatch.start()` and the service) brings a schema up to
date from `src/stores/pg/migrations.ts`. Your database holds data that took days of
liteserver calls to collect, so every migration has to be safe to run on it, while
other instances may still be running.

## Promise to users

- **Never destructive.** No migration drops, deletes, truncates, renames or retypes
  anything. Old columns and tables stay; at worst they stop being used.
- **Concurrent-safe.** Any number of processes may call `migrate()` at once. They
  serialize on the advisory lock `hashtext('ton_watch:<schema>')`.
- **Tamper-evident.** Each applied migration's checksum (sha256 of its statements,
  whitespace-insensitive) is stored in `<schema>.schema_migrations`. If an applied
  migration differs from the code's, `migrate()` throws `MigrationError` with code
  `modified` and changes nothing.
- **Rolling deploys.** A new version migrates the schema, and old instances keep
  running until they are replaced. If an old instance restarts, its `migrate()` finds
  versions it does not know. Every migration stores `compatible_from`: the oldest
  version whose code still works with it. The old instance starts if every newer
  migration's `compatible_from` is at or below its own version. Otherwise it fails
  with `MigrationError` code `too_new` and touches nothing. This allows expand-only
  changes, which old code tolerates by construction. Changes that would let old code
  silently write wrong data are refused, because a crash at startup is easier to
  recover from than corrupted data.
- A schema whose history cannot be reconciled with the code is refused with code
  `diverged`. That covers a pre-release schema, an unknown version below the newest
  known one, and a gap in the history.

## Rules for a new migration

1. **Append only.** Use the next version number. A migration is frozen once it is
   committed (see below); fix a mistake with another migration.
2. **Expand, then contract, and never actually contract.** Add tables, nullable
   columns, columns with a default, and indexes. Stop using an old column in code
   instead of dropping it.
3. Write every table as `$S.<table>`; the runner substitutes the quoted schema.
4. A new `not null` column needs a `default`, or old code's inserts fail.
5. A new check or foreign key goes in as `not valid`, then `validate constraint` in a
   later statement. Validation takes a weaker lock.
6. **Big tables** (`transactions`): never hold a long exclusive lock on them.
   - Build indexes with `create index concurrently if not exists <name> on $S.transactions …`
     in a migration with `transaction: false`. Such a migration runs statement by
     statement outside a transaction. If it is interrupted, the next `migrate()`
     re-runs it from the start, so every statement must be idempotent
     (`if not exists`). An index left INVALID by a crashed build is dropped and
     rebuilt automatically.
   - For a unique constraint, build a unique index concurrently, then
     `add constraint … unique using index …`.
   - Backfill large tables in batches from application code, not in a migration.
7. Set `compatibleFrom` only if older code keeps working with the change. Pure
   additions usually qualify. Leaving it unset makes older code refuse to start.

`tests/stores/migrations.test.ts` enforces rules 3–6 statically. A statement that has
to break one, after review, goes into `REVIEWED_EXCEPTIONS` there with the reason.

## Adding migration N

1. Append it to `migrations` in `src/stores/pg/migrations.ts`.
2. Run `UPDATE_MIGRATION_FIXTURES=1 bun test tests/stores/migrations.test.ts`. This
   freezes `tests/fixtures/migrations/frozen/000N-<name>.json` (statements and pinned
   checksum) and rewrites `tests/fixtures/migrations/schema.snapshot`. Review both
   diffs. The snapshot should change only by what the migration adds.
3. If the migration adds tables or columns that hold data, add `seeds[N]` in
   `tests/fixtures/migrations/history.ts`. Write it as raw SQL against the version-N
   schema, and extend `checkLatest` in `tests/stores/migration-upgrade.test.ts` to
   use the new data.
4. Run `bun test`, and `TEST_DATABASE_URL=… bun test` against real Postgres.

The upgrade harness then automatically covers every released version, with no new
test code:
- it builds a database at each version from the frozen migrations and seeds;
- it migrates it with today's code;
- it checks that no existing row or column changed;
- it checks that the schema equals a fresh one;
- it runs today's store, indexer and consumer on it;
- it checks that each older version's code starts against the new schema only if
  `compatibleFrom` allows it.

Until the migration is released you may still change it: delete its frozen file and
regenerate. Once released, never edit, renumber or delete it. CI fails if you do.
