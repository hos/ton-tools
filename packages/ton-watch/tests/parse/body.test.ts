import { describe, expect, test } from "bun:test";

import { Address, beginCell, type Cell, ExternalAddress } from "@ton/core";

import { parseMessageBody } from "../../src/parse/body";
import { Op } from "../../src/parse/opcodes";
import { ACCOUNT, OTHER, snakeCell, THIRD, textComment } from "./helpers";

const QUERY_ID = 0x1122334455667788n;

function jettonTransfer(payload?: (b: ReturnType<typeof beginCell>) => void): Cell {
  const b = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(QUERY_ID, 64)
    .storeCoins(1_000_000n)
    .storeAddress(OTHER)
    .storeAddress(THIRD)
    .storeMaybeRef(beginCell().storeUint(7, 8).endCell())
    .storeCoins(50_000_000n);
  if (payload) payload(b);
  else b.storeBit(0);
  return b.endCell();
}

function notification(payload: (b: ReturnType<typeof beginCell>) => void): Cell {
  const b = beginCell()
    .storeUint(0x7362d09c, 32)
    .storeUint(QUERY_ID, 64)
    .storeCoins(42n)
    .storeAddress(OTHER);
  payload(b);
  return b.endCell();
}

describe("opcodes match TEP-74 / TEP-62", () => {
  test("values", () => {
    expect(Op.jettonTransfer).toBe(0x0f8a7ea5);
    expect(Op.jettonTransferNotification).toBe(0x7362d09c);
    expect(Op.jettonInternalTransfer).toBe(0x178d4519);
    expect(Op.excesses).toBe(0xd53276db);
    expect(Op.jettonBurn).toBe(0x595f07bc);
    expect(Op.nftTransfer).toBe(0x5fcc3d14);
    expect(Op.nftOwnershipAssigned).toBe(0x05138d91);
    expect(Op.encryptedComment).toBe(0x2167da4b);
  });
});

describe("empty and short bodies", () => {
  test("missing or empty body", () => {
    expect(parseMessageBody(undefined)).toEqual({ kind: "empty" });
    expect(parseMessageBody(null)).toEqual({ kind: "empty" });
    expect(parseMessageBody(beginCell().endCell())).toEqual({ kind: "empty" });
  });

  test("body shorter than an opcode is malformed", () => {
    const body = parseMessageBody(beginCell().storeUint(5, 16).endCell());
    expect(body).toMatchObject({ kind: "malformed", op: null });
  });

  test("refs without bits are malformed, not empty", () => {
    const body = parseMessageBody(beginCell().storeRef(textComment("x")).endCell());
    expect(body.kind).toBe("malformed");
  });

  test("unknown opcode", () => {
    const body = parseMessageBody(beginCell().storeUint(0xdeadbeef, 32).storeUint(1, 64).endCell());
    expect(body).toEqual({ kind: "unknown", op: 0xdeadbeef });
  });
});

describe("comments", () => {
  test("short text comment", () => {
    expect(parseMessageBody(textComment("hello"))).toEqual({ kind: "text-comment", text: "hello" });
  });

  test("op 0 with no text is an empty comment", () => {
    expect(parseMessageBody(beginCell().storeUint(0, 32).endCell())).toEqual({
      kind: "text-comment",
      text: "",
    });
  });

  test("long snake comment built by @ton/core", () => {
    const text = "payment #42 — ".repeat(60);
    const cell = textComment(text);
    expect(cell.refs.length).toBe(1);
    expect(parseMessageBody(cell)).toEqual({ kind: "text-comment", text });
  });

  test("hand-built snake splits a multi-byte character across cells", () => {
    const text = "привет мир ".repeat(30);
    const cell = snakeCell((b) => b.storeUint(0, 32), Buffer.from(text, "utf8"), 31);
    expect(parseMessageBody(cell)).toEqual({ kind: "text-comment", text });
  });

  test("binary comment", () => {
    const cell = beginCell()
      .storeUint(0, 32)
      .storeUint(0xff, 8)
      .storeBuffer(Buffer.from([1, 2, 3]));
    expect(parseMessageBody(cell.endCell())).toEqual({
      kind: "binary-comment",
      data: Buffer.from([1, 2, 3]),
    });
  });

  test("encrypted comment (snake cipher text)", () => {
    const cipher = Buffer.alloc(300, 0xab);
    const cell = snakeCell((b) => b.storeUint(0x2167da4b, 32), cipher, 100);
    expect(parseMessageBody(cell)).toEqual({ kind: "encrypted-comment", data: cipher });
  });

  test("invalid UTF-8 is malformed", () => {
    const cell = beginCell()
      .storeUint(0, 32)
      .storeBuffer(Buffer.from([0xc3, 0x28]))
      .endCell();
    expect(parseMessageBody(cell)).toMatchObject({ kind: "malformed", op: 0 });
  });

  test("bits not aligned to bytes are malformed", () => {
    const cell = beginCell().storeUint(0, 32).storeUint(0x61, 8).storeBit(1).endCell();
    expect(parseMessageBody(cell)).toMatchObject({
      kind: "malformed",
      op: 0,
      reason: "snake data is not byte-aligned",
    });
  });
});

describe("jetton bodies", () => {
  test("transfer with every field", () => {
    const body = parseMessageBody(jettonTransfer());
    expect(body).toMatchObject({
      kind: "jetton-transfer",
      queryId: QUERY_ID,
      amount: 1_000_000n,
      forwardTonAmount: 50_000_000n,
      forwardPayload: { kind: "empty" },
    });
    if (body.kind !== "jetton-transfer") throw new Error("unreachable");
    expect(body.destination?.equals(OTHER)).toBe(true);
    expect(body.responseDestination?.equals(THIRD)).toBe(true);
    expect(body.customPayload?.beginParse().loadUint(8)).toBe(7);
  });

  test("transfer with addr_none response destination and no custom payload", () => {
    const cell = beginCell()
      .storeUint(Op.jettonTransfer, 32)
      .storeUint(1, 64)
      .storeCoins(5n)
      .storeAddress(OTHER)
      .storeAddress(null)
      .storeBit(0)
      .storeCoins(0n)
      .storeBit(0)
      .endCell();
    expect(parseMessageBody(cell)).toMatchObject({
      kind: "jetton-transfer",
      responseDestination: null,
      customPayload: null,
    });
  });

  test("transfer_notification with inline text comment", () => {
    const cell = notification((b) => b.storeBit(0).storeUint(0, 32).storeStringTail("order 17"));
    const body = parseMessageBody(cell);
    expect(body).toMatchObject({
      kind: "jetton-transfer-notification",
      queryId: QUERY_ID,
      amount: 42n,
      forwardPayload: { kind: "text-comment", text: "order 17" },
    });
  });

  test("transfer_notification with comment in a ref", () => {
    const cell = notification((b) => b.storeBit(1).storeRef(textComment("in a ref")));
    expect(parseMessageBody(cell)).toMatchObject({
      forwardPayload: { kind: "text-comment", text: "in a ref" },
    });
  });

  test("transfer_notification with an opaque payload", () => {
    const payload = beginCell().storeUint(0x12345678, 32).storeUint(9, 16).endCell();
    const cell = notification((b) => b.storeBit(1).storeRef(payload));
    const body = parseMessageBody(cell);
    expect(body).toMatchObject({ forwardPayload: { kind: "opaque", op: 0x12345678 } });
    if (body.kind !== "jetton-transfer-notification") throw new Error("unreachable");
    if (body.forwardPayload.kind !== "opaque") throw new Error("unreachable");
    expect(body.forwardPayload.cell.equals(payload)).toBe(true);
  });

  test("transfer_notification without the Either bit has an empty payload", () => {
    expect(parseMessageBody(notification(() => {}))).toMatchObject({
      kind: "jetton-transfer-notification",
      forwardPayload: { kind: "empty" },
    });
  });

  test("forward payload marked as ref but missing it is malformed", () => {
    const body = parseMessageBody(notification((b) => b.storeBit(1)));
    expect(body).toMatchObject({ kind: "malformed", op: Op.jettonTransferNotification });
  });

  test("bad comment inside the payload keeps the notification", () => {
    const bad = beginCell()
      .storeUint(0, 32)
      .storeBuffer(Buffer.from([0xff, 0xfe]));
    const cell = notification((b) =>
      b.storeBit(1).storeRef(beginCell().storeUint(0, 32).storeBit(1)),
    );
    expect(parseMessageBody(cell)).toMatchObject({
      kind: "jetton-transfer-notification",
      forwardPayload: { kind: "malformed", op: 0 },
    });
    // 0xff after op 0 is a binary comment, not bad UTF-8.
    const binary = notification((b) => b.storeBit(1).storeRef(bad.endCell()));
    expect(parseMessageBody(binary)).toMatchObject({
      forwardPayload: { kind: "binary-comment", data: Buffer.from([0xfe]) },
    });
  });

  test("internal_transfer", () => {
    const cell = beginCell()
      .storeUint(0x178d4519, 32)
      .storeUint(3, 64)
      .storeCoins(77n)
      .storeAddress(OTHER)
      .storeAddress(ACCOUNT)
      .storeCoins(1n)
      .storeBit(0)
      .endCell();
    const body = parseMessageBody(cell);
    expect(body).toMatchObject({
      kind: "jetton-internal-transfer",
      queryId: 3n,
      amount: 77n,
      forwardTonAmount: 1n,
      forwardPayload: { kind: "empty" },
    });
    if (body.kind !== "jetton-internal-transfer") throw new Error("unreachable");
    expect(body.from?.equals(OTHER)).toBe(true);
    expect(body.responseAddress?.equals(ACCOUNT)).toBe(true);
  });

  test("excesses", () => {
    const cell = beginCell().storeUint(0xd53276db, 32).storeUint(9, 64).endCell();
    expect(parseMessageBody(cell)).toEqual({ kind: "excesses", queryId: 9n });
  });

  test("burn", () => {
    const cell = beginCell()
      .storeUint(0x595f07bc, 32)
      .storeUint(4, 64)
      .storeCoins(1000n)
      .storeAddress(OTHER)
      .storeBit(0)
      .endCell();
    expect(parseMessageBody(cell)).toMatchObject({
      kind: "jetton-burn",
      queryId: 4n,
      amount: 1000n,
      customPayload: null,
    });
  });

  test("external address in an address field is malformed", () => {
    const cell = beginCell()
      .storeUint(Op.jettonTransferNotification, 32)
      .storeUint(1, 64)
      .storeCoins(1n)
      .storeAddress(new ExternalAddress(1n, 8))
      .storeBit(0)
      .endCell();
    expect(parseMessageBody(cell)).toMatchObject({
      kind: "malformed",
      reason: "unexpected external address",
    });
  });

  test("every truncation of a transfer is malformed, never a throw", () => {
    const full = jettonTransfer((b) => b.storeBit(1).storeRef(textComment("x")));
    const bits = full.bits.length;
    for (let keep = 32; keep < bits; keep++) {
      const truncated = beginCell().storeBits(full.bits.substring(0, keep)).endCell();
      const body = parseMessageBody(truncated);
      expect(body).toMatchObject({ kind: "malformed", op: Op.jettonTransfer });
    }
  });
});

describe("NFT bodies", () => {
  test("transfer", () => {
    const cell = beginCell()
      .storeUint(0x5fcc3d14, 32)
      .storeUint(11, 64)
      .storeAddress(OTHER)
      .storeAddress(ACCOUNT)
      .storeBit(0)
      .storeCoins(10_000_000n)
      .storeBit(0)
      .storeUint(0, 32)
      .storeStringTail("gift")
      .endCell();
    const body = parseMessageBody(cell);
    expect(body).toMatchObject({
      kind: "nft-transfer",
      queryId: 11n,
      customPayload: null,
      forwardAmount: 10_000_000n,
      forwardPayload: { kind: "text-comment", text: "gift" },
    });
    if (body.kind !== "nft-transfer") throw new Error("unreachable");
    expect(body.newOwner?.equals(OTHER)).toBe(true);
  });

  test("ownership_assigned", () => {
    const cell = beginCell()
      .storeUint(0x05138d91, 32)
      .storeUint(11, 64)
      .storeAddress(THIRD)
      .storeBit(0)
      .endCell();
    const body = parseMessageBody(cell);
    expect(body).toMatchObject({ kind: "nft-ownership-assigned", queryId: 11n });
    if (body.kind !== "nft-ownership-assigned") throw new Error("unreachable");
    expect(body.prevOwner?.equals(THIRD)).toBe(true);
  });
});

describe("bounces", () => {
  test("legacy bounce reports the original opcode and query id", () => {
    const original = jettonTransfer();
    const cell = beginCell()
      .storeUint(0xffffffff, 32)
      .storeBits(original.bits.substring(0, 256))
      .endCell();
    const body = parseMessageBody(cell, { bounced: true });
    expect(body).toMatchObject({
      kind: "bounce",
      format: "legacy",
      originalOp: Op.jettonTransfer,
      originalQueryId: QUERY_ID,
    });
  });

  test("legacy bounce of an empty body", () => {
    const cell = beginCell().storeUint(0xffffffff, 32).endCell();
    expect(parseMessageBody(cell, { bounced: true })).toMatchObject({
      kind: "bounce",
      originalOp: null,
      originalQueryId: null,
    });
  });

  test("bounce prefix on a non-bounced message is just an unknown opcode", () => {
    const cell = beginCell().storeUint(0xffffffff, 32).endCell();
    expect(parseMessageBody(cell)).toEqual({ kind: "unknown", op: 0xffffffff });
  });

  test("new bounce format", () => {
    const original = textComment("hi");
    const info = beginCell()
      .storeCoins(5_000n)
      .storeBit(0) // no extra currencies
      .storeUint(123n, 64)
      .storeUint(1_700_000_000, 32)
      .endCell();
    const cell = beginCell()
      .storeUint(0xfffffffe, 32)
      .storeRef(original)
      .storeRef(info)
      .storeUint(1, 8)
      .storeInt(-14, 32)
      .storeBit(1)
      .storeUint(900, 32)
      .storeUint(55, 32)
      .endCell();
    const body = parseMessageBody(cell, { bounced: true });
    expect(body).toMatchObject({
      kind: "bounce",
      format: "new",
      originalOp: 0,
      originalValue: 5_000n,
      originalCreatedLt: 123n,
      originalCreatedAt: 1_700_000_000,
      bouncedBy: "compute-failed",
      exitCode: -14,
      compute: { gasUsed: 900, vmSteps: 55 },
    });
  });

  test("new bounce with a missing ref is malformed", () => {
    const cell = beginCell().storeUint(0xfffffffe, 32).storeRef(textComment("x")).endCell();
    expect(parseMessageBody(cell, { bounced: true })).toMatchObject({
      kind: "malformed",
      op: 0xfffffffe,
    });
  });
});

test("addresses decode to @ton/core Address instances", () => {
  const body = parseMessageBody(jettonTransfer());
  if (body.kind !== "jetton-transfer") throw new Error("unreachable");
  expect(Address.isAddress(body.destination)).toBe(true);
});
