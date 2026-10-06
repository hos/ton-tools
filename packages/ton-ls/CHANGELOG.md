# Changelog

All notable changes to `@ton/ls` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.4] - 2026-10-07

### Added

- `LiteConnection` (and `LiteConnectionOptions`): a ton-lite-client `LiteEngine`
  for one liteserver whose `close()` is final and leaves nothing running — it
  cancels reconnecting and query timeouts, destroys the socket (also mid-handshake)
  and rejects pending queries. Moved here from `@ton/watch`.

### Fixed

- `benchmark()`, and so `filterLiteServers()`, never closed its connections:
  ton-lite-client's `LiteSingleEngine` kept the process alive after the benchmark
  (an unreachable server forever, through a reconnect every 30s). It now uses
  `LiteConnection` and closes every connection before resolving, on timeout and on
  errors too.

### Changed

- The published package contains only `src`, the README, this changelog and the
  license (no tests or tsconfig).

[0.0.4]: https://github.com/hos/ton-tools/releases/tag/ton-ls-v0.0.4
