import { describe, expect, test } from "bun:test";

import { Address, beginCell, Dictionary } from "@ton/core";

import { toIndexedTx } from "../../src/core/types";
import { parseMessage } from "../../src/parse/message";
import { parseTransaction } from "../../src/parse/transaction";
import {
  ACCOUNT,
  actionPhase,
  buildTx,
  externalInMessage,
  externalOutMessage,
  generic,
  internalMessage,
  OTHER,
  THIRD,
  textComment,
  vmPhase,
} from "./helpers";

describe("parseMessage", () => {
  test("internal message fields", () => {
    const extra = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.BigVarUint(5));
    extra.set(7, 99n);
    const message = parseMessage(
      internalMessage({
        value: 5n,
        bounce: true,
        body: textComment("memo"),
        extraCurrencies: extra,
      }),
    );
    expect(message).toMatchObject({
      type: "internal",
      value: 5n,
      bounce: true,
      bounced: false,
      fwdFee: 1_000n,
      extraFlags: 0n,
      createdLt: 100n,
      op: 0,
      queryId: null,
      comment: "memo",
      body: { kind: "text-comment", text: "memo" },
    });
    if (message.type !== "internal") throw new Error("unreachable");
    expect(message.src.equals(OTHER)).toBe(true);
    expect(message.extraCurrencies).toEqual(new Map([[7, 99n]]));
  });

  test("query id comes from the decoded body", () => {
    const body = beginCell().storeUint(0xd53276db, 32).storeUint(77, 64).endCell();
    expect(parseMessage(internalMessage({ body }))).toMatchObject({ op: 0xd53276db, queryId: 77n });
  });

  test("external messages", () => {
    expect(parseMessage(externalInMessage())).toMatchObject({
      type: "external-in",
      src: null,
      importFee: 0n,
      op: null,
      body: { kind: "empty" },
    });
    expect(parseMessage(externalOutMessage(textComment("log")))).toMatchObject({
      type: "external-out",
      comment: "log",
    });
  });
});

describe("parseTransaction", () => {
  test("successful incoming transfer", () => {
    const { tx } = buildTx({
      inMessage: internalMessage({ value: 3_000_000_000n, body: textComment("hi") }),
      outMessages: [
        internalMessage({ src: ACCOUNT, dest: THIRD, value: 100n }),
        externalOutMessage(),
      ],
    });
    const parsed = parseTransaction(tx);
    expect(parsed).toMatchObject({
      lt: 2_000n,
      utime: 1_700_000_100,
      type: "generic",
      success: true,
      aborted: false,
      compute: { type: "vm", success: true, exitCode: 0, gasUsed: 500n },
      action: { success: true, resultCode: 0 },
      receivedBounce: false,
      bouncedBack: false,
      direction: "incoming",
      totalFees: 12_345n,
      valueIn: 3_000_000_000n,
      valueOut: 100n,
    });
    expect(parsed.address?.equals(ACCOUNT)).toBe(true);
    expect(parsed.hash.equals(tx.hash())).toBe(true);
    expect(parsed.inMessage?.comment).toBe("hi");
    expect(parsed.outMessages.map((m) => m.type)).toEqual(["internal", "external-out"]);
  });

  test("failed compute phase that bounced the value back", () => {
    const { tx } = buildTx({
      inMessage: internalMessage({ bounce: true }),
      description: generic({
        computePhase: vmPhase(false, 37),
        actionPhase: undefined,
        aborted: true,
        bouncePhase: {
          type: "ok",
          messageSize: { cells: 1n, bits: 10n },
          messageFees: 1n,
          forwardFees: 2n,
        },
      }),
      outMessages: [internalMessage({ src: ACCOUNT, dest: OTHER, bounced: true })],
    });
    const parsed = parseTransaction(tx);
    expect(parsed).toMatchObject({
      success: false,
      aborted: true,
      compute: { type: "vm", success: false, exitCode: 37 },
      action: null,
      bouncedBack: true,
      receivedBounce: false,
    });
    expect(parsed.outMessages[0]).toMatchObject({ bounced: true });
  });

  test("skipped compute phase (no state)", () => {
    const { tx } = buildTx({
      inMessage: internalMessage(),
      description: generic({
        computePhase: { type: "skipped", reason: "no-state" },
        actionPhase: undefined,
        aborted: true,
      }),
    });
    expect(parseTransaction(tx)).toMatchObject({
      success: false,
      aborted: true,
      compute: { type: "skipped", reason: "no-state" },
      bouncedBack: false,
    });
  });

  test("failed action phase", () => {
    const { tx } = buildTx({
      inMessage: externalInMessage(),
      description: generic({ actionPhase: actionPhase(false, 37), aborted: true }),
    });
    expect(parseTransaction(tx)).toMatchObject({
      success: false,
      action: { success: false, resultCode: 37 },
      direction: "outgoing",
    });
  });

  test("received bounce", () => {
    const body = beginCell().storeUint(0xffffffff, 32).storeUint(0x0f8a7ea5, 32).endCell();
    const { tx } = buildTx({ inMessage: internalMessage({ bounced: true, body }) });
    expect(parseTransaction(tx)).toMatchObject({
      receivedBounce: true,
      bouncedBack: false,
      inMessage: { body: { kind: "bounce", format: "legacy", originalOp: 0x0f8a7ea5 } },
    });
  });

  test("external-in triggered transaction is outgoing", () => {
    const { tx } = buildTx({
      inMessage: externalInMessage(beginCell().storeUint(1, 32).endCell()),
      outMessages: [internalMessage({ src: ACCOUNT, dest: OTHER, value: 7n })],
    });
    expect(parseTransaction(tx)).toMatchObject({
      direction: "outgoing",
      valueIn: 0n,
      valueOut: 7n,
      inMessage: { type: "external-in", body: { kind: "unknown", op: 1 } },
    });
  });

  test("message to self", () => {
    const { tx } = buildTx({ inMessage: internalMessage({ src: ACCOUNT }) });
    expect(parseTransaction(tx).direction).toBe("self");
  });

  test("no inbound message", () => {
    const { tx } = buildTx({
      description: {
        type: "storage",
        storagePhase: { storageFeesCollected: 1n, statusChange: "unchanged" },
      },
    });
    expect(parseTransaction(tx)).toMatchObject({
      address: null,
      direction: "system",
      type: "storage",
      success: true,
      compute: null,
      inMessage: null,
    });
  });

  test("accepts a TxRecord and an IndexedTx", () => {
    const { tx, record } = buildTx({ inMessage: internalMessage({ body: textComment("r") }) });
    for (const input of [record, toIndexedTx(record)]) {
      const parsed = parseTransaction(input);
      expect(parsed.hash.equals(record.hash)).toBe(true);
      expect(parsed.hash.equals(tx.hash())).toBe(true);
      expect(parsed.address?.equals(ACCOUNT)).toBe(true);
      expect(parsed.inMessage?.comment).toBe("r");
    }
  });

  test("address option is checked against the transaction", () => {
    const { tx } = buildTx({ inMessage: internalMessage() });
    expect(parseTransaction(tx, { address: ACCOUNT.toString() }).address?.equals(ACCOUNT)).toBe(
      true,
    );
    expect(() => parseTransaction(tx, { address: OTHER })).toThrow("not the transaction's account");
  });

  test("address option with the right hash but another workchain is rejected", () => {
    const masterchain = new Address(-1, ACCOUNT.hash);
    const { tx, record } = buildTx({ inMessage: internalMessage() });
    for (const input of [tx, record]) {
      expect(() => parseTransaction(input, { address: masterchain })).toThrow(
        "not the transaction's account",
      );
    }
  });
});
