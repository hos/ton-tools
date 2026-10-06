import type { Address, Cell, ExternalAddress } from "@ton/core";

import type { TxRecord } from "../../core/types";
import { parseTransaction } from "../../parse";
import type {
  Comment,
  ForwardPayload,
  Malformed,
  MessageBody,
  ParsedMessage,
  ParsedTransaction,
} from "../../parse/types";
import {
  type CommentJson,
  type ExternalAddressJson,
  type ForwardPayloadJson,
  type MalformedJson,
  type MessageBodyJson,
  type MessageJson,
  type TransactionJson,
  WEBHOOK_PAYLOAD_VERSION,
  type WebhookPayload,
} from "../../webhook/types";

export interface PayloadOptions {
  /** Name of the target. */
  webhook: string;
  /** A dead letter being replayed. Default false. */
  replay?: boolean;
}

/** Idempotency key of a transaction: stable across retries and restarts. */
export function deliveryId(tx: TxRecord): string {
  return `${tx.address}:${tx.lt}:${tx.hash.toString("hex")}`;
}

/** The request body for `tx`. Every field is mapped explicitly: see `webhook/types.ts`. */
export function webhookPayload(
  tx: TxRecord,
  { webhook, replay = false }: PayloadOptions,
): WebhookPayload {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    type: "transaction",
    id: deliveryId(tx),
    webhook,
    address: tx.address,
    lt: tx.lt.toString(),
    hash: tx.hash.toString("hex"),
    utime: tx.utime,
    prev: tx.prevLt === 0n ? null : { lt: tx.prevLt.toString(), hash: tx.prevHash.toString("hex") },
    boc: tx.boc.toString("base64"),
    parsed: parsedJson(tx),
    replay,
  };
}

function parsedJson(tx: TxRecord): TransactionJson | null {
  let parsed: ParsedTransaction;
  try {
    parsed = parseTransaction(tx);
  } catch {
    return null;
  }
  return transactionJson(parsed);
}

export function transactionJson(tx: ParsedTransaction): TransactionJson {
  return {
    type: tx.type,
    success: tx.success,
    aborted: tx.aborted,
    compute:
      tx.compute === null
        ? null
        : tx.compute.type === "skipped"
          ? { type: "skipped", reason: tx.compute.reason }
          : {
              type: "vm",
              success: tx.compute.success,
              exitCode: tx.compute.exitCode,
              gasUsed: tx.compute.gasUsed.toString(),
            },
    action:
      tx.action === null
        ? null
        : {
            success: tx.action.success,
            resultCode: tx.action.resultCode,
            totalActions: tx.action.totalActions,
            skippedActions: tx.action.skippedActions,
          },
    receivedBounce: tx.receivedBounce,
    bouncedBack: tx.bouncedBack,
    direction: tx.direction,
    inMessage: tx.inMessage === null ? null : messageJson(tx.inMessage),
    outMessages: tx.outMessages.map(messageJson),
    totalFees: tx.totalFees.toString(),
    valueIn: tx.valueIn.toString(),
    valueOut: tx.valueOut.toString(),
  };
}

function messageJson(message: ParsedMessage): MessageJson {
  const base = {
    op: message.op,
    queryId: optionalDecimal(message.queryId),
    comment: message.comment,
    body: bodyJson(message.body),
  };
  switch (message.type) {
    case "internal":
      return {
        type: "internal",
        src: message.src.toRawString(),
        dest: message.dest.toRawString(),
        value: message.value.toString(),
        extraCurrencies: Object.fromEntries(
          [...message.extraCurrencies].map(([id, amount]) => [String(id), amount.toString()]),
        ),
        bounce: message.bounce,
        bounced: message.bounced,
        fwdFee: message.fwdFee.toString(),
        extraFlags: message.extraFlags.toString(),
        createdLt: message.createdLt.toString(),
        createdAt: message.createdAt,
        ...base,
      };
    case "external-in":
      return {
        type: "external-in",
        src: externalJson(message.src),
        dest: message.dest.toRawString(),
        importFee: message.importFee.toString(),
        ...base,
      };
    case "external-out":
      return {
        type: "external-out",
        src: message.src.toRawString(),
        dest: externalJson(message.dest),
        createdLt: message.createdLt.toString(),
        createdAt: message.createdAt,
        ...base,
      };
  }
}

function bodyJson(body: MessageBody): MessageBodyJson {
  switch (body.kind) {
    case "empty":
      return { kind: "empty" };
    case "text-comment":
    case "binary-comment":
    case "encrypted-comment":
    case "malformed":
      return commentJson(body);
    case "jetton-transfer":
      return {
        kind: body.kind,
        queryId: body.queryId.toString(),
        amount: body.amount.toString(),
        destination: optionalAddress(body.destination),
        responseDestination: optionalAddress(body.responseDestination),
        customPayload: optionalBoc(body.customPayload),
        forwardTonAmount: body.forwardTonAmount.toString(),
        forwardPayload: forwardPayloadJson(body.forwardPayload),
      };
    case "jetton-transfer-notification":
      return {
        kind: body.kind,
        queryId: body.queryId.toString(),
        amount: body.amount.toString(),
        sender: optionalAddress(body.sender),
        forwardPayload: forwardPayloadJson(body.forwardPayload),
      };
    case "jetton-internal-transfer":
      return {
        kind: body.kind,
        queryId: body.queryId.toString(),
        amount: body.amount.toString(),
        from: optionalAddress(body.from),
        responseAddress: optionalAddress(body.responseAddress),
        forwardTonAmount: body.forwardTonAmount.toString(),
        forwardPayload: forwardPayloadJson(body.forwardPayload),
      };
    case "excesses":
      return { kind: body.kind, queryId: body.queryId.toString() };
    case "jetton-burn":
      return {
        kind: body.kind,
        queryId: body.queryId.toString(),
        amount: body.amount.toString(),
        responseDestination: optionalAddress(body.responseDestination),
        customPayload: optionalBoc(body.customPayload),
      };
    case "nft-transfer":
      return {
        kind: body.kind,
        queryId: body.queryId.toString(),
        newOwner: optionalAddress(body.newOwner),
        responseDestination: optionalAddress(body.responseDestination),
        customPayload: optionalBoc(body.customPayload),
        forwardAmount: body.forwardAmount.toString(),
        forwardPayload: forwardPayloadJson(body.forwardPayload),
      };
    case "nft-ownership-assigned":
      return {
        kind: body.kind,
        queryId: body.queryId.toString(),
        prevOwner: optionalAddress(body.prevOwner),
        forwardPayload: forwardPayloadJson(body.forwardPayload),
      };
    case "bounce": {
      const common = {
        kind: body.kind,
        originalOp: body.originalOp,
        originalQueryId: optionalDecimal(body.originalQueryId),
        originalBody: boc(body.originalBody),
      };
      if (body.format === "legacy") return { ...common, format: "legacy" };
      return {
        ...common,
        format: "new",
        originalValue: body.originalValue.toString(),
        originalCreatedLt: body.originalCreatedLt.toString(),
        originalCreatedAt: body.originalCreatedAt,
        bouncedBy: body.bouncedBy,
        exitCode: body.exitCode,
        compute:
          body.compute === null
            ? null
            : { gasUsed: body.compute.gasUsed, vmSteps: body.compute.vmSteps },
      };
    }
    case "unknown":
      return { kind: body.kind, op: body.op };
  }
}

function forwardPayloadJson(payload: ForwardPayload): ForwardPayloadJson {
  switch (payload.kind) {
    case "empty":
      return { kind: "empty" };
    case "opaque":
      return { kind: payload.kind, op: payload.op, cell: boc(payload.cell) };
    default:
      return commentJson(payload);
  }
}

function commentJson(value: Comment | Malformed): CommentJson | MalformedJson {
  switch (value.kind) {
    case "text-comment":
      return { kind: value.kind, text: value.text };
    case "binary-comment":
    case "encrypted-comment":
      return { kind: value.kind, data: value.data.toString("base64") };
    case "malformed":
      return { kind: value.kind, op: value.op, reason: value.reason };
  }
}

const boc = (cell: Cell) => cell.toBoc().toString("base64");
const optionalBoc = (cell: Cell | null) => (cell === null ? null : boc(cell));
const optionalAddress = (address: Address | null) =>
  address === null ? null : address.toRawString();
const optionalDecimal = (value: bigint | null) => (value === null ? null : value.toString());

function externalJson(address: ExternalAddress | null): ExternalAddressJson | null {
  return address === null ? null : { bits: address.bits, value: address.value.toString() };
}
