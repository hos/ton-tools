import { describe, expect, test } from "bun:test";

import { lastTxFromStateProof } from "../../src/source/liteserver/account-proof";
import proofs from "../fixtures/account-state-proofs.json";

describe("lastTxFromStateProof", () => {
  // Real mainnet getAccountState proofs, with the last tx ton-lite-client parsed from them.
  test.each(proofs.map((f) => [f.address.slice(0, 12), f] as const))("%s", (_, f) => {
    const got = lastTxFromStateProof(
      Buffer.from(f.proof, "base64"),
      Buffer.from(f.address.split(":")[1]!, "hex"),
    );
    expect(got?.lt.toString()).toBe(f.expected.lt);
    expect(got?.hash.toString("hex")).toBe(f.expected.hash);
  });

  test("an account the proof does not cover is an error, not a silent null", () => {
    const f = proofs[0]!;
    const other = Buffer.from(f.address.split(":")[1]!, "hex");
    other[0] = other[0]! ^ 0xff;
    expect(() => lastTxFromStateProof(Buffer.from(f.proof, "base64"), other)).toThrow(
      /not covered/,
    );
  });
});
