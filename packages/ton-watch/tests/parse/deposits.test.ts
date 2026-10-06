import { describe, expect, test } from "bun:test";

import { beginCell, Dictionary } from "@ton/core";

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

  test("extra currencies are reported apart from the TON amount", () => {
    const extra = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.BigVarUint(5));
    extra.set(7, 123n);
    const { tx } = buildTx({
      inMessage: internalMessage({ value: 5n, extraCurrencies: extra }),
    });
    const payment = incomingPayment(tx);
    expect(payment?.amount).toBe(5n);
    expect(payment?.extraCurrencies).toEqual(new Map([[7, 123n]]));
    expect(incomingPayment(buildTx({ inMessage: internalMessage() }).tx)?.extraCurrencies).toEqual(
      new Map(),
    );
  });

  test("throws on a record whose BOC is not a transaction", () => {
    const { record } = buildTx({ inMessage: internalMessage() });
    expect(() => incomingPayment({ ...record, boc: beginCell().endCell().toBoc() })).toThrow();
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

  test("decodes the notification from the trusted jetton wallet", () => {
    const { tx } = buildTx({ inMessage: internalMessage({ value: 1n, body: notification }) });
    const transfer = incomingJettonTransfer(tx, { jettonWallet: OTHER });
    expect(transfer).toMatchObject({
      amount: 1_000_000n,
      queryId: 5n,
      tonAmount: 1n,
      comment: "invoice 9",
    });
    expect(transfer?.jettonWallet.equals(OTHER)).toBe(true);
    expect(transfer?.sender?.equals(THIRD)).toBe(true);
  });

  test("jettonWallet rejects notifications from anyone else, in every accepted form", () => {
    const { tx } = buildTx({ inMessage: internalMessage({ body: notification }) });
    for (const jettonWallet of [OTHER, OTHER.toString(), OTHER.toRawString()]) {
      expect(incomingJettonTransfer(tx, { jettonWallet })).not.toBeNull();
    }
    expect(incomingJettonTransfer(tx, { jettonWallet: [THIRD, OTHER.toString()] })).not.toBeNull();
    expect(incomingJettonTransfer(tx, { jettonWallet: new Set([OTHER]) })).not.toBeNull();
    expect(incomingJettonTransfer(tx, { jettonWallet: THIRD.toString() })).toBeNull();
    expect(incomingJettonTransfer(tx, { jettonWallet: [THIRD] })).toBeNull();
    expect(incomingJettonTransfer(tx, { jettonWallet: [] })).toBeNull();
  });

  test("a spoofed notification is not accepted unless trustAnySender opts in", () => {
    const { tx } = buildTx({ inMessage: internalMessage({ body: notification }) });
    // Calls from JavaScript, or with the types bypassed, must not fall back to trusting anyone.
    expect(() => incomingJettonTransfer(tx, undefined as never)).toThrow(
      "jettonWallet is required",
    );
    expect(() => incomingJettonTransfer(tx, {} as never)).toThrow("jettonWallet is required");
    expect(() =>
      incomingJettonTransfer(tx, { jettonWallet: OTHER, trustAnySender: true } as never),
    ).toThrow("not both");
    expect(incomingJettonTransfer(tx, { trustAnySender: true })?.jettonWallet.equals(OTHER)).toBe(
      true,
    );
  });

  test("throws on a jettonWallet that is not an address", () => {
    const { tx } = buildTx({ inMessage: internalMessage({ body: notification }) });
    expect(() => incomingJettonTransfer(tx, { jettonWallet: "not-an-address" })).toThrow();
  });

  test("a malformed forward payload still yields the credited transfer", () => {
    const head = () =>
      beginCell().storeUint(0x7362d09c, 32).storeUint(5, 64).storeCoins(7n).storeAddress(THIRD);
    // Either bit set without the ref; and a ref without the Either bit.
    for (const body of [
      head().storeBit(1).endCell(),
      head().storeRef(textComment("x")).endCell(),
    ]) {
      const { tx } = buildTx({ inMessage: internalMessage({ body }) });
      const transfer = incomingJettonTransfer(tx, { jettonWallet: OTHER });
      expect(transfer).toMatchObject({
        amount: 7n,
        comment: null,
        forwardPayload: { kind: "malformed" },
      });
      expect(transfer?.sender?.equals(THIRD)).toBe(true);
    }
  });

  test("other bodies and bounced messages yield null", () => {
    const options = { jettonWallet: OTHER };
    expect(
      incomingJettonTransfer(buildTx({ inMessage: internalMessage() }).tx, options),
    ).toBeNull();
    const bounced = buildTx({ inMessage: internalMessage({ bounced: true, body: notification }) });
    expect(incomingJettonTransfer(bounced.tx, options)).toBeNull();
  });
});
