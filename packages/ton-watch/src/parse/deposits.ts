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

/** Value an inbound message credited to the account. */
export interface IncomingPayment {
  /** Who sent the TON. */
  sender: Address;
  /** TON value of the inbound message, in nanotons. */
  amount: bigint;
  /**
   * Extra currencies the message carried, by currency id; empty for a TON-only
   * transfer. `amount` does not include them.
   */
  extraCurrencies: Map<number, bigint>;
  /** Text comment, if the body is one; see `body` for binary or encrypted comments. */
  comment: string | null;
  /**
   * The decoded body. Not every credited message is a payment to you: check it
   * is a plain transfer (`empty` or a comment) before crediting, since e.g.
   * `excesses` refunds and the TON attached to jetton notifications arrive the
   * same way.
   */
  body: MessageBody;
  /** Whether the transaction succeeded; `false` for e.g. a deposit to a not yet deployed wallet. */
  success: boolean;
}

/**
 * The value this transaction received, or `null` if it received none.
 *
 * Returns a payment only when the inbound message is internal, from another
 * account, carries TON, is not itself a bounce (returning funds this account
 * sent), and its value was credited to the balance and not bounced back. A
 * failed compute phase does not by itself mean the value was lost — a
 * non-bounceable deposit to an undeployed wallet is skipped by the compute phase
 * and still credited — so such transactions are returned with `success: false`.
 *
 * "Credited" is about this transaction only: the account's own code may have
 * sent value onward in the same transaction (see `parseTransaction(...).valueOut`).
 *
 * Throws, like `parseTransaction`, when a record's BOC is not a transaction or
 * `options.address` is invalid or names another account.
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
    extraCurrencies: message.extraCurrencies,
    comment: message.comment,
    body: message.body,
    success: tx.success,
  };
}

/** One jetton wallet address, or several (e.g. one per accepted jetton), friendly or raw. */
export type JettonWallets = Address | string | Iterable<Address | string>;

/**
 * Which senders of a `transfer_notification` to trust: exactly one of
 * `jettonWallet` (recommended) or `trustAnySender: true`.
 */
export type IncomingJettonTransferOptions = ParseTransactionOptions &
  (
    | {
        /**
         * This account's own jetton wallet(s) for the jetton(s) you accept; a
         * notification from any other address yields `null`. Get each with the
         * jetton master's `get_wallet_address(owner)`.
         */
        jettonWallet: JettonWallets;
        trustAnySender?: never;
      }
    | {
        /**
         * Accept a notification from any sender. The result's `jettonWallet` is
         * then unverified and must be checked before crediting anything.
         */
        trustAnySender: true;
        jettonWallet?: never;
      }
  );

/** Jettons this account received, as reported by a `transfer_notification`. */
export interface IncomingJettonTransfer {
  /**
   * The jetton wallet that sent the notification: one of the `jettonWallet`
   * option's addresses, or UNVERIFIED under `trustAnySender`.
   */
  jettonWallet: Address;
  /** Jetton amount in elementary units. */
  amount: bigint;
  /** Previous owner of the jettons (the payer), as claimed by the jetton wallet. */
  sender: Address | null;
  queryId: bigint;
  /** TON attached to the notification (the transfer's `forward_ton_amount`), in nanotons. */
  tonAmount: bigint;
  /** `malformed` when the payload does not decode; the transfer itself still counts. */
  forwardPayload: ForwardPayload;
  /** Text comment from the forward payload, if it is one. */
  comment: string | null;
}

/**
 * The jetton transfer announced by this transaction's inbound
 * `transfer_notification`, or `null` if there is none or it came from a sender
 * not in `options.jettonWallet`.
 *
 * SECURITY: a `transfer_notification` is an ordinary message that anyone can
 * send with any amount. It only proves a deposit when it comes from this
 * account's own jetton wallet for the expected jetton master, which is why
 * `jettonWallet` is required; `trustAnySender: true` opts out, leaving the check
 * to you.
 *
 * Notifications are only sent when the transfer had a non-zero
 * `forward_ton_amount`; to see every transfer, watch the jetton wallet itself
 * (`jetton-internal-transfer` bodies). The jettons are credited to the jetton
 * wallet before the notification is sent, so the notification transaction's
 * own success or bounce does not undo them.
 *
 * Throws when a record's BOC is not a transaction, `options.address` is invalid
 * or names another account, a `jettonWallet` string is not an address, or
 * neither `jettonWallet` nor `trustAnySender` is given.
 */
export function incomingJettonTransfer(
  input: TransactionInput,
  options: IncomingJettonTransferOptions,
): IncomingJettonTransfer | null {
  const trusted = trustedSenders(options);
  const tx = parseTransaction(input, options);
  const message = tx.inMessage;
  if (message?.type !== "internal" || message.bounced) return null;
  const body = message.body;
  if (body.kind !== "jetton-transfer-notification") return null;
  if (trusted && !trusted.has(message.src.toRawString())) return null;
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

/** Raw addresses of the trusted jetton wallets; null under `trustAnySender`. */
function trustedSenders(options: IncomingJettonTransferOptions | undefined): Set<string> | null {
  const { jettonWallet, trustAnySender } = (options ?? {}) as {
    jettonWallet?: JettonWallets;
    trustAnySender?: boolean;
  };
  if (jettonWallet !== undefined && trustAnySender) {
    throw new TypeError("incomingJettonTransfer: pass jettonWallet or trustAnySender, not both");
  }
  if (trustAnySender === true) return null;
  if (jettonWallet === undefined) {
    throw new TypeError(
      "incomingJettonTransfer: options.jettonWallet is required (or trustAnySender: true)",
    );
  }
  const wallets =
    typeof jettonWallet === "string" || Address.isAddress(jettonWallet)
      ? [jettonWallet]
      : [...jettonWallet];
  return new Set(wallets.map((wallet) => toAddress(wallet).toRawString()));
}

/** The inbound value reached the balance: there was a credit phase. */
function wasCredited(tx: Transaction): boolean {
  return tx.description.type === "generic" && Boolean(tx.description.creditPhase);
}

function toAddress(address: Address | string): Address {
  return typeof address === "string" ? Address.parse(address) : address;
}
