/**
 * Deposit checks: the two questions payment processing asks of every
 * transaction, answered with the bounce and failure cases already excluded.
 */
import { Address, type Transaction } from "@ton/core";

import {
  type ParseTransactionOptions,
  parseTransaction,
  type TransactionInput,
} from "./transaction";
import type { ForwardPayload, MessageBody } from "./types";

/** TON that arrived on the account and stayed there. */
export interface IncomingPayment {
  /** Who sent the TON. */
  sender: Address;
  /** Value of the inbound message, in nanotons. */
  amount: bigint;
  /** Text comment, if the body is one; see `body` for binary or encrypted comments. */
  comment: string | null;
  body: MessageBody;
  /** Whether the transaction succeeded; `false` for e.g. a deposit to a not yet deployed wallet. */
  success: boolean;
}

/**
 * The TON payment this transaction received, or `null` if it is not one.
 *
 * Returns a payment only when the inbound message is internal, from another
 * account, carries value, is not itself a bounce (returning funds this account
 * sent), and the value stayed on the account: the transaction did not bounce it
 * back. A failed compute phase does not by itself mean the value was lost — a
 * non-bounceable deposit to an undeployed wallet is skipped by the compute phase
 * and still credited — so such transactions are returned with `success: false`.
 */
export function incomingPayment(
  input: TransactionInput,
  options: ParseTransactionOptions = {},
): IncomingPayment | null {
  const tx = parseTransaction(input, options);
  const message = tx.inMessage;
  if (tx.type !== "generic" || tx.direction !== "incoming" || message?.type !== "internal") {
    return null;
  }
  if (message.bounced || message.value <= 0n || tx.bouncedBack || !wasCredited(tx.raw)) {
    return null;
  }
  return {
    sender: message.src,
    amount: message.value,
    comment: message.comment,
    body: message.body,
    success: tx.success,
  };
}

export interface IncomingJettonTransferOptions extends ParseTransactionOptions {
  /**
   * This account's own jetton wallet for the jetton you accept. When given, a
   * notification from any other address yields `null`. Strongly recommended:
   * see `incomingJettonTransfer`.
   */
  jettonWallet?: Address | string;
}

/** Jettons this account received, as reported by a `transfer_notification`. */
export interface IncomingJettonTransfer {
  /**
   * The jetton wallet that sent the notification. UNVERIFIED unless the
   * `jettonWallet` option was given: you must check it is this account's wallet
   * of the expected jetton before crediting anything.
   */
  jettonWallet: Address;
  /** Jetton amount in elementary units. */
  amount: bigint;
  /** Previous owner of the jettons (the payer), as claimed by the jetton wallet. */
  sender: Address | null;
  queryId: bigint;
  /** TON attached to the notification (the transfer's `forward_ton_amount`), in nanotons. */
  tonAmount: bigint;
  forwardPayload: ForwardPayload;
  /** Text comment from the forward payload, if it is one. */
  comment: string | null;
}

/**
 * The jetton transfer announced by this transaction's inbound
 * `transfer_notification`, or `null` if there is none.
 *
 * SECURITY: a `transfer_notification` is an ordinary message that anyone can
 * send with any amount. It only proves a deposit when it comes from this
 * account's own jetton wallet for the expected jetton master — get that address
 * with the master's `get_wallet_address(owner)` and pass it as
 * `options.jettonWallet`, or compare `jettonWallet` yourself. Never credit a
 * notification from an unchecked sender.
 *
 * Notifications are only sent when the transfer had a non-zero
 * `forward_ton_amount`; to see every transfer, watch the jetton wallet itself
 * (`jetton-internal-transfer` bodies). The jettons are credited to the jetton
 * wallet before the notification is sent, so the notification transaction's
 * own success or bounce does not undo them.
 */
export function incomingJettonTransfer(
  input: TransactionInput,
  options: IncomingJettonTransferOptions = {},
): IncomingJettonTransfer | null {
  const tx = parseTransaction(input, options);
  const message = tx.inMessage;
  if (message?.type !== "internal" || message.bounced) return null;
  const body = message.body;
  if (body.kind !== "jetton-transfer-notification") return null;
  if (options.jettonWallet !== undefined && !message.src.equals(toAddress(options.jettonWallet))) {
    return null;
  }
  return {
    jettonWallet: message.src,
    amount: body.amount,
    sender: body.sender,
    queryId: body.queryId,
    tonAmount: message.value,
    forwardPayload: body.forwardPayload,
    comment: body.forwardPayload.kind === "text-comment" ? body.forwardPayload.text : null,
  };
}

/** The inbound value reached the balance: there was a credit phase. */
function wasCredited(tx: Transaction): boolean {
  return tx.description.type === "generic" && Boolean(tx.description.creditPhase);
}

function toAddress(address: Address | string): Address {
  return typeof address === "string" ? Address.parse(address) : address;
}
