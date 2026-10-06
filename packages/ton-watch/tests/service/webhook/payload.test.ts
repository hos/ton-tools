import { describe, expect, test } from "bun:test";
import { Address, beginCell, Cell } from "@ton/core";

import { recordFromCell } from "../../../src/core/transaction";
import { deliveryId, webhookPayload } from "../../../src/service/webhook/payload";
import type { WebhookPayload } from "../../../src/webhook";
import { FakeChain, fakeAddress } from "../../fixtures/fake-chain";
import { expectGoldenJson } from "../../fixtures/golden";
import bouncedBack from "../../fixtures/parse/bounced-back.json";
import jettonNotification from "../../fixtures/parse/jetton-notification-comment.json";
import nftTransfer from "../../fixtures/parse/nft-transfer.json";
import receivedBounce from "../../fixtures/parse/received-bounce.json";
import tonTransfer from "../../fixtures/parse/ton-transfer-comment.json";

const A = fakeAddress(1);

function chainOf(count: number) {
  const chain = new FakeChain();
  chain.grow([A], count);
  return chain.txs(A);
}

/** A real mainnet transaction, as the store holds it. */
function mainnetTx(fixture: { address: string; boc: string }) {
  return recordFromCell(Cell.fromBase64(fixture.boc), Address.parse(fixture.address).toRawString());
}

describe("webhookPayload", () => {
  test("carries version, type, ids, hex hashes, the prev link and the BOC", () => {
    const [first, second] = chainOf(2);
    const payload = webhookPayload(second!, { webhook: "billing" });
    expect(payload).toMatchObject({
      version: 1,
      type: "transaction",
      id: `${A}:${second!.lt}:${second!.hash.toString("hex")}`,
      webhook: "billing",
      address: A,
      lt: second!.lt.toString(),
      hash: second!.hash.toString("hex"),
      utime: second!.utime,
      prev: { lt: first!.lt.toString(), hash: first!.hash.toString("hex") },
      boc: second!.boc.toString("base64"),
      replay: false,
    });
    expect(Object.keys(payload)).toEqual([
      "version",
      "type",
      "id",
      "webhook",
      "address",
      "lt",
      "hash",
      "utime",
      "prev",
      "boc",
      "parsed",
      "replay",
    ]);
    // Plain JSON: survives a round trip unchanged.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  test("an account's first transaction has no prev", () => {
    const [first] = chainOf(1);
    expect(webhookPayload(first!, { webhook: "w" }).prev).toBeNull();
  });

  test("replay: true marks a replayed dead letter", () => {
    const [first] = chainOf(1);
    expect(webhookPayload(first!, { webhook: "w", replay: true }).replay).toBe(true);
  });

  test("an unparsable BOC still delivers, with parsed null", () => {
    const [first] = chainOf(1);
    const broken = { ...first!, boc: beginCell().storeUint(1, 8).endCell().toBoc() };
    expect(webhookPayload(broken, { webhook: "w" }).parsed).toBeNull();
  });

  test("deliveryId is address:lt:hex hash", () => {
    const [first] = chainOf(1);
    expect(deliveryId(first!)).toBe(`${A}:${first!.lt}:${first!.hash.toString("hex")}`);
  });
});

describe("webhookPayload golden files (the v1 wire format)", () => {
  const cases = {
    "ton-transfer-comment": tonTransfer,
    "jetton-notification-comment": jettonNotification,
    "nft-transfer": nftTransfer,
    "bounced-back": bouncedBack,
    "received-bounce": receivedBounce,
  };
  for (const [name, fixture] of Object.entries(cases)) {
    test(name, () => {
      const tx = mainnetTx(fixture);
      const payload: WebhookPayload = webhookPayload(tx, { webhook: "default" });
      expect(payload.parsed).not.toBeNull();
      expect(payload.hash).toBe(fixture.hash);
      expectGoldenJson(`webhook-payload-${name}.json`, payload);
    });
  }

  test("bigints are decimal strings and hashes 64 hex digits, everywhere", () => {
    const text = JSON.stringify(webhookPayload(mainnetTx(nftTransfer), { webhook: "default" }));
    const numeric = new Set<string>();
    for (const [, key, value] of text.matchAll(/"(\w+)":(-?\d+(?:\.\d+)?)[,}\]]/g)) {
      numeric.add(key!);
      expect(Number.isSafeInteger(Number(value))).toBe(true);
    }
    // The only JSON numbers: the version, unix times, 32-bit opcodes, codes and counts.
    expect([...numeric].sort()).toEqual([
      "createdAt",
      "exitCode",
      "op",
      "resultCode",
      "skippedActions",
      "totalActions",
      "utime",
      "version",
    ]);
    for (const [, value] of text.matchAll(/"(?:hash|bodyHash)":"([^"]*)"/g)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
