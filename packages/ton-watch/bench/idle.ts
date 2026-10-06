/**
 * Idle cost: liteserver calls per minute to keep 1000 mostly-quiet addresses up to
 * date, in poll mode and in blocks mode. Addresses are added "from now", the
 * indexer runs for `--minutes` per mode, and only steady-state calls are counted.
 *
 *   bun run bench/idle.ts [--n 1000] [--minutes 5] [--modes poll,blocks]
 */
import { Indexer } from "../src/indexer/indexer";
import type { DetectMode } from "../src/indexer/options";
import { Metrics } from "../src/metrics/metrics";
import { LiteSource } from "../src/source/liteserver/lite-source";
import { MemoryStore } from "../src/stores/memory/memory-store";
import { arg, fmt, loadResult, saveResult } from "./lib";

const n = Number(arg("n", "1000"));
const minutes = Number(arg("minutes", "5"));
const modes = arg("modes", "poll,blocks")!.split(",") as DetectMode[];
const label = arg("label", "current")!;

const accounts = loadResult("accounts");
if (!accounts) throw new Error("run bench/accounts.ts first");
// The least active of the sampled accounts: mostly wallets that transact rarely.
const addresses: string[] = accounts.active.slice(-n).map((a: any) => a.address);

const runs: any[] = [];
for (const detect of modes) {
  const metrics = new Metrics();
  const source = await LiteSource.connect({ metrics });
  const store = new MemoryStore();
  const tip = await source.getTip();
  for (const a of addresses) {
    await store.addAddress(a, {
      startLt: tip.syncLt,
      syncedLt: tip.syncLt,
      syncedUtime: tip.utime,
    });
  }
  const indexer = new Indexer({ store, source, metrics, detect, tickMs: 1000 });
  indexer.start();
  // Warm-up: first verification of every address.
  await new Promise((r) => setTimeout(r, 60_000));
  const base = metrics.snapshot();
  const baseCalls = metrics.sum("ton_watch_source_calls_total");
  const baseTx = metrics.sum("ton_watch_tx_written_total");
  const t = performance.now();
  await new Promise((r) => setTimeout(r, minutes * 60_000));
  const elapsedMin = (performance.now() - t) / 60_000;
  const calls = metrics.sum("ton_watch_source_calls_total") - baseCalls;
  const status = indexer.status();
  const lags = status.map((s) => s.lagSeconds ?? 0).sort((a, b) => a - b);
  await indexer.stop();
  await source.close();
  const byMethod = Object.fromEntries(
    Object.entries(metrics.snapshot())
      .filter(([k]) => k.startsWith("ton_watch_source_calls_total"))
      .map(([k, v]) => [k.replace(/.*method="(.*)".*/, "$1"), (v - (base[k] ?? 0)) / elapsedMin]),
  );
  const run = {
    detect,
    addresses: n,
    minutes: elapsedMin,
    callsPerMinute: calls / elapsedMin,
    callsPerMinuteByMethod: byMethod,
    txIndexed: metrics.sum("ton_watch_tx_written_total") - baseTx,
    lagSecondsP50: lags[Math.floor(lags.length / 2)],
    lagSecondsP99: lags[Math.floor(lags.length * 0.99)],
  };
  runs.push(run);
  console.log(
    `${detect}: ${fmt(run.callsPerMinute)} calls/min for ${n} addresses ` +
      `(${run.txIndexed} tx indexed meanwhile, lag p50 ${run.lagSecondsP50}s p99 ${run.lagSecondsP99}s)`,
    byMethod,
  );
}

const previous = loadResult("idle") ?? {};
saveResult("idle", { ...previous, [label]: { measuredAt: new Date().toISOString(), runs } });
process.exit(0);
