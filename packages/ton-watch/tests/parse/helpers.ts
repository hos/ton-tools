import {
  Address,
  type Builder,
  beginCell,
  type Cell,
  Dictionary,
  type DictionaryValue,
  ExternalAddress,
  loadMessage,
  loadTransaction,
  type Message,
  storeMessage,
  storeTransaction,
  type Transaction,
  type TransactionComputePhase,
  type TransactionDescriptionGeneric,
} from "@ton/core";

import { recordFromCell } from "../../src/core/transaction";
import type { TxRecord } from "../../src/core/types";

export const ACCOUNT = Address.parse(`0:${"11".repeat(32)}`);
export const OTHER = Address.parse(`0:${"22".repeat(32)}`);
export const THIRD = Address.parse(`0:${"33".repeat(32)}`);

export function internalMessage(
  fields: {
    src?: Address;
    dest?: Address;
    value?: bigint;
    bounce?: boolean;
    bounced?: boolean;
    body?: Cell;
    extraCurrencies?: Dictionary<number, bigint>;
  } = {},
): Message {
  return {
    info: {
      type: "internal",
      ihrDisabled: true,
      bounce: fields.bounce ?? false,
      bounced: fields.bounced ?? false,
      src: fields.src ?? OTHER,
      dest: fields.dest ?? ACCOUNT,
      value: { coins: fields.value ?? 1_000_000_000n, other: fields.extraCurrencies ?? null },
      ihrFee: 0n,
      forwardFee: 1_000n,
      createdLt: 100n,
      createdAt: 1_700_000_000,
    },
    body: fields.body ?? beginCell().endCell(),
  };
}

export function externalInMessage(body: Cell = beginCell().endCell()): Message {
  return {
    info: { type: "external-in", src: null, dest: ACCOUNT, importFee: 0n },
    body,
  };
}

export function externalOutMessage(body: Cell = beginCell().endCell()): Message {
  return {
    info: {
      type: "external-out",
      src: ACCOUNT,
      dest: new ExternalAddress(5n, 8),
      createdLt: 101n,
      createdAt: 1_700_000_000,
    },
    body,
  };
}

export const VM_OK: TransactionComputePhase = vmPhase(true, 0);

export function vmPhase(success: boolean, exitCode: number): TransactionComputePhase {
  return {
    type: "vm",
    success,
    messageStateUsed: false,
    accountActivated: false,
    gasFees: 1_000n,
    gasUsed: 500n,
    gasLimit: 1_000_000n,
    mode: 0,
    exitCode,
    vmSteps: 10,
    vmInitStateHash: 0n,
    vmFinalStateHash: 0n,
  };
}

export function actionPhase(success: boolean, resultCode = 0) {
  return {
    success,
    valid: true,
    noFunds: false,
    statusChange: "unchanged" as const,
    resultCode,
    totalActions: 1,
    specActions: 0,
    skippedActions: 0,
    messagesCreated: success ? 1 : 0,
    actionListHash: 0n,
    totalMessageSize: { cells: 1n, bits: 100n },
  };
}

/** A successful generic transaction description; override any phase. */
export function generic(
  overrides: Partial<Omit<TransactionDescriptionGeneric, "type">> = {},
): TransactionDescriptionGeneric {
  return {
    type: "generic",
    creditFirst: true,
    storagePhase: { storageFeesCollected: 10n, statusChange: "unchanged" },
    creditPhase: { credit: { coins: 1_000_000_000n } },
    computePhase: VM_OK,
    actionPhase: actionPhase(true),
    aborted: false,
    destroyed: false,
    ...overrides,
  };
}

/**
 * Serializes a transaction into a real cell and parses it back, so tests see
 * exactly what `@ton/core` produces from chain data.
 */
export function buildTx(
  fields: {
    inMessage?: Message;
    outMessages?: Message[];
    description?: Transaction["description"];
    totalFees?: bigint;
  } = {},
): { tx: Transaction; record: TxRecord; cell: Cell } {
  const outMessages = Dictionary.empty(Dictionary.Keys.Uint(15), messageValue());
  (fields.outMessages ?? []).forEach((message, i) => {
    outMessages.set(i, message);
  });
  const source: Transaction = {
    address: BigInt(`0x${ACCOUNT.hash.toString("hex")}`),
    lt: 2_000n,
    prevTransactionHash: 0n,
    prevTransactionLt: 1_000n,
    now: 1_700_000_100,
    outMessagesCount: outMessages.size,
    oldStatus: "active",
    endStatus: "active",
    inMessage: fields.inMessage,
    outMessages,
    totalFees: { coins: fields.totalFees ?? 12_345n },
    stateUpdate: { oldHash: Buffer.alloc(32), newHash: Buffer.alloc(32) },
    description: fields.description ?? generic(),
    raw: null as never,
    hash: null as never,
  };
  const cell = beginCell().store(storeTransaction(source)).endCell();
  return {
    tx: loadTransaction(cell.beginParse()),
    record: recordFromCell(cell, ACCOUNT.toRawString()),
    cell,
  };
}

/** Dictionary codec for `^(Message Any)` values, as in a transaction's `out_msgs`. */
function messageValue(): DictionaryValue<Message> {
  return {
    serialize: (message, builder) => {
      builder.storeRef(beginCell().store(storeMessage(message)));
    },
    parse: (slice) => loadMessage(slice.loadRef().beginParse()),
  };
}

/** `0x00000000` + text, in snake format (as `@ton/core`'s `comment()` builds it). */
export function textComment(text: string): Cell {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell();
}

/** Snake cells built by hand with a fixed number of bytes per cell. */
export function snakeCell(prefix: (b: Builder) => void, data: Buffer, perCell: number): Cell {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += perCell) chunks.push(data.subarray(i, i + perCell));
  let tail: Cell | null = null;
  for (let i = chunks.length - 1; i >= 1; i--) {
    const b = beginCell().storeBuffer(chunks[i]!);
    if (tail) b.storeRef(tail);
    tail = b.endCell();
  }
  const root = beginCell();
  prefix(root);
  if (chunks[0]) root.storeBuffer(chunks[0]);
  if (tail) root.storeRef(tail);
  return root.endCell();
}
