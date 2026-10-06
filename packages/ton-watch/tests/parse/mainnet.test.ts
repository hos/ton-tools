/**
 * Real mainnet transactions captured once from toncenter (see each fixture's
 * `source`); the `toncenter` block holds toncenter's own decoding for comparison.
 */
import { describe, expect, test } from "bun:test";

import { Address, Cell, loadTransaction } from "@ton/core";

import { incomingJettonTransfer, incomingPayment } from "../../src/parse/deposits";
import { parseTransaction } from "../../src/parse/transaction";
import bouncedBack from "../fixtures/parse/bounced-back.json";
import jettonNotification from "../fixtures/parse/jetton-notification-comment.json";
import nftTransfer from "../fixtures/parse/nft-transfer.json";
import receivedBounce from "../fixtures/parse/received-bounce.json";
import tonTransfer from "../fixtures/parse/ton-transfer-comment.json";

interface Fixture {
  address: string;
  lt: string;
  hash: string;
  boc: string;
}

function load(fixture: Fixture) {
  const cell = Cell.fromBase64(fixture.boc);
  expect(cell.hash().toString("hex")).toBe(fixture.hash);
  return loadTransaction(cell.beginParse());
}

const addr = (raw: string) => Address.parse(raw);

describe("mainnet transactions", () => {
  test("TON transfer with a multi-line comment", () => {
    const tx = load(tonTransfer);
    const parsed = parseTransaction(tx);
    expect(parsed).toMatchObject({
      lt: BigInt(tonTransfer.lt),
      success: true,
      direction: "incoming",
      valueIn: 962_600_000n,
      totalFees: BigInt(tonTransfer.toncenter.total_fees),
    });
    expect(parsed.address?.equals(addr(tonTransfer.address))).toBe(true);
    const payment = incomingPayment(tx);
    expect(payment).toMatchObject({
      amount: 962_600_000n,
      comment: "100 Telegram Stars \n\nRef#Ukt0LZIJA",
      success: true,
    });
    expect(payment?.sender.equals(addr(tonTransfer.toncenter.in_msg.source))).toBe(true);
  });

  test("jetton transfer_notification with a comment and 1 nanoton attached", () => {
    const tx = load(jettonNotification);
    const parsed = parseTransaction(tx);
    // 1 nanoton buys no gas: compute skipped, transaction aborted. The jettons
    // were credited to the jetton wallet regardless.
    expect(parsed).toMatchObject({
      success: false,
      aborted: true,
      compute: { type: "skipped", reason: "no-gas" },
      inMessage: {
        op: 0x7362d09c,
        body: {
          kind: "jetton-transfer-notification",
          queryId: 0n,
          amount: 70_310_292n,
          forwardPayload: { kind: "text-comment", text: "Cross-chain swap withdrawal" },
        },
      },
    });
    const jettonWallet = addr(jettonNotification.toncenter.in_msg.source);
    const transfer = incomingJettonTransfer(tx, { jettonWallet });
    expect(transfer).toMatchObject({
      amount: 70_310_292n,
      comment: "Cross-chain swap withdrawal",
      tonAmount: 1n,
    });
    expect(transfer?.sender?.toRawString().toUpperCase()).toBe(
      `0:${jettonNotification.toncenter.in_msg_decoded.sender.address}`,
    );
    expect(incomingJettonTransfer(tx, { jettonWallet: addr(jettonNotification.address) })).toBe(
      null,
    );
  });

  test("NFT transfer received by the item", () => {
    const parsed = parseTransaction(load(nftTransfer));
    expect(parsed).toMatchObject({
      success: true,
      direction: "incoming",
      inMessage: {
        type: "internal",
        bounce: true,
        body: { kind: "nft-transfer", queryId: 0n },
      },
    });
    const body = parsed.inMessage?.body;
    if (body?.kind !== "nft-transfer") throw new Error("unreachable");
    const decoded = nftTransfer.toncenter.in_msg_decoded;
    expect(body.newOwner?.toRawString().toUpperCase()).toBe(`0:${decoded.new_owner.address}`);
    expect(body.forwardAmount).toBe(BigInt(decoded.forward_amount.value));
    // forward_amount is 0, so no ownership_assigned: only the excess is returned.
    expect(body.forwardAmount).toBe(0n);
    expect(parsed.outMessages.map((m) => m.body.kind)).toEqual(["excesses"]);
  });

  test("jetton transfer that failed and bounced the TON back", () => {
    const tx = load(bouncedBack);
    const parsed = parseTransaction(tx);
    expect(parsed).toMatchObject({
      success: false,
      aborted: true,
      bouncedBack: true,
      receivedBounce: false,
      compute: { type: "vm", success: false },
      inMessage: {
        bounce: true,
        body: {
          kind: "jetton-transfer",
          amount: 10_000_000_000_000n,
          forwardTonAmount: 250_000_000n,
        },
      },
    });
    expect(parsed.outMessages).toHaveLength(1);
    expect(parsed.outMessages[0]).toMatchObject({ bounced: true, body: { kind: "bounce" } });
    expect(incomingPayment(tx)).toBeNull();
  });

  test("bounced message returning to its sender", () => {
    const tx = load(receivedBounce);
    const parsed = parseTransaction(tx);
    expect(parsed).toMatchObject({
      success: true,
      receivedBounce: true,
      inMessage: {
        bounced: true,
        value: 299_763_732n,
        body: { kind: "bounce", format: "legacy", originalOp: 0x0f8a7ea5 },
      },
    });
    expect(incomingPayment(tx)).toBeNull();
  });
});
