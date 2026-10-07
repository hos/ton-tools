# Liteservers and history

[← @ton/watch](../README.md)

How ton-watch uses public liteservers, how far back they go, and the optional toncenter plug-in for older history.

`LiteSource` connects to every server in the config and spreads calls over them:
fastest and least loaded first, a bounded number of requests per server, and per
error kind:

- **rate limited** → that server cools down (exponential, capped at 30s); the call
  moves on.
- **timeout / network** → short cooldown, retry elsewhere.
- **not found** → try the other servers, then the archival ones
  (`archiveServers` / `TON_WATCH_ARCHIVE_NETWORK`). A range nobody serves is retried
  every 10 minutes and reported as stuck — it is never skipped.
- Queries carry `waitMasterchainSeqno`, so a server a few blocks behind waits
  instead of answering "not found" for something it has not seen yet.
- Every page is checked before it is written: it must start at the requested
  transaction and every prev link inside it must hold.

## How far back public liteservers go

Measured 2026-10-06 (full table in [`bench/RESULTS.md`](https://github.com/hos/ton-tools/blob/main/packages/ton-watch/bench/RESULTS.md)): 11 of the
12 reachable public mainnet liteservers serve account transactions back **35–41
days**; one (185.86.79.9) is archival back past a year but missing roughly days
3–50. Old **account state** is served for less than a day — which is why an indexer
that reads state "as of" each block cannot recover from a multi-day stall, while
this one can.

**For more than ~a month of history** (including recovery from an outage longer
than that), configure an archival liteserver or plug in toncenter (below).

## Optional: toncenter history plug-in (experimental)

A separate import that the core never loads on its own. Leave it out and nothing
changes.

> **Experimental**, outside the [stability policy](stability.md). Tested
> without paying: unit tests replay a recorded toncenter response, and
> `LIVE=1 bun test tests/live.test.ts` checks it against liteservers on mainnet
> using the free tier (no key, 1 request/s). Paid-plan rate limits and long runs at
> volume are **not** tested. The safety net still applies: every page is re-hashed
> and chain-checked, so a wrong answer is refetched, never stored.

```ts
import { ToncenterHistory } from "@ton/watch/toncenter";

new TonWatch({
  store,
  source,
  history: {
    source: new ToncenterHistory({ apiKey: process.env.TON_WATCH_TONCENTER_API_KEY }), // key optional
    mode: "fallback",  // or "boost"
    enabled: true,     // flip off without unwiring
  },
});
```

- **`fallback`** (default): liteservers first. toncenter is asked only for ranges no
  liteserver serves any more. It is archival, so outages of months recover without
  your own archival node.
- **`boost`**: also used whenever it has spare request budget. It serves up to 1000
  transactions per request where liteservers serve 16, and liteservers take whatever
  it can't.
- toncenter pages are raw transaction BOCs. ton-watch re-hashes them and checks every
  prev link exactly like liteserver pages (verified on mainnet: byte-identical). A
  wrong answer is rejected and refetched from liteservers, never stored.
- Rate-limited client side: 1 request/s without a key, 10 with one (`rps` to change).
  It retries 429 and 5xx with backoff.
- Service: `TON_WATCH_HISTORY=toncenter`, `TON_WATCH_HISTORY_MODE=fallback|boost`,
  `TON_WATCH_TONCENTER_API_KEY`, `TON_WATCH_TONCENTER_ENDPOINT`.
- Another provider plugs in the same way by implementing `HistorySource` from
  `@ton/watch/advanced` (`getTransactions(address, from, count)`, optionally `busy()`).
