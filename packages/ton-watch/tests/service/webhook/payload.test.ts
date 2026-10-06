import { describe, expect, test } from "bun:test";
import { Address, beginCell, ExternalAddress } from "@ton/core";

import { deliveryId, toJsonValue, webhookPayload } from "../../../src/service/webhook/payload";
import { FakeChain, fakeAddress } from "../../fixtures/fake-chain";

const A = fakeAddress(1);

function chainOf(count: number) {
  const chain = new FakeChain();
  chain.grow([A], count);
  return chain.txs(A);
}

describe("webhookPayload", () => {
  test("carries ids, both hash encodings, the prev link, the BOC and the parsed summary", () => {
    const [first, second] = chainOf(2);
    const payload = webhookPayload(second!, { webhook: "billing", testOnly: false });
    expect(payload).toMatchObject({
      id: `${A}:${second!.lt}:${second!.hash.toString("hex")}`,
      webhook: "billing",
      address: { raw: A, friendly: Address.parse(A).toString() },
      lt: second!.lt.toString(),
      hash: { hex: second!.hash.toString("hex"), base64: second!.hash.toString("base64") },
      utime: second!.utime,
      prev: {
        lt: first!.lt.toString(),
        hash: { hex: first!.hash.toString("hex"), base64: first!.hash.toString("base64") },
      },
      boc: second!.boc.toString("base64"),
      replay: false,
    });
    expect(payload.parsed).toMatchObject({
      type: "storage",
      direction: "system",
      success: true,
      inMessage: null,
      outMessages: [],
      totalFees: "1",
      valueIn: "0",
      valueOut: "0",
    });
    // Top-level duplicates and @ton/core objects are left out.
    for (const key of ["address", "lt", "hash", "utime", "raw"]) {
      expect(payload.parsed).not.toHaveProperty(key);
    }
    // Plain JSON: survives a round trip unchanged.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  test("an account's first transaction has no prev; testnet friendly form", () => {
    const [first] = chainOf(1);
    const payload = webhookPayload(first!, { webhook: "w", testOnly: true });
    expect(payload.prev).toBeNull();
    expect(payload.address.friendly).toBe(Address.parse(A).toString({ testOnly: true }));
    expect(payload.address.friendly.startsWith("k")).toBe(true);
  });

  test("replay: true marks a replayed dead letter", () => {
    const [first] = chainOf(1);
    expect(webhookPayload(first!, { webhook: "w", testOnly: false, replay: true }).replay).toBe(
      true,
    );
  });

  test("an unparsable BOC still delivers, with parsed null", () => {
    const [first] = chainOf(1);
    const broken = { ...first!, boc: beginCell().storeUint(1, 8).endCell().toBoc() };
    expect(webhookPayload(broken, { webhook: "w", testOnly: false }).parsed).toBeNull();
  });

  test("deliveryId is address:lt:hex hash", () => {
    const [first] = chainOf(1);
    expect(deliveryId(first!)).toBe(`${A}:${first!.lt}:${first!.hash.toString("hex")}`);
  });
});

describe("toJsonValue", () => {
  test("converts @ton/core and Node values and drops raw", () => {
    const cell = beginCell().storeUint(7, 8).endCell();
    expect(
      toJsonValue({
        n: 5n,
        address: Address.parse(A),
        external: new ExternalAddress(5n, 8),
        cell,
        data: Buffer.from("hi"),
        map: new Map([[1, 2n]]),
        list: [1n, null, "s", true],
        raw: { anything: 1 },
      }),
    ).toEqual({
      n: "5",
      address: A,
      external: new ExternalAddress(5n, 8).toString(),
      cell: cell.toBoc().toString("base64"),
      data: Buffer.from("hi").toString("base64"),
      map: { "1": "2" },
      list: ["1", null, "s", true],
    });
  });
});
