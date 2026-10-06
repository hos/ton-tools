import {
  Address,
  Cell,
  loadTransaction,
  type Transaction,
  type TransactionActionPhase,
  type TransactionComputePhase,
  type TransactionDescription,
} from "@ton/core";

import type { IndexedTx, TxRecord } from "../core/types";
import { parseMessage } from "./message";
import type {
  ActionResult,
  ComputeResult,
  Direction,
  ParsedMessage,
  ParsedTransaction,
} from "./types";

/** A `@ton/core` transaction, or a stored record / delivered `IndexedTx` holding one. */
export type TransactionInput = Transaction | TxRecord;

export interface ParseTransactionOptions {
  /**
   * The account the transaction belongs to. Optional: it is taken from a
   * `TxRecord`, or else from the transaction's messages. Throws if it is not an
   * address or names a different account (hash, or workchain where the record
   * or the messages tell it) than the transaction's.
   */
  address?: Address | string;
}

/**
 * Summarizes a transaction: outcome, bounce flags, direction, fees and decoded
 * messages. Message bodies never cause a throw (bad ones decode as
 * `{ kind: "malformed" }`); only a record whose BOC is not a transaction, or a
 * mismatching `options.address`, does.
 */
export function parseTransaction(
  input: TransactionInput,
  options: ParseTransactionOptions = {},
): ParsedTransaction {
  const tx = toTransaction(input);
  const inMessage = tx.inMessage ? parseMessage(tx.inMessage) : null;
  const outMessages = [...tx.outMessages.keys()]
    .sort((a, b) => a - b)
    .flatMap((key) => {
      const message = tx.outMessages.get(key);
      return message ? [parseMessage(message)] : [];
    });
  const address = accountAddress(tx, input, options.address, inMessage, outMessages);
  const { aborted, compute, action } = phases(tx.description);
  const bouncePhase = tx.description.type === "generic" ? tx.description.bouncePhase : null;

  return {
    address,
    lt: tx.lt,
    hash: "boc" in input ? input.hash : tx.hash(),
    utime: tx.now,
    type: tx.description.type,
    success:
      !aborted &&
      (compute === null || (compute.type === "vm" && compute.success)) &&
      (action === null || action.success),
    aborted,
    compute,
    action,
    receivedBounce: inMessage?.type === "internal" && inMessage.bounced,
    bouncedBack: bouncePhase?.type === "ok",
    direction: direction(inMessage, address),
    inMessage,
    outMessages,
    totalFees: tx.totalFees.coins,
    valueIn: inMessage?.type === "internal" ? inMessage.value : 0n,
    valueOut: outMessages.reduce((sum, m) => (m.type === "internal" ? sum + m.value : sum), 0n),
    raw: tx,
  };
}

/** The `@ton/core` transaction behind any accepted input. */
export function toTransaction(input: TransactionInput): Transaction {
  if (!("boc" in input)) return input;
  if ("transaction" in input) return (input as IndexedTx).transaction;
  const [root] = Cell.fromBoc(input.boc);
  if (!root) throw new Error("transaction record has an empty BOC");
  return loadTransaction(root.beginParse());
}

function accountAddress(
  tx: Transaction,
  input: TransactionInput,
  option: Address | string | undefined,
  inMessage: ParsedMessage | null,
  outMessages: ParsedMessage[],
): Address | null {
  const known = "boc" in input ? Address.parse(input.address) : null;
  const derived = known ?? addressFromMessages(inMessage, outMessages);
  if (option === undefined) return derived;
  const address = typeof option === "string" ? Address.parse(option) : option;
  // The transaction stores only the account's hash; the workchain comes from the
  // record or the messages, when they have one.
  const sameHash = BigInt(`0x${address.hash.toString("hex")}`) === tx.address;
  if (!sameHash || (derived !== null && derived.workChain !== address.workChain)) {
    throw new Error(`address ${address.toRawString()} is not the transaction's account`);
  }
  return address;
}

/** The account as named by its messages: the inbound destination or an outbound source. */
function addressFromMessages(
  inMessage: ParsedMessage | null,
  outMessages: ParsedMessage[],
): Address | null {
  if (inMessage && inMessage.type !== "external-out") return inMessage.dest;
  for (const message of outMessages) {
    if (message.type !== "external-in") return message.src;
  }
  return null;
}

function phases(description: TransactionDescription): {
  aborted: boolean;
  compute: ComputeResult | null;
  action: ActionResult | null;
} {
  switch (description.type) {
    case "generic":
    case "tick-tock":
    case "split-prepare":
    case "merge-install":
      return {
        aborted: description.aborted,
        compute: computeResult(description.computePhase),
        action: description.actionPhase ? actionResult(description.actionPhase) : null,
      };
    case "merge-prepare":
      return { aborted: description.aborted, compute: null, action: null };
    case "storage":
    case "split-install":
      return { aborted: false, compute: null, action: null };
  }
}

function computeResult(phase: TransactionComputePhase): ComputeResult {
  if (phase.type === "skipped") return { type: "skipped", reason: phase.reason };
  return {
    type: "vm",
    success: phase.success,
    exitCode: phase.exitCode,
    gasUsed: phase.gasUsed,
  };
}

function actionResult(phase: TransactionActionPhase): ActionResult {
  return {
    success: phase.success,
    resultCode: phase.resultCode,
    totalActions: phase.totalActions,
    skippedActions: phase.skippedActions,
  };
}

function direction(inMessage: ParsedMessage | null, address: Address | null): Direction {
  if (!inMessage) return "system";
  if (inMessage.type !== "internal") return "outgoing";
  return address && inMessage.src.equals(address) ? "self" : "incoming";
}
