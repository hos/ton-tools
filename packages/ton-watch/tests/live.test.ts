/**
 * Live check against mainnet public liteservers. Opt-in:
 *
 *   LIVE=1 bun test tests/live.test.ts
 *
 * Indexes the last few thousand transactions of a busy address and verifies the
 * chain is complete and every (lt, hash) matches toncenter.
 */
import { describe, expect, test } from "bun:test";

import { analyzeChain } from "../src/core/chain";
import { Indexer } from "../src/indexer/indexer";
import { ToncenterHistory } from "../src/plugins/toncenter";
import { LiteSource } from "../src/source/liteserver/lite-source";
import { MemoryStore } from "../src/stores/memory/memory-store";
import { toRaw } from "../src/ton-watch";

const LIVE = process.env.LIVE === "1";
// STON.fi v1 router: thousands of transactions a day.
const ADDRESS = process.env.LIVE_ADDRESS ?? "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";
const COUNT = Number(process.env.LIVE_COUNT ?? 3000);

async function toncenterTxs(account: string, count: number) {
  const out: { lt: bigint; hash: string }[] = [];
  let endLt: string | undefined;
  while (out.length < count) {
    const params = new URLSearchParams({ account, limit: "1000", sort: "desc" });
    if (endLt) params.set("end_lt", endLt);
    const res = await fetch(`https://toncenter.com/api/v3/transactions?${params}`);
    if (!res.ok) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const { transactions } = (await res.json()) as { transactions: { lt: string; hash: string }[] };
    if (transactions.length === 0) break;
    for (const t of transactions)
      out.push({ lt: BigInt(t.lt), hash: Buffer.from(t.hash, "base64").toString("hex") });
    endLt = (BigInt(transactions.at(-1)!.lt) - 1n).toString();
    await new Promise((r) => setTimeout(r, 1100));
  }
  return out.slice(0, count);
}

describe.skipIf(!LIVE)("live mainnet", () => {
  test(`last ${COUNT} transactions of a busy address are complete and match toncenter`, async () => {
    const raw = toRaw(ADDRESS);
    const reference = await toncenterTxs(ADDRESS, COUNT);
    const oldest = reference.at(-1)!;
    const newest = reference[0]!;

    const source = await LiteSource.connect();
    const store = new MemoryStore();
    await store.addAddress(raw, { startLt: oldest.lt - 1n });
    const indexer = new Indexer({ store, source, concurrency: 32, detect: "poll" });
    await indexer.syncOnce();
    await source.close();

    const stored = await store.read(raw, 0n, 1n << 62n, 1_000_000);
    const { gaps } = analyzeChain(raw, stored, oldest.lt - 1n);
    expect(gaps).toEqual([]);

    const window = stored.filter((t) => t.lt <= newest.lt);
    expect(window.length).toBe(reference.length);
    const byLt = new Map(window.map((t) => [t.lt, t.hash.toString("hex")]));
    for (const r of reference) expect(byLt.get(r.lt)).toBe(r.hash);
  }, 600_000);

  test("toncenter history pages are identical to liteserver pages, and reach past liteserver retention", async () => {
    const raw = toRaw(ADDRESS);
    const source = await LiteSource.connect();
    const tip = await source.getTip();
    const last = (await source.getLastTx(raw, tip))!;
    const history = new ToncenterHistory({ apiKey: process.env.TONCENTER_API_KEY });
    const fromLs = await source.getTransactions(raw, last, 16);
    const fromTc = await history.getTransactions(raw, last, 16);
    expect(fromTc.map((t) => t.hash.toString("hex"))).toEqual(
      fromLs.map((t) => t.hash.toString("hex")),
    );
    expect(fromTc.every((t, i) => t.boc.equals(fromLs[i]!.boc))).toBe(true);

    // A year-old transaction of the Getgems fee wallet: pruned on public liteservers.
    const gg = toRaw("EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMS");
    const old = {
      lt: 62278509000005n,
      hash: Buffer.from("sB/zEa2IZ4FDkGXgEwPKNQXhV6TNNJ7sr/tnGWseREM=", "base64"),
    };
    const page = await history.getTransactions(gg, old, 100);
    expect(page[0]!.lt).toBe(old.lt);
    expect(page.length).toBe(100);
    await source.close();
  }, 120_000);
});
