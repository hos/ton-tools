# Stability policy

[← @ton/watch](../README.md)

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
  the [stable columns](storage.md#querying-the-tables).

**Not covered:** `@ton/watch/advanced` (experimental; custom `Store` and `TxSource`
implementations are unsupported in 0.x), `@ton/watch/toncenter` (experimental),
`/status`, log output, error messages, and the internal tables and columns.

**Deprecation.** Before something covered is removed or changed, it is marked
`@deprecated` (and listed in the changelog) for at least one minor release, and
using it logs a runtime warning.
