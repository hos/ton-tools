# Metrics

[← @ton/watch](../README.md)

`/metrics` (and `watch.metrics.toPrometheus()` in the library) exports exactly the
metrics below, each with `# HELP` and `# TYPE`; the list is `METRICS` in
[`src/metrics/registry.ts`](../src/metrics/registry.ts). Label values are bounded:
`method` and `where` take values from closed sets (anything else is `other`), and
`address` series exist only with the opt-in `addressMetrics` indexer option
(`TON_WATCH_ADDRESS_METRICS=true`), since with many addresses they multiply the
series Prometheus has to keep.

| metric | type | |
|---|---|---|
| `ton_watch_build_info{version}` | gauge | always 1; `version` is the running ton-watch version |
| `ton_watch_addresses` | gauge | addresses being indexed |
| `ton_watch_tip_seqno`, `ton_watch_tip_utime` | gauge | newest chain tip seen |
| `ton_watch_max_lag_seconds` | gauge | largest address lag: chain tip time minus the time the address was last known complete |
| `ton_watch_gaps_open` | gauge | missing ranges currently known |
| `ton_watch_walks`, `ton_watch_walks_stuck` | gauge | ranges being fetched / waiting for an archival server |
| `ton_watch_address_lag_seconds{address}` | gauge | per-address lag; **opt-in** (`addressMetrics`) |
| `ton_watch_address_gaps_open{address}` | gauge | per-address missing ranges; **opt-in** (`addressMetrics`) |
| `ton_watch_walks_started_total{kind}` | counter | walks started, `head` or `gap` |
| `ton_watch_pages_total{kind}` | counter | pages fetched and stored, by walk kind |
| `ton_watch_tx_written_total` | counter | transactions newly stored; use `rate()` for throughput |
| `ton_watch_splits_total`, `ton_watch_split_points_total` | counter | long walks split into parallel pieces / split points found |
| `ton_watch_detect_fallbacks_total` | counter | block listings that failed, so every address was polled instead |
| `ton_watch_reconcile_misses_total` | counter | transactions the block listing missed, found by reconciliation polling |
| `ton_watch_history_pages_total{source,why}` | counter | pages served by the history plug-in, `why` = `fallback` or `boost` |
| `ton_watch_source_calls_total{method}` | counter | chain calls by method |
| `ton_watch_errors_total{kind,where}` | counter | failures by `kind` (`rate_limit`, `timeout`, `archive_unavailable`, `not_ready`, `bad_response`, `network`, `unknown`) and where they happened |
| `ton_watch_consumer_delivered_total{consumer}` | counter | transactions handed to the handler and committed |
| `ton_watch_consumer_errors_total{consumer}` | counter | failed handler calls |
| `ton_watch_consumer_skipped_total{consumer}`, `ton_watch_consumer_dead_letters_total{consumer}` | counter | transactions given up on (`onError`) |
| `ton_watch_consumer_replayed_total{consumer}` | counter | dead letters replayed successfully |
| `ton_watch_consumer_lag_transactions{consumer}`, `ton_watch_consumer_lag_seconds{consumer}` | gauge | the consumer's backlog (see [Managing consumers](consumers.md#managing-consumers)) |
| `ton_watch_consumer_watermark_lt{consumer}` | gauge | global order: lt the stream is released up to (float64: use for `changes()`, not lt lookups) |
