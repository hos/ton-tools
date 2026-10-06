import { beginCell, Dictionary, storeTransaction, type Transaction } from "@ton/core";

import { SourceError } from "../../src/core/errors";
import type { TxId, TxRecord } from "../../src/core/types";
import { Metrics } from "../../src/metrics/metrics";
import type { ChainTip, TxSource } from "../../src/source/source";

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const fakeAddress = (n: number) => `0:${n.toString(16).padStart(64, "0")}`;

const big = (b: Buffer) => BigInt(`0x${b.toString("hex") || "0"}`);

/**
 * A synthetic chain of accounts with real transaction cells (so hashes and prev
 * links are genuine) and blocks, for driving the indexer deterministically.
 */
export class FakeChain {
  seqno = 1;
  utime = 1_700_000_000;
  private lt = 1_000_000n;
  readonly accounts = new Map<string, TxRecord[]>();
  readonly blocks: { seqno: number; txs: TxRecord[] }[] = [];
  private current: TxRecord[] = [];

  /** Appends one transaction to `address` in the block being built. */
  addTx(address: string): TxRecord {
    const chain = this.accounts.get(address) ?? [];
    this.accounts.set(address, chain);
    const prev = chain.at(-1);
    this.lt += 1_000n + BigInt(chain.length % 7);
    const tx: Transaction = {
      address: BigInt(`0x${address.split(":")[1]}`),
      lt: this.lt,
      prevTransactionHash: prev ? big(prev.hash) : 0n,
      prevTransactionLt: prev ? prev.lt : 0n,
      now: this.utime,
      outMessagesCount: 0,
      oldStatus: "active",
      endStatus: "active",
      inMessage: null as any,
      outMessages: Dictionary.empty(Dictionary.Keys.Uint(15), null as any),
      totalFees: { coins: BigInt(chain.length) },
      stateUpdate: { oldHash: Buffer.alloc(32), newHash: Buffer.alloc(32, chain.length % 256) },
      description: {
        type: "storage",
        storagePhase: { storageFeesCollected: 0n, statusChange: "unchanged" },
      },
      raw: null as any,
      hash: null as any,
    };
    const cell = beginCell().store(storeTransaction(tx)).endCell();
    const record: TxRecord = {
      address,
      lt: tx.lt,
      hash: cell.hash(),
      prevLt: tx.prevTransactionLt,
      prevHash: prev ? prev.hash : Buffer.alloc(32),
      utime: this.utime,
      boc: cell.toBoc({ idx: false, crc32: false }),
    };
    chain.push(record);
    this.current.push(record);
    return record;
  }

  /** Seals the current block and starts a new one. */
  seal() {
    this.blocks.push({ seqno: this.seqno, txs: this.current });
    this.current = [];
    this.seqno++;
    this.utime += 1;
    this.lt += 10_000n;
  }

  /** Adds `perAccount` transactions to each address, `perBlock` per block. */
  grow(addresses: string[], perAccount: number, perBlock = 1) {
    for (let i = 0; i < perAccount; i++) {
      for (const a of addresses) this.addTx(a);
      if ((i + 1) % perBlock === 0) this.seal();
    }
    this.seal();
  }

  tip(): ChainTip {
    const block = {
      workchain: -1,
      shard: "-9223372036854775808",
      seqno: this.seqno - 1,
      rootHash: Buffer.alloc(32, this.seqno % 256),
      fileHash: Buffer.alloc(32),
    };
    return {
      seqno: this.seqno - 1,
      utime: this.utime,
      block,
      shards: [{ ...block, workchain: 0, endLt: this.lt }],
      syncLt: this.lt,
    };
  }

  txs(address: string) {
    return this.accounts.get(address.toLowerCase()) ?? [];
  }
}

export interface Faults {
  seed?: number;
  /** Probability a call fails with "too many requests". */
  rateLimit?: number;
  /** Probability a call times out (after `timeoutMs`). */
  timeout?: number;
  timeoutMs?: number;
  /** Probability getTransactions returns a page with a broken link. */
  badResponse?: number;
  /** Random latency range; makes concurrent responses complete out of order. */
  latencyMs?: [number, number];
  /** Transactions below this lt are "pruned": archive_unavailable. */
  archiveFloorLt?: bigint;
  /** getTouchedAccounts returns null (forces poll fallback). */
  noBlockListing?: boolean;
  /** getTouchedAccounts silently omits these addresses (a listing that misses things). */
  hideFromListing?: Set<string>;
  /** findTxNear finds nothing. */
  noFindTxNear?: boolean;
}

/** `TxSource` over a `FakeChain` with injectable faults; counts calls per method. */
export class FakeSource implements TxSource {
  readonly maxPageSize = 16;
  readonly metrics = new Metrics();
  readonly calls: Record<string, number> = {};
  private random: () => number;

  constructor(
    readonly chain: FakeChain,
    public faults: Faults = {},
  ) {
    this.random = rng(faults.seed ?? 1);
  }

  get totalCalls() {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }

  private async enter(method: string) {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    this.metrics.call(method);
    const f = this.faults;
    if (f.latencyMs) {
      const [min, max] = f.latencyMs;
      await new Promise((r) => setTimeout(r, min + this.random() * (max - min)));
    }
    if (f.rateLimit && this.random() < f.rateLimit) {
      throw new Error("LITE_SERVER_UNKNOWN: too many requests");
    }
    if (f.timeout && this.random() < f.timeout) {
      await new Promise((r) => setTimeout(r, f.timeoutMs ?? 5));
      throw new SourceError("timeout", `${method} timed out`);
    }
  }

  async getTip() {
    await this.enter("getTip");
    return this.chain.tip();
  }

  async getLastTx(address: string, tip: ChainTip): Promise<TxId | null> {
    await this.enter("getLastTx");
    const txs = this.chain.txs(address).filter((t) => t.lt <= tip.syncLt);
    const last = txs.at(-1);
    return last ? { lt: last.lt, hash: last.hash } : null;
  }

  async getTransactions(address: string, from: TxId, count: number): Promise<TxRecord[]> {
    await this.enter("getTransactions");
    const txs = this.chain.txs(address);
    const idx = txs.findIndex((t) => t.lt === from.lt && t.hash.equals(from.hash));
    if (idx < 0 || (this.faults.archiveFloorLt && from.lt < this.faults.archiveFloorLt)) {
      throw new Error("cannot locate transaction in block with specified logical time");
    }
    const page = txs.slice(Math.max(0, idx - Math.min(count, 16) + 1), idx + 1).reverse();
    if (this.faults.badResponse && this.random() < this.faults.badResponse && page.length > 2) {
      return [page[0]!, page[2]!, ...page.slice(3)];
    }
    return page;
  }

  async findTxNear(address: string, lt: bigint): Promise<TxId | null> {
    await this.enter("findTxNear");
    if (this.faults.noFindTxNear) return null;
    const txs = this.chain.txs(address).filter((t) => t.lt <= lt);
    const t = txs.at(-1);
    return t ? { lt: t.lt, hash: t.hash } : null;
  }

  async getTouchedAccounts(prev: ChainTip, next: ChainTip) {
    await this.enter("getTouchedAccounts");
    if (this.faults.noBlockListing) return null;
    const touched = new Map<string, TxId>();
    for (const b of this.chain.blocks) {
      if (b.seqno <= prev.seqno || b.seqno > next.seqno) continue;
      for (const t of b.txs) {
        if (this.faults.hideFromListing?.has(t.address)) continue;
        const k = touched.get(t.address);
        if (!k || t.lt > k.lt) touched.set(t.address, { lt: t.lt, hash: t.hash });
      }
    }
    return touched;
  }
}

/** History plug-in over a `FakeChain`: big pages, full depth, optional faults. */
export class FakeHistory {
  readonly name = "fake-history";
  readonly calls = { getTransactions: 0 };
  constructor(
    readonly chain: FakeChain,
    public opts: { pageSize?: number; fail?: boolean; corrupt?: boolean; busy?: boolean } = {},
  ) {}
  get maxPageSize() {
    return this.opts.pageSize ?? 100;
  }
  busy() {
    return !!this.opts.busy;
  }
  async getTransactions(address: string, from: TxId, count: number): Promise<TxRecord[]> {
    this.calls.getTransactions++;
    if (this.opts.fail) throw new SourceError("network", "history down");
    const txs = this.chain.txs(address);
    const idx = txs.findIndex((t) => t.lt === from.lt && t.hash.equals(from.hash));
    if (idx < 0) throw new SourceError("archive_unavailable", "not found");
    const page = txs.slice(Math.max(0, idx - count + 1), idx + 1).reverse();
    return this.opts.corrupt && page.length > 2 ? [page[0]!, ...page.slice(2)] : page;
  }
}
