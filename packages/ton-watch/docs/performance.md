# Performance

[← @ton/watch](../README.md)

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
