/**
 * Catch-up after an outage: ~10 busy addresses whose data is complete up to
 * `--days` ago, then the indexer comes back and must fill everything up to the tip.
 * This is the scenario that jammed a block-scanning indexer permanently.
 *
 *   DATABASE_URL=postgres://… bun run bench/outage.ts --days 7 [--concurrency 64] [--label after]
 *
 * Uses Postgres when DATABASE_URL is set (each run gets a fresh schema), memory otherwise.
 */
import { Pool } from "pg";

import { Indexer } from "../src/indexer/indexer";
import { Metrics } from "../src/metrics/metrics";
import { LiteSource } from "../src/source/liteserver/lite-source";
import { MemoryStore } from "../src/stores/memory/memory-store";
import { PgStore } from "../src/stores/pg/pg-store";
import type { Store } from "../src/stores/store";
import { arg, fmt, loadResult, ltAtTime, saveResult } from "./lib";

const days = Number(arg("days", "7"));
const concurrency = Number(arg("concurrency", "64"));
const label = arg("label", "current")!;
const split = arg("split", "on") !== "off";
// --history toncenter[:fallback|boost] plugs in @ton/watch/toncenter (TONCENTER_API_KEY optional).
const historyArg = arg("history");
const historyMode = (historyArg?.split(":")[1] ?? "boost") as "fallback" | "boost";
const makeHistory = async () =>
  historyArg?.startsWith("toncenter")
    ? {
        source: new (await import("../src/plugins/toncenter")).ToncenterHistory({
          apiKey: process.env.TONCENTER_API_KEY,
          pageSize: 1000,
        }),
        mode: historyMode,
      }
    : undefined;
const limitMinutes = Number(arg("limit-minutes", "120"));

const accounts = loadResult("accounts");
if (!accounts) throw new Error("run bench/accounts.ts first");
const addresses: string[] = accounts.outage.map((o: any) => o.address);

const outageStart = Math.floor(Date.now() / 1000) - days * 86400;
const startLt = await ltAtTime(outageStart);

let store: Store;
let pool: Pool | null = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 32 });
  const schema = `bench_outage_${days}d_${Date.now()}`;
  store = new PgStore(pool, { schema });
  console.log(`store: postgres schema ${schema}`);
} else {
  store = new MemoryStore();
  console.log("store: memory");
}
await store.migrate();
for (const a of addresses) await store.addAddress(a, { startLt });

const metrics = new Metrics();
const source = await LiteSource.connect({ metrics, maxInFlightPerServer: 6 });
const indexer = new Indexer({
  store,
  source,
  metrics,
  concurrency,
  detect: "poll",
  retryMinMs: 500,
  split: split ? undefined : false,
  history: await makeHistory(),
});

const started = performance.now();
const progress = setInterval(async () => {
  const el = (performance.now() - started) / 1000;
  const written = metrics.sum("ton_watch_tx_written_total");
  console.log(
    `  ${fmt(el)}s: ${written} tx (${fmt(written / el)} tx/s), ${metrics.sum("ton_watch_source_calls_total")} calls, ` +
      `walks ${metrics.get("ton_watch_walks")}, stuck ${metrics.get("ton_watch_walks_stuck")}`,
  );
  if (el > limitMinutes * 60) {
    console.log("time limit reached");
    await finish(true);
  }
}, 30_000);

let finished = false;
async function finish(timedOut: boolean) {
  if (finished) return;
  finished = true;
  clearInterval(progress);
  const seconds = (performance.now() - started) / 1000;
  const states = await store.listAddresses();
  const status = indexer.status();
  const written = metrics.sum("ton_watch_tx_written_total");
  const calls = metrics.sum("ton_watch_source_calls_total");
  const perAddress = states.map((s) => ({
    address: s.address,
    complete: s.frontier !== null && s.frontier.lt === s.head?.lt,
    stuckRanges: status.find((x) => x.address === s.address)?.stuck ?? 0,
  }));
  const result = {
    measuredAt: new Date().toISOString(),
    days,
    concurrency,
    split,
    history: historyArg ?? "off",
    store: pool ? "postgres" : "memory",
    startLt,
    seconds,
    timedOut,
    txs: written,
    txPerSecond: written / seconds,
    calls,
    callsPerSecond: calls / seconds,
    callsByMethod: Object.fromEntries(
      ["getTip", "getAccountState", "getTransactions", "lookupBlock", "listBlockTransactions"].map(
        (m) => [m, metrics.get("ton_watch_source_calls_total", { method: m })],
      ),
    ),
    splitPoints: metrics.get("ton_watch_split_points_total"),
    errors: Object.fromEntries(
      Object.entries(metrics.snapshot()).filter(([k]) => k.startsWith("ton_watch_errors_total")),
    ),
    completeAddresses: perAddress.filter((p) => p.complete).length,
    stuckRanges: perAddress.reduce((n, p) => n + p.stuckRanges, 0),
    perAddress,
  };
  console.log(
    `outage ${days}d: ${written} tx in ${fmt(seconds)}s → ${fmt(result.txPerSecond)} tx/s, ${calls} calls ` +
      `(${fmt(result.callsPerSecond)}/s), complete ${result.completeAddresses}/${addresses.length}, stuck ranges ${result.stuckRanges}`,
  );
  const previous = loadResult("outage") ?? {};
  saveResult("outage", { ...previous, [`${label}-${days}d`]: result });
  await indexer.stop();
  await source.close();
  await pool?.end();
  process.exit(0);
}

await indexer.syncOnce(10_000);
await finish(false);
