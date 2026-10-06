/**
 * Backfill throughput: index every transaction of N addresses over a fixed
 * historical window (from `--hours` ago up to the tip), sequentially (one request
 * at a time) and in parallel, against mainnet public liteservers.
 *
 *   bun run bench/backfill.ts [--sizes 1,10,100,1000] [--hours 2] [--concurrency 1,32] [--label before]
 */
import { Indexer } from "../src/indexer";
import { Metrics } from "../src/metrics";
import { LiteSource } from "../src/source/lite-source";
import { MemoryStore } from "../src/stores/memory-store";
import { arg, fmt, loadResult, ltAtTime, saveResult } from "./lib";

const sizes = arg("sizes", "1,10,100,1000")!.split(",").map(Number);
const hours = Number(arg("hours", "2"));
const concurrencies = arg("concurrency", "1,32")!.split(",").map(Number);
const label = arg("label", "current")!;
const split = arg("split", "on") !== "off";

const accounts = loadResult("accounts");
if (!accounts) throw new Error("run bench/accounts.ts first");

const windowStart = Math.floor(Date.now() / 1000) - hours * 3600;
const startLt = await ltAtTime(windowStart);
console.log(`window: last ${hours}h, startLt ${startLt}`);

const runs: any[] = [];
for (const size of sizes) {
  const addresses: string[] = accounts.active.slice(0, size).map((a: any) => a.address);
  for (const concurrency of concurrencies) {
    const metrics = new Metrics();
    const source = await LiteSource.connect({ metrics, maxInFlightPerServer: 4 });
    const store = new MemoryStore();
    for (const a of addresses) await store.addAddress(a, { startLt });
    const indexer = new Indexer({
      store,
      source,
      metrics,
      concurrency,
      detect: "poll",
      split: split ? undefined : false,
    });

    const started = performance.now();
    await indexer.syncOnce();
    const seconds = (performance.now() - started) / 1000;
    await source.close();

    const calls = metrics.sum("ton_watch_source_calls_total");
    const errors = metrics.sum("ton_watch_errors_total");
    const states = await store.listAddresses();
    const complete = states.filter((s) => s.syncedLt > 0n && s.frontier?.lt === s.head?.lt).length;
    const run = {
      size,
      concurrency,
      split,
      txs: store.size,
      seconds,
      txPerSecond: store.size / seconds,
      calls,
      callsPerSecond: calls / seconds,
      callsByMethod: Object.fromEntries(
        ["getTip", "getAccountState", "getTransactions"].map((m) => [
          m,
          metrics.get("ton_watch_source_calls_total", { method: m }),
        ])
      ),
      errors,
      complete: `${complete}/${size}`,
    };
    runs.push(run);
    console.log(
      `N=${size} c=${concurrency}: ${run.txs} tx in ${fmt(seconds)}s → ${fmt(run.txPerSecond)} tx/s, ` +
        `${calls} calls (${fmt(run.callsPerSecond)}/s), ${errors} errors, complete ${run.complete}`
    );
  }
}

const previous = loadResult("backfill") ?? {};
saveResult("backfill", {
  ...previous,
  [label]: { measuredAt: new Date().toISOString(), hours, startLt, runs },
});
process.exit(0);
