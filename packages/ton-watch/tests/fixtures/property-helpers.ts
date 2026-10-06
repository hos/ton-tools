/**
 * Shared helpers for the randomized (property / model based) tests. Every test
 * derives all of its randomness from one seed printed in its name, so a failure
 * reproduces by rerunning that test alone.
 */

import { expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { completeUpTo, type TxRecord } from "../../src/core/types";
import { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import type { FakeChain, Faults } from "./fake-chain";

export type Rng = () => number;

/** Uniform integer in `[lo, hi]`. */
export const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export const chance = (r: Rng, p: number) => r() < p;
export const pick = <T>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;

export function shuffle<T>(r: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** `n` seeds derived from `base`, spread out so neighbouring tests differ. */
export const seeds = (base: number, n: number) =>
  Array.from({ length: n }, (_, i) => base + i * 7919);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const LT_MAX = 1n << 62n;

export const byLt = (a: { lt: bigint }, b: { lt: bigint }) =>
  a.lt < b.lt ? -1 : a.lt > b.lt ? 1 : 0;

/** Global delivery order: (lt, address). */
export const byLtThenAddress = (a: TxRecord, b: TxRecord) =>
  byLt(a, b) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

/**
 * Appends `count` transactions spread randomly over `addresses` (skewed: some
 * addresses are much busier), sealing blocks of random size, and seals at the end.
 */
export function growRandom(chain: FakeChain, r: Rng, addresses: readonly string[], count: number) {
  if (addresses.length === 0) return;
  const weights = addresses.map(() => r() ** 2 + 0.05);
  const total = weights.reduce((a, b) => a + b, 0);
  const sealP = pick(r, [0.05, 0.2, 0.5, 1]);
  for (let i = 0; i < count; i++) {
    let x = r() * total;
    let idx = 0;
    while (idx < addresses.length - 1 && x >= weights[idx]!) x -= weights[idx++]!;
    chain.addTx(addresses[idx]!);
    if (chance(r, sealP)) chain.seal();
  }
  chain.seal();
}

/** Transactions of `address` the indexer is responsible for (`lt > startLt`). */
export const inScope = (chain: FakeChain, address: string, startLt: bigint) =>
  chain.txs(address).filter((t) => t.lt > startLt);

/** A random `startLt`: full history, the lt of some transaction, or "now". */
export function randomStartLt(r: Rng, chain: FakeChain, address: string): bigint {
  const txs = chain.txs(address);
  const roll = r();
  if (roll < 0.5 || txs.length === 0) return 0n;
  if (roll < 0.85) return pick(r, txs).lt;
  return chain.tip().syncLt;
}

/** Random but survivable source faults. */
export function randomFaults(r: Rng, seed: number): Faults {
  if (chance(r, 0.25)) return { seed };
  return {
    seed,
    rateLimit: pick(r, [0, 0.05, 0.15, 0.3]),
    timeout: pick(r, [0, 0.05, 0.1]),
    timeoutMs: 1,
    badResponse: pick(r, [0, 0.1, 0.25]),
    latencyMs: chance(r, 0.5) ? [0, int(r, 1, 3)] : undefined,
    noFindTxNear: chance(r, 0.2),
  };
}

export async function newPgStore(): Promise<PgStore> {
  const store = new PgStore(new PGlite() as never);
  await store.migrate();
  return store;
}

/**
 * The store holds exactly the chain's in-scope transactions (same lt, hash, prev
 * link and BOC), the frontier is the last of them and no gap is left.
 */
export async function expectStoreMatchesChain(
  store: Store,
  chain: FakeChain,
  startLts: ReadonlyMap<string, bigint>,
  label = "",
) {
  for (const [address, startLt] of startLts) {
    const expected = inScope(chain, address, startLt);
    const stored = await store.read(address, 0n, LT_MAX, 1_000_000);
    expect({ label, address, lts: stored.map((t) => t.lt) }).toEqual({
      label,
      address,
      lts: expected.map((t) => t.lt),
    });
    for (let i = 0; i < stored.length; i++) {
      const s = stored[i]!;
      const e = expected[i]!;
      expect(s.hash.equals(e.hash) && s.prevHash.equals(e.prevHash) && s.boc.equals(e.boc)).toBe(
        true,
      );
      expect(s.prevLt).toBe(e.prevLt);
    }
    const state = await store.getAddress(address);
    expect(state?.frontier?.lt ?? null).toBe(expected.at(-1)?.lt ?? null);
    expect(state?.head?.lt ?? null).toBe(expected.at(-1)?.lt ?? null);
    expect(await store.findGaps(address)).toEqual([]);
  }
}

/**
 * Samples the store while something runs against it and records every violation of
 * the read-side invariants:
 * - the frontier and syncedLt of an address never decrease;
 * - everything at or below the frontier is stored and is exactly the chain's prefix;
 * - syncedLt is sound: no in-scope chain transaction with `lt <= syncedLt` is missing
 *   (this is what the global watermark relies on);
 * - nothing stored is unknown to the chain or out of scope.
 */
export class InvariantMonitor {
  readonly violations: string[] = [];
  samples = 0;
  private readonly last = new Map<string, { frontier: bigint; synced: bigint }>();
  private stopped = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly chain: FakeChain,
    private readonly startLts: ReadonlyMap<string, bigint>,
  ) {}

  start(everyMs = 3): this {
    this.loop = (async () => {
      while (!this.stopped) {
        await this.check();
        await sleep(everyMs);
      }
    })();
    return this;
  }

  async stop(): Promise<string[]> {
    this.stopped = true;
    await this.loop;
    await this.check();
    return this.violations;
  }

  async check(): Promise<void> {
    this.samples++;
    for (const [address, startLt] of this.startLts) {
      const state = await this.store.getAddress(address);
      if (!state) continue;
      // Chain snapshot before reading the store: the store can only be ahead of it.
      const chainTxs = inScope(this.chain, address, startLt);
      const stored = await this.store.read(address, 0n, LT_MAX, 1_000_000);
      const frontier = state.frontier?.lt ?? startLt;
      const synced = state.syncedLt;
      const prev = this.last.get(address);
      if (prev && frontier < prev.frontier) {
        this.fail(`${address}: frontier went back ${prev.frontier} -> ${frontier}`);
      }
      if (prev && synced < prev.synced) {
        this.fail(`${address}: syncedLt went back ${prev.synced} -> ${synced}`);
      }
      this.last.set(address, { frontier, synced });

      const storedByLt = new Map(stored.map((t) => [t.lt, t]));
      for (const t of stored) {
        if (t.lt <= startLt) this.fail(`${address}: out-of-scope tx ${t.lt} stored`);
      }
      const known = new Map(this.chain.txs(address).map((t) => [t.lt, t]));
      for (const t of stored) {
        const c = known.get(t.lt);
        if (!c?.hash.equals(t.hash)) this.fail(`${address}: stored tx ${t.lt} not on chain`);
      }
      const bound = completeUpTo(state);
      for (const t of chainTxs) {
        if (t.lt > bound) break;
        if (!storedByLt.has(t.lt)) {
          const why = t.lt <= frontier ? "frontier" : "syncedLt";
          this.fail(`${address}: tx ${t.lt} missing below ${why} (complete up to ${bound})`);
          break;
        }
      }
    }
  }

  private fail(message: string) {
    if (this.violations.length < 20) this.violations.push(message);
  }
}
