import { describe, expect, test } from "bun:test";

import {
  Address,
  beginCell,
  Cell,
  Dictionary,
  loadTransaction,
  storeTransaction,
  type Transaction,
} from "@ton/core";

import { recordFromCell } from "../../src/core/transaction";
import { type AddressState, completeUpTo, toIndexedTx, txIdEquals } from "../../src/core/types";
import { FakeChain, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);

function txCell(fields: { lt: bigint; prevLt: bigint; prevHash: bigint; now?: number }): Cell {
  const tx: Transaction = {
    address: 1n,
    lt: fields.lt,
    prevTransactionHash: fields.prevHash,
    prevTransactionLt: fields.prevLt,
    now: fields.now ?? 1_700_000_000,
    outMessagesCount: 0,
    oldStatus: "active",
    endStatus: "active",
    inMessage: undefined,
    outMessages: Dictionary.empty(Dictionary.Keys.Uint(15), null as never),
    totalFees: { coins: 0n },
    stateUpdate: { oldHash: Buffer.alloc(32), newHash: Buffer.alloc(32) },
    description: {
      type: "storage",
      storagePhase: { storageFeesCollected: 0n, statusChange: "unchanged" },
    },
    raw: null as never,
    hash: null as never,
  };
  return beginCell().store(storeTransaction(tx)).endCell();
}

describe("recordFromCell", () => {
  const chain = new FakeChain();
  chain.grow([A], 5);
  const txs = chain.txs(A);

  test("reproduces every field of a real transaction cell", () => {
    for (const tx of txs) {
      const cell = Cell.fromBoc(tx.boc)[0]!;
      const record = recordFromCell(cell, A);
      expect(record.address).toBe(A);
      expect(record.lt).toBe(tx.lt);
      expect(record.hash.equals(tx.hash)).toBe(true);
      expect(record.prevLt).toBe(tx.prevLt);
      expect(record.prevHash.equals(tx.prevHash)).toBe(true);
      expect(record.utime).toBe(tx.utime);
      expect(record.boc.equals(tx.boc)).toBe(true);
    }
  });

  test("the hash is the cell hash, never a claimed one", () => {
    const record = recordFromCell(Cell.fromBoc(txs[2]!.boc)[0]!, A);
    expect(Cell.fromBoc(record.boc)[0]!.hash().equals(record.hash)).toBe(true);
  });

  test("the first transaction links to lt 0 and a zero hash", () => {
    const record = recordFromCell(Cell.fromBoc(txs[0]!.boc)[0]!, A);
    expect(record.prevLt).toBe(0n);
    expect(record.prevHash.equals(Buffer.alloc(32))).toBe(true);
  });

  test("prev hashes with leading zero bytes are left-padded to 32 bytes", () => {
    const record = recordFromCell(txCell({ lt: 10n, prevLt: 5n, prevHash: 0xffn }), A);
    expect(record.prevHash.length).toBe(32);
    expect(record.prevHash.toString("hex")).toBe(`${"00".repeat(31)}ff`);
  });

  test("an all-ones prev hash survives", () => {
    const record = recordFromCell(txCell({ lt: 10n, prevLt: 5n, prevHash: (1n << 256n) - 1n }), A);
    expect(record.prevHash.equals(Buffer.alloc(32, 0xff))).toBe(true);
  });

  test("lt at the uint64 maximum is kept exactly", () => {
    const max = (1n << 64n) - 1n;
    const record = recordFromCell(txCell({ lt: max, prevLt: max - 1n, prevHash: 1n }), A);
    expect(record.lt).toBe(max);
    expect(record.prevLt).toBe(max - 1n);
  });

  test("lt beyond uint64 cannot be serialized", () => {
    expect(() => txCell({ lt: 1n << 64n, prevLt: 0n, prevHash: 0n })).toThrow();
  });

  test("a cell that is not a transaction throws", () => {
    expect(() => recordFromCell(beginCell().storeUint(0, 8).endCell(), A)).toThrow();
    expect(() => recordFromCell(beginCell().endCell(), A)).toThrow();
  });

  test("the BOC is serialized without index or crc32, deterministically", () => {
    const cell = txCell({ lt: 10n, prevLt: 5n, prevHash: 3n });
    const a = recordFromCell(cell, A).boc;
    const b = recordFromCell(Cell.fromBoc(a)[0]!, A).boc;
    expect(a.equals(b)).toBe(true);
    expect(a.equals(cell.toBoc({ idx: false, crc32: false }))).toBe(true);
    expect(a.equals(cell.toBoc({ idx: false, crc32: true }))).toBe(false);
  });

  test("the address argument is taken as given (callers pass the raw form)", () => {
    const raw = Address.parse(A).toRawString();
    expect(recordFromCell(txCell({ lt: 10n, prevLt: 0n, prevHash: 0n }), raw).address).toBe(raw);
  });
});

describe("toIndexedTx", () => {
  const chain = new FakeChain();
  chain.grow([A], 2);
  const record = chain.txs(A)[1]!;

  test("parses lazily and caches the parsed transaction", () => {
    const indexed = toIndexedTx(record);
    const parsed = indexed.transaction;
    expect(parsed.lt).toBe(record.lt);
    expect(parsed.prevTransactionLt).toBe(record.prevLt);
    expect(indexed.transaction).toBe(parsed);
  });

  test("the parsed transaction is not enumerable and the record is copied", () => {
    const indexed = toIndexedTx(record);
    expect(Object.keys(indexed).sort()).toEqual(
      ["address", "boc", "hash", "lt", "prevHash", "prevLt", "utime"].sort(),
    );
    expect(indexed).not.toBe(record);
  });

  test("a corrupt BOC only throws when the transaction is accessed", () => {
    const indexed = toIndexedTx({ ...record, boc: Buffer.from("garbage") });
    expect(indexed.lt).toBe(record.lt);
    expect(() => indexed.transaction).toThrow(/Invalid magic/);
  });

  test("a BOC holding a non-transaction cell throws on access", () => {
    const boc = beginCell().storeUint(7, 8).endCell().toBoc();
    expect(() => toIndexedTx({ ...record, boc }).transaction).toThrow();
  });

  test("a parsed transaction round-trips to the same hash", () => {
    const parsed = loadTransaction(Cell.fromBoc(record.boc)[0]!.beginParse());
    const cell = beginCell().store(storeTransaction(parsed)).endCell();
    expect(cell.hash().equals(record.hash)).toBe(true);
  });
});

describe("txIdEquals", () => {
  const h = Buffer.alloc(32, 1);
  test.each([
    [null, null, true],
    [undefined, null, true],
    [{ lt: 1n, hash: h }, null, false],
    [null, { lt: 1n, hash: h }, false],
    [{ lt: 1n, hash: h }, { lt: 1n, hash: Buffer.from(h) }, true],
    [{ lt: 1n, hash: h }, { lt: 2n, hash: h }, false],
    [{ lt: 1n, hash: h }, { lt: 1n, hash: Buffer.alloc(32, 2) }, false],
    [{ lt: 1n, hash: h }, { lt: 1n, hash: Buffer.alloc(31, 1) }, false],
  ])("%p vs %p -> %p", (a, b, expected) => {
    expect(txIdEquals(a, b)).toBe(expected);
  });
});

describe("completeUpTo", () => {
  const base: AddressState = {
    address: A,
    startLt: 100n,
    active: true,
    head: null,
    frontier: null,
    syncedLt: 0n,
    syncedUtime: null,
  };
  test.each([
    [null, 0n, 100n],
    [null, 500n, 500n],
    [700n, 500n, 700n],
    [700n, 900n, 900n],
    [(1n << 64n) - 1n, 0n, (1n << 64n) - 1n],
  ])("frontier %p, syncedLt %p -> %p", (frontierLt, syncedLt, expected) => {
    const frontier = frontierLt === null ? null : { lt: frontierLt, hash: Buffer.alloc(32) };
    expect(completeUpTo({ ...base, frontier, syncedLt })).toBe(expected);
  });
});
