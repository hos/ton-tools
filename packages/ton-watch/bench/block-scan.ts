/**
 * Baseline: a minimal "scan every masterchain block and filter by address" indexer
 * over the same window as bench/backfill.ts, using the same liteserver pool and
 * the same parallelism, so the comparison is about the approach, not the plumbing.
 *
 * Per masterchain block: look it up, read its shard tops, list the transactions
 * of every new shard block, keep the ones of watched accounts, fetch those.
 *
 *   bun run bench/block-scan.ts [--sizes 10,1000] [--hours 1] [--concurrency 32]
 */
import { Address, Cell } from "@ton/core";
import { Functions, type liteServer_allShardsInfo } from "ton-lite-client/dist/schema";

import { Metrics } from "../src/metrics";
import { LiteSource } from "../src/source/lite-source";
import { parseShardTops } from "../src/source/shards";
import { arg, fmt, loadResult, saveResult, toncenter } from "./lib";

const sizes = arg("sizes", "10,1000")!.split(",").map(Number);
const hours = Number(arg("hours", "1"));
const concurrency = Number(arg("concurrency", "32"));
const label = arg("label", "current")!;

const accounts = loadResult("accounts");
if (!accounts) throw new Error("run bench/accounts.ts first");

const MASTER = "-9223372036854775808";
const now = Math.floor(Date.now() / 1000);
const { blocks } = await toncenter("/blocks", { workchain: -1, start_utime: now - hours * 3600, limit: 1, sort: "asc" });
const firstSeqno = Number(blocks[0].seqno);

const runs: any[] = [];
for (const size of sizes) {
  const watched = new Set<string>(
    accounts.active.slice(0, size).map((a: any) => Address.parse(a.address).hash.toString("hex"))
  );
  const metrics = new Metrics();
  const source = await LiteSource.connect({ metrics, maxInFlightPerServer: 4 });
  const pool = source.pool;
  const lastSeqno = (await source.getTip()).seqno;

  const shardsAt = async (seqno: number) => {
    const { id } = await pool.call("lookupBlock", (c) =>
      c.lookupBlockByID({ workchain: -1, shard: MASTER, seqno })
    );
    const res = (await pool.call("getAllShardsInfo", (c) =>
      c.engine.query(Functions.liteServer_getAllShardsInfo, { kind: "liteServer.getAllShardsInfo", id })
    )) as liteServer_allShardsInfo;
    return parseShardTops(res.data).filter((s) => s.workchain === 0);
  };

  let txs = 0;
  let chainTxs = 0;
  let shardBlocks = 0;
  let prev = await shardsAt(firstSeqno - 1);
  const started = performance.now();

  // Process masterchain blocks in windows of `concurrency`, keeping order of shard tops.
  for (let s = firstSeqno; s <= lastSeqno; s += concurrency) {
    const seqnos = Array.from({ length: Math.min(concurrency, lastSeqno - s + 1) }, (_, i) => s + i);
    const tops = await Promise.all(seqnos.map(shardsAt));
    const work: { shard: string; seqno: number }[] = [];
    for (const t of tops) {
      for (const top of t) {
        const before = prev.find((p) => p.shard === top.shard)?.seqno ?? top.seqno - 1;
        for (let q = before + 1; q <= top.seqno; q++) work.push({ shard: top.shard, seqno: q });
      }
      prev = t;
    }
    shardBlocks += work.length;
    await Promise.all(
      work.map(async (b) => {
        const { id } = await pool.call("lookupBlock", (c) =>
          c.lookupBlockByID({ workchain: 0, shard: b.shard, seqno: b.seqno })
        );
        let after: any = null;
        const mine: { account: Buffer; lt: string; hash: Buffer }[] = [];
        for (;;) {
          const res = await pool.call("listBlockTransactions", (c) =>
            c.listBlockTransactions(id, { mode: 7 + (after ? 128 : 0), count: 256, after })
          );
          chainTxs += res.ids.length;
          for (const t of res.ids) {
            if (t.account && watched.has(t.account.toString("hex"))) mine.push(t as any);
          }
          const last = res.ids.at(-1);
          if (!res.incomplete || !last) break;
          after = { kind: "liteServer.transactionId3", account: last.account, lt: last.lt };
        }
        // Fetch the matching transactions themselves (one call per account per block).
        const byAccount = new Map<string, typeof mine>();
        for (const t of mine) byAccount.set(t.account.toString("hex"), [...(byAccount.get(t.account.toString("hex")) ?? []), t]);
        for (const [hex, list] of byAccount) {
          const newest = list.reduce((a, b) => (BigInt(b.lt) > BigInt(a.lt) ? b : a));
          const r = await pool.call("getTransactions", (c) =>
            c.getAccountTransactions(Address.parse(`0:${hex}`), newest.lt, newest.hash, list.length)
          );
          txs += Cell.fromBoc(r.transactions).length;
        }
      })
    );
    if ((s - firstSeqno) % (concurrency * 50) === 0) {
      const done = s - firstSeqno;
      const el = (performance.now() - started) / 1000;
      console.log(`  N=${size}: ${done}/${lastSeqno - firstSeqno} mc blocks, ${txs} tx, ${fmt(el)}s`);
    }
  }
  const seconds = (performance.now() - started) / 1000;
  await source.close();
  const calls = metrics.sum("ton_watch_source_calls_total");
  const mcBlocks = lastSeqno - firstSeqno + 1;
  const run = {
    size,
    concurrency,
    mcBlocks,
    shardBlocks,
    chainTxs,
    txs,
    seconds,
    txPerSecond: txs / seconds,
    calls,
    callsPerSecond: calls / seconds,
    callsPerMcBlock: calls / mcBlocks,
    errors: metrics.sum("ton_watch_errors_total"),
  };
  runs.push(run);
  console.log(
    `block scan N=${size}: ${mcBlocks} mc blocks / ${shardBlocks} shard blocks, ${txs} tx in ${fmt(seconds)}s → ` +
      `${fmt(run.txPerSecond)} tx/s, ${calls} calls (${fmt(run.callsPerSecond)}/s, ${fmt(run.callsPerMcBlock)}/mc block)`
  );
}

const previous = loadResult("block-scan") ?? {};
saveResult("block-scan", {
  ...previous,
  [label]: { measuredAt: new Date().toISOString(), hours, firstSeqno, runs },
});
process.exit(0);
