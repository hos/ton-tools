/**
 * Shared helpers for the live benchmarks. Everything here talks to mainnet public
 * liteservers (and toncenter for setup and cross-checks only).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Address } from "@ton/core";

export const RESULTS_DIR = join(import.meta.dir, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const TONCENTER = "https://toncenter.com/api/v3";
let lastToncenter = 0;

/** Rate-limited toncenter GET (1 rps without an API key). */
export async function toncenter<T = any>(path: string, params: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  for (let attempt = 0; ; attempt++) {
    const wait = lastToncenter + 1_100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastToncenter = Date.now();
    const headers: Record<string, string> = {};
    if (process.env.TONCENTER_API_KEY) headers["X-API-Key"] = process.env.TONCENTER_API_KEY;
    const res = await fetch(`${TONCENTER}${path}?${qs}`, { headers });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 5) throw new Error(`toncenter ${path}: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
  }
}

/** Masterchain lt at a unix time (start_lt of the first masterchain block at/after it). */
export async function ltAtTime(utime: number): Promise<bigint> {
  const { blocks } = await toncenter("/blocks", {
    workchain: -1,
    start_utime: utime,
    limit: 1,
    sort: "asc",
  });
  return BigInt(blocks[0].start_lt);
}

export const raw = (a: string) => Address.parse(a).toRawString();

export function saveResult(name: string, data: unknown) {
  const file = join(RESULTS_DIR, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n"
  );
  console.log(`saved ${file}`);
}

export function loadResult<T = any>(name: string): T | null {
  const file = join(RESULTS_DIR, `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export const fmt = (n: number, digits = 1) =>
  n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(digits);

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/**
 * Samples recently active basechain accounts from toncenter, with an activity
 * estimate. `points` samples spread over the last `hours`.
 */
export async function sampleActiveAccounts(points: number, hours: number) {
  const now = Math.floor(Date.now() / 1000);
  const counts = new Map<string, number>();
  for (let i = 0; i < points; i++) {
    const end = now - Math.floor((hours * 3600 * i) / points) - 60;
    const { transactions } = await toncenter("/transactions", {
      workchain: 0,
      end_utime: end,
      limit: 1000,
      sort: "desc",
    });
    for (const t of transactions) counts.set(t.account, (counts.get(t.account) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
