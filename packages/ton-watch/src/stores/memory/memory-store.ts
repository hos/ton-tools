import { analyzeChain, type ChainAnalysis } from "../../core/chain";
import type { AddressState, Gap, TxId, TxRecord } from "../../core/types";
import type { AddAddressOptions, Store } from "../store";

interface AddressEntry {
  state: AddressState;
  txs: Map<bigint, TxRecord>;
  /** `txs` in ascending lt order; rebuilt lazily after writes. */
  sorted: TxRecord[] | null;
}

const DEFAULT_GAP_LIMIT = 100;

const cursorKey = (consumer: string, address: string) => `${consumer}|${address}`;

/** In-process store. Useful for tests, benchmarks, and short-lived tools. */
export class MemoryStore implements Store {
  private readonly entries = new Map<string, AddressEntry>();
  private readonly cursors = new Map<string, bigint>();

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  async addAddress(address: string, options: AddAddressOptions): Promise<void> {
    const existing = this.entries.get(address);
    if (existing) {
      existing.state.active = true;
      return;
    }
    this.entries.set(address, {
      state: {
        address,
        startLt: options.startLt,
        active: true,
        head: null,
        frontier: null,
        syncedLt: options.syncedLt ?? 0n,
        syncedUtime: options.syncedUtime ?? null,
      },
      txs: new Map(),
      sorted: null,
    });
  }

  async removeAddress(address: string, options?: { purge?: boolean }): Promise<void> {
    if (options?.purge) {
      this.entries.delete(address);
      for (const key of this.cursors.keys()) {
        if (key.endsWith(`|${address}`)) this.cursors.delete(key);
      }
      return;
    }
    const entry = this.entries.get(address);
    if (entry) entry.state.active = false;
  }

  async getAddress(address: string): Promise<AddressState | null> {
    const entry = this.entries.get(address);
    return entry ? this.snapshot(entry) : null;
  }

  async listAddresses(options?: { includeInactive?: boolean }): Promise<AddressState[]> {
    return [...this.entries.values()]
      .filter((entry) => options?.includeInactive || entry.state.active)
      .map((entry) => this.snapshot(entry));
  }

  async write(address: string, txs: TxRecord[]): Promise<number> {
    const entry = this.entry(address);
    let inserted = 0;
    for (const tx of txs) {
      if (tx.lt <= entry.state.startLt || entry.txs.has(tx.lt)) continue;
      entry.txs.set(tx.lt, tx);
      inserted++;
    }
    if (inserted > 0) entry.sorted = null;
    return inserted;
  }

  async findGaps(address: string, limit = DEFAULT_GAP_LIMIT): Promise<Gap[]> {
    return this.analyze(this.entry(address)).gaps.slice(0, limit);
  }

  async advanceFrontier(address: string): Promise<TxId | null> {
    const entry = this.entry(address);
    const { frontier } = this.analyze(entry);
    entry.state.frontier = frontier;
    return frontier;
  }

  async markSynced(addresses: string[], syncLt: bigint, utime: number): Promise<void> {
    for (const address of addresses) {
      const entry = this.entries.get(address);
      if (!entry) continue;
      const head = this.sorted(entry).at(-1);
      if ((head?.lt ?? null) !== (entry.state.frontier?.lt ?? null)) continue;
      if (syncLt > entry.state.syncedLt) {
        entry.state.syncedLt = syncLt;
        entry.state.syncedUtime = utime;
      }
    }
  }

  async read(address: string, afterLt: bigint, uptoLt: bigint, limit: number): Promise<TxRecord[]> {
    const result: TxRecord[] = [];
    for (const tx of this.sorted(this.entry(address))) {
      if (tx.lt <= afterLt) continue;
      if (tx.lt > uptoLt || result.length >= limit) break;
      result.push(tx);
    }
    return result;
  }

  async getCursor(consumer: string, address: string): Promise<bigint | null> {
    return this.cursors.get(cursorKey(consumer, address)) ?? null;
  }

  async setCursor(consumer: string, address: string, lt: bigint): Promise<void> {
    this.cursors.set(cursorKey(consumer, address), lt);
  }

  /** Number of stored transactions (all addresses). */
  get size(): number {
    let count = 0;
    for (const entry of this.entries.values()) count += entry.txs.size;
    return count;
  }

  private entry(address: string): AddressEntry {
    const entry = this.entries.get(address);
    if (!entry) throw new Error(`unknown address ${address}`);
    return entry;
  }

  private sorted(entry: AddressEntry): TxRecord[] {
    entry.sorted ??= [...entry.txs.values()].sort((a, b) => (a.lt < b.lt ? -1 : 1));
    return entry.sorted;
  }

  private snapshot(entry: AddressEntry): AddressState {
    const last = this.sorted(entry).at(-1);
    return { ...entry.state, head: last ? { lt: last.lt, hash: last.hash } : null };
  }

  /** Frontier and gaps above the stored frontier. */
  private analyze(entry: AddressEntry): ChainAnalysis {
    const { frontier, startLt } = entry.state;
    const fromLt = frontier?.lt ?? startLt;
    const above = this.sorted(entry).filter((tx) => tx.lt > fromLt);
    // Include the frontier tx itself so the first one above it can link to it.
    const base = frontier ? entry.txs.get(frontier.lt) : undefined;
    return analyzeChain(entry.state.address, base ? [base, ...above] : above, startLt, frontier);
  }
}
