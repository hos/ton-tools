import { describe, expect, test } from "bun:test";

import { beginCell } from "@ton/core";

import { incomingJettonTransfer, incomingPayment } from "../../src/parse/deposits";
import {
  ACCOUNT,
  buildTx,
  externalInMessage,
  generic,
  internalMessage,
  OTHER,
  THIRD,
  textComment,
  vmPhase,
} from "./helpers";

const BOUNCE_OK = {
  type: "ok" as const,
  messageSize: { cells: 1n, bits: 10n },
  messageFees: 1n,
  forwardFees: 2n,
};

describe("incomingPayment", () => {
  test("plain transfer with a comment", () => {
    const { record } = buildTx({
      inMessage: internalMessage({ value: 2_500_000_000n, body: textComment("user-17") }),
    });
    const payment = incomingPayment(record);
    expect(payment).toMatchObject({ amount: 2_500_000_000n, comment: "user-17", success: true });
    expect(payment?.sender.equals(OTHER)).toBe(true);
  });

  test("encrypted memo is exposed through body", () => {
    const body = beginCell().storeUint(0x2167da4b, 32).storeBuffer(Buffer.alloc(8, 1)).endCell();
    const { tx } = buildTx({ inMessage: internalMessage({ body }) });
    expect(incomingPayment(tx)).toMatchObject({
      comment: null,
      body: { kind: "encrypted-comment" },
    });
  });

  test("value bounced back by a failed transaction is not a payment", () => {
    const { tx } = buildTx({
      inMessage: internalMessage({ bounce: true, body: textComment("user-17") }),
      description: generic({
        computePhase: vmPhase(false, 100),
        actionPhase: undefined,
        aborted: true,
        bouncePhase: BOUNCE_OK,
      }),
    });
    expect(incomingPayment(tx)).toBeNull();
  });

  test("a bounced message returning our own funds is not a payment", () => {
    const body = beginCell().storeUint(0xffffffff, 32).endCell();
    const { tx } = buildTx({ inMessage: internalMessage({ bounced: true, body }) });
    expect(incomingPayment(tx)).toBeNull();
  });

  test("non-bounceable deposit to an undeployed wallet is kept (success: false)", () => {
    const { tx } = buildTx({
      inMessage: internalMessage({ value: 10n }),
      description: generic({
        computePhase: { type: "skipped", reason: "no-state" },
        actionPhase: undefined,
        aborted: true,
      }),
    });
    expect(incomingPayment(tx)).toMatchObject({ amount: 10n, success: false });
  });

  test("not a payment: external, self, zero value, no credit phase", () => {
    expect(incomingPayment(buildTx({ inMessage: externalInMessage() }).tx)).toBeNull();
    expect(
      incomingPayment(buildTx({ inMessage: internalMessage({ src: ACCOUNT }) }).tx),
    ).toBeNull();
    expect(incomingPayment(buildTx({ inMessage: internalMessage({ value: 0n }) }).tx)).toBeNull();
    const noCredit = buildTx({
      inMessage: internalMessage(),
      description: generic({ creditPhase: undefined }),
    });
    expect(incomingPayment(noCredit.tx)).toBeNull();
  });
});

describe("incomingJettonTransfer", () => {
  const notification = beginCell()
    .storeUint(0x7362d09c, 32)
    .storeUint(5, 64)
    .storeCoins(1_000_000n)
    .storeAddress(THIRD)
    .storeBit(1)
    .storeRef(textComment("invoice 9"))
    .endCell();

  test("decodes the notification", () => {
    const { tx } = buildTx({ inMessage: internalMessage({ value: 1n, body: notification }) });
    const transfer = incomingJettonTransfer(tx);
    expect(transfer).toMatchObject({
      amount: 1_000_000n,
      queryId: 5n,
      tonAmount: 1n,
      comment: "invoice 9",
    });
    expect(transfer?.jettonWallet.equals(OTHER)).toBe(true);
    expect(transfer?.sender?.equals(THIRD)).toBe(true);
  });

  test("jettonWallet option rejects notifications from anyone else", () => {
    const { tx } = buildTx({ inMessage: internalMessage({ body: notification }) });
    expect(incomingJettonTransfer(tx, { jettonWallet: OTHER })).not.toBeNull();
    expect(incomingJettonTransfer(tx, { jettonWallet: THIRD.toString() })).toBeNull();
  });

  test("other bodies and bounced messages yield null", () => {
    expect(incomingJettonTransfer(buildTx({ inMessage: internalMessage() }).tx)).toBeNull();
    const bounced = buildTx({ inMessage: internalMessage({ bounced: true, body: notification }) });
    expect(incomingJettonTransfer(bounced.tx)).toBeNull();
  });
});
