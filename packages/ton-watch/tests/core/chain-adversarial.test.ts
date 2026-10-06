import { describe, expect, test } from "bun:test";

import { beginCell, Cell, loadTransaction, storeTransaction } from "@ton/core";

import { analyzeChain, isAnchored, validatePage } from "../../src/core/chain";
import { SourceError } from "../../src/core/errors";
import { recordFromCell } from "../../src/core/transaction";
import type { TxId, TxRecord } from "../../src/core/types";
import { FakeChain, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);

const chain = new FakeChain();
chain.grow([A, B], 40);
const txsA = chain.txs(A);
const txsB = chain.txs(B);

/** The honest page ending at index `top` of A, newest first. */
const honest = (top = 30, size = 16) => txsA.slice(top - size + 1, top + 1).reverse();
const idOf = (tx: TxRecord): TxId => ({ lt: tx.lt, hash: tx.hash });
const from = idOf(txsA[30]!);

/** The same transaction with one field changed, re-serialized and re-hashed honestly. */
function tampered(tx: TxRecord): TxRecord {
  const parsed = loadTransaction(Cell.fromBoc(tx.boc)[0]!.beginParse());
  parsed.now += 1;
  return recordFromCell(beginCell().store(storeTransaction(parsed)).endCell(), tx.address);
}

function rejection(page: TxRecord[], cursor: TxId = from): SourceError {
  try {
    validatePage(cursor, page);
  } catch (error) {
    expect(error).toBeInstanceOf(SourceError);
    return error as SourceError;
  }
  throw new Error("page was accepted");
}

describe("validatePage against lying sources", () => {
  const page = honest();

  test.each<[string, () => TxRecord[], RegExp]>([
    ["empty page", () => [], /^empty page at lt /],
    ["oldest first", () => [...page].reverse(), /^page starts at /],
    ["first two swapped", () => [page[1]!, page[0]!, ...page.slice(2)], /^page starts at /],
    [
      "middle pair swapped",
      () => [...page.slice(0, 4), page[5]!, page[4]!, ...page.slice(6)],
      /^broken chain inside page/,
    ],
    ["duplicated cursor", () => [page[0]!, ...page], /^broken chain inside page/],
    [
      "duplicated middle tx",
      () => [...page.slice(0, 5), page[4]!, ...page.slice(5)],
      /^broken chain inside page/,
    ],
    ["skips one tx", () => [...page.slice(0, 7), ...page.slice(8)], /^broken chain inside page/],
    ["starts one older", () => page.slice(1), /^page starts at /],
    ["starts one newer", () => [txsA[31]!, ...page], /^page starts at /],
    ["another address's page", () => txsB.slice(15, 31).reverse(), /^page starts at /],
    [
      "another address's tx inside",
      () => [...page.slice(0, 3), txsB[27]!, ...page.slice(4)],
      /^broken chain inside page/,
    ],
    [
      "tampered BOC at the cursor",
      () => [tampered(page[0]!), ...page.slice(1)],
      /^page starts at /,
    ],
    [
      "tampered BOC inside",
      () => [...page.slice(0, 6), tampered(page[6]!), ...page.slice(7)],
      /^broken chain inside page/,
    ],
    [
      "cursor with a wrong hash",
      () => [{ ...page[0]!, hash: Buffer.alloc(32, 7) }, ...page.slice(1)],
      /^page starts at /,
    ],
    [
      "inner tx with a wrong hash",
      () => [...page.slice(0, 2), { ...page[2]!, hash: Buffer.alloc(32, 7) }, ...page.slice(3)],
      /^broken chain inside page/,
    ],
    [
      "truncated hash at the cursor",
      () => [{ ...page[0]!, hash: page[0]!.hash.subarray(0, 31) }, ...page.slice(1)],
      /^page starts at /,
    ],
    [
      "prev hash right, prev lt off by one",
      () => [{ ...page[0]!, prevLt: page[0]!.prevLt - 1n }, ...page.slice(1)],
      /^broken chain inside page/,
    ],
    [
      "prev lt right, prev hash wrong",
      () => [{ ...page[0]!, prevHash: Buffer.alloc(32, 9) }, ...page.slice(1)],
      /^broken chain inside page/,
    ],
    [
      "cursor lt shifted by 2^64",
      () => [{ ...page[0]!, lt: page[0]!.lt + (1n << 64n) }, ...page.slice(1)],
      /^page starts at /,
    ],
    [
      "cursor lt negative",
      () => [{ ...page[0]!, lt: -page[0]!.lt }, ...page.slice(1)],
      /^page starts at /,
    ],
  ])("rejects: %s", (_, build, message) => {
    const error = rejection(build());
    expect(error.kind).toBe("bad_response");
    expect(error.message).toMatch(message);
  });

  test("accepts honest prefixes of any length, down to one transaction", () => {
    for (let n = 1; n <= page.length; n++) {
      expect(() => validatePage(from, page.slice(0, n))).not.toThrow();
    }
  });

  test("accepts a page reaching the account's first transaction", () => {
    const genesisPage = txsA.slice(0, 5).reverse();
    expect(() => validatePage(idOf(genesisPage[0]!), genesisPage)).not.toThrow();
    expect(genesisPage.at(-1)!.prevLt).toBe(0n);
  });

  test("the input page is not mutated, even when rejected", () => {
    const bad = [page[0]!, page[2]!];
    const snapshot = bad.map((t) => ({ lt: t.lt, hash: Buffer.from(t.hash) }));
    rejection(bad);
    expect(bad.map((t) => ({ lt: t.lt, hash: t.hash }))).toEqual(snapshot);
  });

  // Root cause of the history-plug-in failures in tests/indexer/adversarial.test.ts:
  // validatePage trusts a record's lt/hash/prev fields and never checks them against
  // its BOC. A source returning self-consistent fields with a different BOC (or
  // forged prev fields that skip a transaction) passes.
  test.failing("rejects a record whose fields disagree with its BOC", () => {
    const forged = { ...page[0]!, boc: txsA[29]!.boc };
    expect(() => validatePage(from, [forged, ...page.slice(1)])).toThrow(SourceError);
  });

  test.failing("rejects forged prev fields that skip a transaction", () => {
    const skipping = { ...page[0]!, prevLt: page[2]!.lt, prevHash: page[2]!.hash };
    expect(() => validatePage(from, [skipping, ...page.slice(2)])).toThrow(SourceError);
  });
});

describe("isAnchored", () => {
  test.each([
    [0n, 0n, true],
    [99n, 100n, true],
    [100n, 100n, true],
    [101n, 100n, false],
    [(1n << 64n) - 1n, (1n << 64n) - 1n, true],
    [1n << 64n, (1n << 64n) - 1n, false],
  ])("prevLt %p, startLt %p -> %p", (prevLt, startLt, expected) => {
    expect(isAnchored({ prevLt }, startLt)).toBe(expected);
  });
});

/** Synthetic linked records (no BOC needed by analyzeChain). */
function syntheticChain(lts: bigint[]): TxRecord[] {
  const out: TxRecord[] = [];
  for (const [i, lt] of lts.entries()) {
    const prev = out[i - 1];
    out.push({
      address: A,
      lt,
      hash: Buffer.alloc(32, i + 1),
      prevLt: prev?.lt ?? 0n,
      prevHash: prev?.hash ?? Buffer.alloc(32),
      utime: 0,
      boc: Buffer.alloc(0),
    });
  }
  return out;
}

describe("analyzeChain with hostile data", () => {
  test("lts far beyond 2^64 are compared exactly", () => {
    const base = 1n << 80n;
    const txs = syntheticChain([base + 1n, base + 2n, base + 3n]);
    expect(analyzeChain(A, txs, 0n)).toEqual({ frontier: idOf(txs[2]!), gaps: [] });
  });

  test("lts differing only above bit 64 are not confused", () => {
    const txs = syntheticChain([5n, (1n << 64n) + 5n]);
    // A forged tx at lt 5 + 2^64 claiming prev lt 5 with the wrong hash is a gap.
    const forged = { ...txs[1]!, prevHash: Buffer.alloc(32, 0xee) };
    const { frontier, gaps } = analyzeChain(A, [txs[0]!, forged], 0n);
    expect(frontier).toEqual(idOf(txs[0]!));
    expect(gaps.map((g) => [g.aboveLt, g.prevLt, g.floorLt])).toEqual([[forged.lt, 5n, 5n]]);
  });

  test("a stored tx from another chain blocks the frontier at the last good one", () => {
    const own = txsA.slice(0, 10);
    const foreign = { ...txsB[10]!, lt: txsA[10]!.lt };
    const { frontier, gaps } = analyzeChain(A, [...own, foreign, ...txsA.slice(11, 15)], 0n);
    expect(frontier).toEqual(idOf(txsA[9]!));
    expect(gaps.map((g) => g.aboveLt)).toEqual([foreign.lt, txsA[11]!.lt]);
  });

  test("a self-referencing tx is not linked", () => {
    const [tx] = syntheticChain([10n]);
    const loop = { ...tx!, prevLt: 10n, prevHash: Buffer.alloc(32, 0xaa) };
    const { frontier, gaps } = analyzeChain(A, [loop], 0n);
    expect(frontier).toBeNull();
    expect(gaps).toEqual([
      { address: A, aboveLt: 10n, prevLt: 10n, prevHash: loop.prevHash, floorLt: 0n },
    ]);
  });

  test("everything at or below `from` is skipped and only feeds the gap floor", () => {
    const txs = txsA.slice(0, 20);
    const holed = [...txs.slice(0, 12), ...txs.slice(14)];
    const { frontier, gaps } = analyzeChain(A, holed, 0n, idOf(txs[11]!));
    expect(frontier).toEqual(idOf(txs[11]!));
    expect(gaps.map((g) => [g.aboveLt, g.prevLt, g.floorLt])).toEqual([
      [txs[14]!.lt, txs[13]!.lt, txs[11]!.lt],
    ]);
  });

  test("an empty list keeps `from` as the frontier", () => {
    const f = idOf(txsA[3]!);
    expect(analyzeChain(A, [], 0n, f)).toEqual({ frontier: f, gaps: [] });
    expect(analyzeChain(A, [], 0n)).toEqual({ frontier: null, gaps: [] });
  });
});
