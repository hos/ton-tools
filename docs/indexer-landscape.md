# Indexing a selected set of TON addresses: what exists, what it costs

Survey done 2026-10-06 for ton-watch. It answers one question: **has someone already solved
"every transaction of a few hundred to a few thousand chosen addresses, delivered in chain order,
gap-free, exactly once, surviving our own outages of days or weeks" better than ton-watch?**

ton-watch's approach, for reference:
- It fetches each address's transaction chain from liteservers, in any order and in parallel.
- It repairs gaps from `prev_trans_lt`/`prev_trans_hash` links.
- It splits long missing ranges using block listings.
- Ordering is enforced only when consumers read: per-address cursors, a cross-address
  watermark, and exactly-once delivery inside a Postgres transaction.

## Verdict

**Keep ton-watch as the core.** No open-source project or hosted service we found gives ordered,
gap-free, replayable delivery for a chosen set of addresses.

- **Node-file indexers** are full-chain only and need your own full node: ~€550–900/month
  self-hosted, ~$2.5k+/month on AWS.
- **Hosted streams** (tonapi, toncenter) are live-only. They do not replay what you missed while
  you were down, and toncenter's docs say so explicitly.
- **Library watchers** (tonutils-go, toncenter examples, pytoniq, Bicycle) poll one address with
  one cursor, or scan blocks. None has gap repair, and they die or skip once liteservers have
  pruned history.

**Borrow two things:**
1. A toncenter v3 (or Chainstack v3) `TxSource` as the fallback for history older than public
   liteservers keep. It is archival, cheap, and pageable by lt.
2. A hosted stream as an optional *trigger*, to cut detection latency. It is never trusted as the
   data source.

Details are under [Ideas to borrow](#ideas-to-borrow).

## Candidates

### Node-file indexers (read a full node's database directly)

| | toncenter **ton-indexer** v3 (+ index-worker) | **ton-etl** (ton-studio) | **anton** |
|---|---|---|---|
| Indexes | Full chain: blocks, txs, messages, states, NFTs, jettons, actions. No address filter (worker flags are only seqno ranges) | Full chain → Postgres → Debezium → Kafka → parsers → S3 | Full chain (blocks) |
| Source | Own full node's RocksDB, same machine | Same, via ton-index-worker | Liteservers + Postgres + ClickHouse |
| Consumer delivery | REST over Postgres; no cursor or callback | Kafka: ordered only per partition, at-least-once (inferred) | DB queries |
| After an outage | Refills missing masterchain seqnos, but only while the node still has the blocks (30-day default) | Reprocessing tool, not gap repair | — |
| History | Genesis only with an archive node | Same; public Parquet dataset on AWS S3 and a public Kafka | — |
| Hardware (published) | DB 8c/64 GB/4 TB NVMe + worker 16c/128 GB/1 TB **plus the node** | "Separate servers, high-performance SSD" | ≥128 GB RAM |
| License / activity | MIT, last commit 2026-09-30 | No license file, very active (2026-10-06) | Apache-2.0 |

The standalone `ton-index-worker` repo was last touched 2025-03; the worker now lives inside
ton-indexer. No throughput figures are published for any of these.

Sources: [ton-indexer](https://github.com/toncenter/ton-indexer),
[ton-etl](https://github.com/ton-studio/ton-etl),
[datalake](https://github.com/ton-studio/ton-etl/blob/main/datalake/README.md),
[anton](https://github.com/tonindexer/anton)

### Hosted APIs and streams

| | Watch addresses | Ordering / exactly-once / replay | History | Price for ~1000 addrs, ~100k tx/day |
|---|---|---|---|---|
| **tonapi webhooks** (TON Console) | Subscribe a list of accounts; POST carries only `{account_id, lt, tx_hash}` | Not documented: no retries, ordering or replay window. You fetch each tx yourself | REST API is full history | Hourly per connected account + per message. **~$420–900/month** in messages (estimate from tier prices) |
| **tonapi SSE/WS** | ≤1000 accounts per connection | **Deprecated** in favour of webhooks; no resume | — | REST plans $9.90–$890/month by RPS |
| **toncenter Streaming v2** (SSE/WS) | `addresses` list, pending/confirmed/finalized finality | **"Does not recover past events"**; docs say to resync by polling v3. Immediate reconnect can get a 429 | — | Plans: free 10 RPS, Plus 25 RPS, Advanced 100 RPS (priced in GRAM/TON per month) |
| **toncenter API v3** | `/transactions?account=…&start_lt&end_lt&sort=asc`, up to 1000 per page | Pull: you hold the cursor, so ordering and exactly-once are yours | **Archival** | Fits a cheap plan: 3M tx/month is a few thousand requests |
| **dTON** | GraphQL, webhooks (paid) | Not documented | — | Prices only via Telegram bot |
| **Bitquery** | GraphQL streams, Enterprise only | "No missed data" (marketing), no cursor semantics | "Complete" | Custom |
| Chainstack / QuickNode / GetBlock / Ankr / dRPC / NOWNodes | v2/v3 RPC; QuickNode and Chainstack sell archive | No account push (QuickNode TON Streams "coming soon") | Archive on paid tiers | Chainstack Growth $49/month |
| Tatum, Goldsky, The Graph, Subsquid, Envio | — | No TON support found | | |

Sources: [tonapi webhooks](https://docs.tonconsole.com/tonapi/webhooks-api),
[tonapi streaming](https://docs.tonconsole.com/tonapi/streaming-api), [tonapi.io](https://tonapi.io/),
[toncenter streaming](https://docs.ton.org/ecosystem/api/toncenter/streaming/overview),
[toncenter v3 transactions](https://docs.ton.org/ecosystem/api/toncenter/v3/blockchain-data/get-transactions),
[toncenter limits](https://docs.ton.org/applications/api/toncenter/rate-limit),
[dTON](https://docs.dton.io/webhooks),
[Bitquery](https://bitquery.io/blockchains/ton-blockchain-api),
[Chainstack](https://docs.chainstack.com/docs/ton-choosing-v2-or-v3),
[QuickNode](https://www.quicknode.com/chains/ton)

**Self-hostable tonapi:** [opentonapi](https://github.com/tonkeeper/opentonapi) (MIT, active) runs
on liteservers with an optional `ACCOUNTS` watch list. It has no full-chain index and no documented
delivery guarantees, so it sits on the same foundation as ton-watch but without the ordering layer.

### Library-based watchers (liteserver clients)

| | How it watches | Guarantees | After an outage |
|---|---|---|---|
| **tonutils-go** `SubscribeOnTransactions` (MIT, ~685★) | Polls account every 3s; on change, pages back `ListTransactions(…, 10, lt, hash)` to the last seen lt, delivers old→new | In order, at-least-once; you persist the lt | **Exits on `-400 lt not in db`** once history is pruned; no archive fallback |
| **toncenter/examples** `AccountSubscription` | Pages 10 at a time down to a **timestamp** cursor, polls every 10s | Ambiguous when several txs share a `utime` | Bounded by API history |
| **pytoniq** BlockScanner + LiteBalancer (MIT) | Walks shard predecessors per masterchain block, handles split/merge; balancer picks peers by highest seqno, then latency; `only_archive` routing | No persistence | Restarts from a given seqno; needs blocks still on the server |
| **Bicycle** (GPL-3.0), listed in TON payment docs | Block scanner, fetches only txs of wallets in its DB | Saves, *then* notifies: a crash in between loses the notification. Errors are `log.Fatal` | Requires **own node** on the same machine |
| Spice Harvester (GPL-3.0, beta) | Invoice tracker on liteservers + webhooks | Not documented | — |
| tongo, pytoncenter, broxus ton-wallet-api | Client lib / toncenter wrapper / Everscale-only | — | — |

Sources: [tonutils-go transactions.go](https://raw.githubusercontent.com/xssnick/tonutils-go/master/ton/transactions.go),
[toncenter examples](https://github.com/toncenter/examples), [pytoniq](https://github.com/yungwine/pytoniq),
[Bicycle](https://github.com/gobicycle/bicycle), [Spice Harvester](https://github.com/txsociety/spice-harvester),
[TON payments guidance](https://docs.ton.org/v3/guidelines/dapps/asset-processing/payments-processing)

The official TON guidance recommends polling plus webhooks plus **periodic reconciliation to catch
missed transactions**. It does not cover gap repair or parallel backfill.

## "A full node next to us is too expensive" — checked

Official requirements ([liteserver](https://docs.ton.org/nodes/cpp/run-liteserver),
[archive](https://docs.ton.org/nodes/cpp/run-archive-liteserver)):

| | Full node / liteserver | Archive node |
|---|---|---|
| CPU / RAM | 16 cores / 64 GB | 16 cores / 128 GB |
| Disk | ≥1 TB NVMe Gen4+, ≥64k IOPS (latest dump: 345 GB on disk) | ≥16 TB ZFS lz4 (dump of 16.07.2026: 16.07 TB compressed) |
| Network | 1 Gbit/s, ~16 TB/month at peak | same |
| Sync | hours | up to a week |
| Retention (defaults) | blocks 30 days, **state 1 day** | everything |

Monthly cost. Hetzner prices are after the 2026-06-15 increase; everything marked "est." is ours.

| Setup | Example | Per month |
|---|---|---|
| Full node only | Hetzner AX102 (16c/128 GB) | **~€257** |
| Full node + ton-index-worker (same box) | Hetzner AX162 (48c) | ~€612 (est.) |
| ton-indexer Postgres server | AX42 + 2×3.84 TB | ~€290 (est.) |
| **Full node + ton-indexer** | the two above | **~€550–900** (est.) |
| Archive node | AX102 + 2×15.36 TB | ~€900 (est.) |
| Full node on AWS | i4i.8xlarge + ~16 TB egress | **~$2.4k–3.5k** (est.) |
| Archive on AWS | 20 TB gp3 + r-class instance | ~$3.5k–5k before egress (est.) |
| **ton-watch on public liteservers** | any small VM + Postgres (~1 GB per million txs) | **~€10–40** |
| ton-watch + paid archival API fallback | + toncenter/Chainstack plan | + ~$0–50 |

So the claim holds, with a caveat. A bare full node on Hetzner (~€257/month) is affordable. But:

- It only keeps 30 days of blocks and 1 day of state.
- It is what bicycle-style scanners need, and they still have no gap repair.
- The node-based *indexers* add €300–600 on top, and index the whole chain to watch a few addresses.

A full node pays off only if you need sub-second latency, account state, or most of the chain.

## Ideas to borrow

Status of each idea in ton-watch:

| Idea | From | Status |
|---|---|---|
| Ask for 16 per page and validate prev links inside every page | liteserver source (`max_transaction_count = 16`); others ask for 10 | **Already done** (`validatePage`) |
| Make a lagging liteserver wait instead of answering "not found" | tonutils-go `StickyContext`, pytoniq seqno-aware balancer | **Already done**: `waitMasterchainSeqno` on every tip-relative query, plus a `not_ready` error kind |
| Treat `lt not in db` as routing (try the others, then archival), never as the end | tonutils-go dies here; pytoniq `only_archive` | **Already done**: `ServerPool` skip + archival members; ranges nobody serves are parked and reported, never skipped |
| Periodic reconciliation of live last-tx against the stored head | TON payment guidance | **Already done**: idle polls and the full gap rescan every 60s |
| **toncenter as a history source beyond ~35–41 days** | hosted survey | **Done** as the optional `@ton/watch/toncenter` plug-in. It uses API v2 `getTransactions?archival=true` rather than v3, because v2 returns raw BOCs that can be re-hashed and link-checked; v3 does not. Modes: `fallback` and `boost` (1000 tx per request). Benchmarked in `bench/RESULTS.md` |
| **Hosted stream (toncenter Streaming v2, finalized) as a change-detection hint** | hosted survey | **To do, optional.** Wake the address immediately; ton-watch still fetches and links. Benchmark: detection latency and calls/min against `blocks` mode |
| Two read thresholds: confirmed (shard block) vs finalized (masterchain) | toncenter streaming finality levels | Idea; only if consumers need lower latency |
| Pin a dependent sequence of calls (lookup → list → get) to one server | tonutils-go | Partly covered by `waitMasterchainSeqno`; revisit if `not_ready` errors show up in metrics |
| Walk predecessor shard blocks on split/merge in `blocks` mode | pytoniq, tonutils-go block-scan | ton-watch falls back to polling on topology change (safe, costs one poll round); a full walk is an optional refinement |

## Uncertainties

- Hosted pricing comes partly from search snippets: TonAPI webhook tiers, and whether toncenter
  plans are priced in GRAM or TON. dTON prices are Telegram-only.
- No vendor documents per-subscription address limits for webhooks or toncenter streaming.
- There are no published throughput numbers for ton-indexer, ton-etl or anton, and no measured
  full-history ton-indexer database size (4 TB is the recommended disk, not a measurement).
- The AWS figures are estimates.
