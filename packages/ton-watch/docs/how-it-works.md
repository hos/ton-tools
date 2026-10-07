# How ton-watch works

[← @ton/watch](../README.md)

The idea behind it, and when a different tool fits better.

Every TON transaction names its predecessor on the same account (`prev_trans_lt`,
`prev_trans_hash`). That link is the whole design:

- **Writes land in any order.** Fetches walk backwards page by page
  (`liteServer.getTransactions`, 16 per page) from any known transaction. Several
  walks per address, and many addresses, run at once. Inserts are idempotent.
- **Completeness is computed, not assumed.** A stored transaction whose
  predecessor is missing marks a *gap*. An address's **frontier** is the newest
  transaction with an unbroken chain down to its `startLt`.
- **The store is the job queue.** Gaps found in the store become fetch jobs. A
  crash, a restart or a failed fetch just leaves gaps that the next pass refills —
  there is no separate progress state to corrupt.
- **Reads enforce order.** Consumers get each address's transactions in lt order up
  to its frontier and never beyond it.

Long gaps are walked in parallel: the indexer locates real transactions inside the
range from block listings (`lookupBlockByLt` + `listBlockTransactions`, which work as
far back as blocks are kept) and walks each piece separately.

## When to use this, and when not

Use ton-watch when you care about a **known set of addresses** — a marketplace's
contracts and fee wallets, a project's treasury, user deposit wallets — and need
every one of their transactions, in order, without running your own node.

Use a full-chain indexer ([ton-indexer](https://github.com/toncenter/ton-indexer),
[ton-index-worker](https://github.com/toncenter/ton-index-worker)) or a node when:

- you need *every* account, or accounts you can't name in advance (e.g. all NFT
  items of a collection as they get deployed — though watching the collection and
  the marketplace contracts usually covers that);
- the watched addresses together produce a large share of all chain traffic —
  in our 1-hour measurement a block scan costs ~5–8 calls per masterchain block (~9k blocks/h) regardless of how many addresses it watches, while ton-watch costs ~1 call per 16 watched transactions plus detection; ton-watch stays cheaper until the watched addresses produce on the order of 16 × 8 ≈ 100+ transactions per masterchain block, i.e. a large fraction of the whole chain;
- you need account state at past blocks (this indexes transactions, not state).
