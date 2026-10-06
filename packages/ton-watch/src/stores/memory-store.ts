import { analyzeChain } from "../chain";
import type { AddressState, Gap, TxId, TxRecord } from "../types";
import type { AddAddressOptions, Store } from "./store";

interface Entry {
  state: AddressState;
  txs: Map<bigint, TxRecord>;
  sorted: TxRecord[] | null;
}

/** In-process store. Useful for tests, benchmarks, and short-lived tools. */
export class MemoryStore implements Store {
  private entries = new Map<string, Entry>();
  private cursors = new Map<string, bigint>();

  async migrate() {}
  async close() {}

  private entry(address: string): Entry {
    const e = this.entries.get(address);
    if (!e) throw new Error(`unknown address ${address}`);
    return e;
  }

  private sorted(e: Entry) {
    e.sorted ??= [...e.txs.values()].sort((a, b) => (a.lt < b.lt ? -1 : 1));
    return e.sorted;
  }

  async addAddress(address: string, o: AddAddressOptions) {
    const existing = this.entries.get(address);
    if (existing) {
      existing.state.active = true;
      return;
    }
    this.entries.set(address, {
      state: {
        address,
        startLt: o.startLt,
        active: true,
        head: null,
        frontier: null,
        syncedLt: o.syncedLt ?? 0n,
        syncedUtime: o.syncedUtime ?? null,
      },
      txs: new Map(),
      sorted: null,
    });
  }

  async removeAddress(address: string, o?: { purge?: boolean }) {
    if (o?.purge) {
      this.entries.delete(address);
      for (const k of this.cursors.keys()) if (k.endsWith(`|${address}`)) this.cursors.delete(k);
      return;
    }
    const e = this.entries.get(address);
    if (e) e.state.active = false;
  }

  private snapshot(e: Entry): AddressState {
    const last = this.sorted(e).at(-1);
    return {
      ...e.state,
      head: last ? { lt: last.lt, hash: last.hash } : null,
    };
  }

  async getAddress(address: string) {
    const e = this.entries.get(address);
    return e ? this.snapshot(e) : null;
  }

  async listAddresses(o?: { includeInactive?: boolean }) {
    return [...this.entries.values()]
      .filter((e) => o?.includeInactive || e.state.active)
      .map((e) => this.snapshot(e));
  }

  async write(address: string, txs: TxRecord[]) {
    const e = this.entry(address);
    let inserted = 0;
    for (const tx of txs) {
      if (tx.lt <= e.state.startLt || e.txs.has(tx.lt)) continue;
      e.txs.set(tx.lt, tx);
      inserted++;
    }
    if (inserted) e.sorted = null;
    return inserted;
  }

  private above(e: Entry) {
    const from = e.state.frontier?.lt ?? e.state.startLt;
    return this.sorted(e).filter((t) => t.lt > from);
  }

  async findGaps(address: string, limit = 100): Promise<Gap[]> {
    const e = this.entry(address);
    const above = this.above(e);
    // Include the frontier tx itself so the first one above it can link to it.
    const base = e.state.frontier ? e.txs.get(e.state.frontier.lt) : undefined;
    const { gaps } = analyzeChain(
      address,
      base ? [base, ...above] : above,
      e.state.startLt,
      e.state.frontier,
    );
    return gaps.slice(0, limit);
  }

  async advanceFrontier(address: string): Promise<TxId | null> {
    const e = this.entry(address);
    const base = e.state.frontier ? e.txs.get(e.state.frontier.lt) : undefined;
    const { frontier } = analyzeChain(
      address,
      base ? [base, ...this.above(e)] : this.above(e),
      e.state.startLt,
      e.state.frontier,
    );
    e.state.frontier = frontier;
    return frontier;
  }

  async markSynced(addresses: string[], syncLt: bigint, utime: number) {
    for (const address of addresses) {
      const e = this.entries.get(address);
      if (!e) continue;
      const head = this.sorted(e).at(-1);
      if ((head?.lt ?? null) !== (e.state.frontier?.lt ?? null)) continue;
      if (syncLt > e.state.syncedLt) {
        e.state.syncedLt = syncLt;
        e.state.syncedUtime = utime;
      }
    }
  }

  async read(address: string, afterLt: bigint, uptoLt: bigint, limit: number) {
    const out: TxRecord[] = [];
    for (const tx of this.sorted(this.entry(address))) {
      if (tx.lt <= afterLt) continue;
      if (tx.lt > uptoLt || out.length >= limit) break;
      out.push(tx);
    }
    return out;
  }

  async getCursor(consumer: string, address: string) {
    return this.cursors.get(`${consumer}|${address}`) ?? null;
  }

  async setCursor(consumer: string, address: string, lt: bigint) {
    this.cursors.set(`${consumer}|${address}`, lt);
  }

  /** Number of stored transactions (all addresses). */
  get size() {
    let n = 0;
    for (const e of this.entries.values()) n += e.txs.size;
    return n;
  }
}
