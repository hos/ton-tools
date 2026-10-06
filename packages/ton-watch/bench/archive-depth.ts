/**
 * How far back do public liteservers serve getAccountTransactions?
 *
 * For one long-lived address, takes real transactions at increasing ages (from
 * toncenter) and asks every liteserver in the public config for each of them.
 *
 *   bun run bench/archive-depth.ts [--address <addr>]
 */
import { Address } from "@ton/core";
import { getServers } from "@ton/ls";
import { LiteClient } from "ton-lite-client";
import { LiteConnection } from "../src/source/liteserver/lite-engine";

import { arg, saveResult, toncenter } from "./lib";

const address = arg("address", "EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMS")!;
const AGES_DAYS = [1, 3, 7, 14, 21, 28, 30, 35, 42, 49, 60, 90, 180, 365];

const now = Math.floor(Date.now() / 1000);
const points: { days: number; lt: string; hash: string; utime: number }[] = [];
for (const days of AGES_DAYS) {
  const { transactions } = await toncenter("/transactions", {
    account: address,
    end_utime: now - days * 86400,
    limit: 1,
    sort: "desc",
  });
  const t = transactions[0];
  if (t) points.push({ days, lt: t.lt, hash: t.hash, utime: t.now });
}

const ip = (n: number) => {
  const u = n >>> 0;
  return [u >>> 24, (u >>> 16) & 255, (u >>> 8) & 255, u & 255].join(".");
};
const addr = Address.parse(address);
const servers = await getServers("mainnet");

const rows = await Promise.all(
  servers.map(async (s) => {
    const host = `${ip(s.ip)}:${s.port}`;
    const engine = new LiteConnection({
      host: `tcp://${host}`,
      publicKey: Buffer.from(s.id.key, "base64"),
    });
    const lc = new LiteClient({ engine });
    for (let i = 0; i < 80 && !engine.isReady(); i++) await new Promise((r) => setTimeout(r, 100));
    const results: Record<number, string> = {};
    if (!engine.isReady()) {
      engine.close();
      return { host, reachable: false, results, deepestDays: null };
    }
    for (const p of points) {
      try {
        const r = await Promise.race([
          lc.getAccountTransactions(addr, p.lt, Buffer.from(p.hash, "base64"), 1),
          new Promise<never>((_, j) => setTimeout(() => j(new Error("timeout")), 10_000)),
        ]);
        results[p.days] = r.ids.length ? "ok" : "empty";
      } catch (e) {
        const m = String((e as Error).message);
        results[p.days] = /cannot locate|not in db|cannot load/.test(m)
          ? "pruned"
          : `error: ${m.slice(0, 60)}`;
      }
    }
    engine.close();
    const okDays = points.filter((p) => results[p.days] === "ok").map((p) => p.days);
    return {
      host,
      reachable: true,
      results,
      deepestDays: okDays.length ? Math.max(...okDays) : null,
    };
  }),
);

const table = [
  `| server | ${points.map((p) => `${p.days}d`).join(" | ")} |`,
  `|---|${points.map(() => "---").join("|")}|`,
  ...rows
    .filter((r) => r.reachable)
    .map(
      (r) =>
        `| ${r.host} | ${points.map((p) => (r.results[p.days] === "ok" ? "✓" : r.results[p.days] === "pruned" ? "·" : "✗")).join(" | ")} |`,
    ),
].join("\n");
console.log(table);
console.log(
  `unreachable: ${
    rows
      .filter((r) => !r.reachable)
      .map((r) => r.host)
      .join(", ") || "none"
  }`,
);

saveResult("archive-depth", {
  measuredAt: new Date().toISOString(),
  address,
  points,
  servers: rows,
  table,
});
process.exit(0);
