import { describe, expect, test } from "bun:test";

import { analyzeChain, validatePage } from "../src/chain";
import { SourceError } from "../src/errors";
import { lastTxFromStateProof } from "../src/source/account-proof";
import proofs from "./fixtures/account-state-proofs.json";
import { FakeChain, fakeAddress } from "./fixtures/fake-chain";

const A = fakeAddress(1);

function chainOf(n: number) {
  const chain = new FakeChain();
  chain.grow([A], n);
  return chain.txs(A);
}

describe("validatePage", () => {
  const txs = chainOf(20);
  const page = txs.slice(0, 16).reverse();
  const from = { lt: page[0]!.lt, hash: page[0]!.hash };

  test("accepts a linked page starting at the cursor", () => {
    expect(() => validatePage(from, page)).not.toThrow();
  });

  test("rejects a page that starts elsewhere", () => {
    expect(() => validatePage({ lt: txs[19]!.lt, hash: txs[19]!.hash }, page)).toThrow(SourceError);
  });

  test("rejects a page with a missing link", () => {
    expect(() => validatePage(from, [page[0]!, ...page.slice(2)])).toThrow(/broken chain/);
  });

  test("rejects an empty page", () => {
    expect(() => validatePage(from, [])).toThrow(/empty/);
  });
});

describe("analyzeChain", () => {
  const txs = chainOf(30);

  test("complete chain from genesis", () => {
    const { frontier, gaps } = analyzeChain(A, txs, 0n);
    expect(frontier?.lt).toBe(txs[29]!.lt);
    expect(gaps).toEqual([]);
  });

  test("gaps in the middle and at the bottom", () => {
    const { frontier, gaps } = analyzeChain(A, [...txs.slice(3, 10), ...txs.slice(15)], 0n);
    expect(frontier).toBeNull();
    expect(gaps.map((g) => [g.aboveLt, g.prevLt, g.floorLt])).toEqual([
      [txs[3]!.lt, txs[2]!.lt, 0n],
      [txs[15]!.lt, txs[14]!.lt, txs[9]!.lt],
    ]);
  });

  test("startLt anchors the first in-scope transaction", () => {
    const { frontier, gaps } = analyzeChain(A, txs.slice(10), txs[9]!.lt);
    expect(frontier?.lt).toBe(txs[29]!.lt);
    expect(gaps).toEqual([]);
  });

  test("a hash mismatch is a gap even when the lt matches", () => {
    const forged = { ...txs[5]!, hash: Buffer.alloc(32, 1) };
    const { frontier, gaps } = analyzeChain(A, [...txs.slice(0, 5), forged, ...txs.slice(6)], 0n);
    expect(frontier?.lt).toBe(txs[5]!.lt);
    expect(gaps[0]!.aboveLt).toBe(txs[6]!.lt);
  });
});

describe("lastTxFromStateProof", () => {
  // Real mainnet getAccountState proofs, with the last tx ton-lite-client parsed from them.
  test.each(proofs.map((f) => [f.address.slice(0, 12), f] as const))("%s", (_, f) => {
    const got = lastTxFromStateProof(
      Buffer.from(f.proof, "base64"),
      Buffer.from(f.address.split(":")[1]!, "hex")
    );
    expect(got?.lt.toString()).toBe(f.expected.lt);
    expect(got?.hash.toString("hex")).toBe(f.expected.hash);
  });

  test("an account the proof does not cover is an error, not a silent null", () => {
    const f = proofs[0]!;
    const other = Buffer.from(f.address.split(":")[1]!, "hex");
    other[0] = other[0]! ^ 0xff;
    expect(() => lastTxFromStateProof(Buffer.from(f.proof, "base64"), other)).toThrow(/not covered/);
  });
});
