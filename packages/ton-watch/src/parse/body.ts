import type { Cell, Slice } from "@ton/core";

import { decodeLegacyBounce, decodeNewBounce } from "./bounce";
import { decodeComment, isCommentOp } from "./comment";
import {
  decodeExcesses,
  decodeJettonBurn,
  decodeJettonInternalTransfer,
  decodeJettonTransfer,
  decodeJettonTransferNotification,
} from "./jetton";
import { decodeNftOwnershipAssigned, decodeNftTransfer } from "./nft";
import { Op } from "./opcodes";
import { failureReason, malformed } from "./reader";
import type { MessageBody } from "./types";

export interface ParseBodyOptions {
  /**
   * Whether the message carrying the body has the `bounced` flag. Only then are
   * the `0xffffffff` / `0xfffffffe` prefixes read as bounce bodies.
   */
  bounced?: boolean;
}

type Decoder = (slice: Slice) => MessageBody;

const DECODERS = new Map<number, Decoder>([
  [Op.jettonTransfer, decodeJettonTransfer],
  [Op.jettonTransferNotification, decodeJettonTransferNotification],
  [Op.jettonInternalTransfer, decodeJettonInternalTransfer],
  [Op.jettonBurn, decodeJettonBurn],
  [Op.excesses, decodeExcesses],
  [Op.nftTransfer, decodeNftTransfer],
  [Op.nftOwnershipAssigned, decodeNftOwnershipAssigned],
]);

const BOUNCE_DECODERS = new Map<number, Decoder>([
  [Op.bounce, decodeLegacyBounce],
  [Op.newBounce, decodeNewBounce],
]);

const EMPTY: MessageBody = { kind: "empty" };

/**
 * Decodes a message body: comments, TEP-74 jetton and TEP-62 NFT messages, and
 * bounces. Unrecognized opcodes give `{ kind: "unknown", op }`. Never throws:
 * a body that does not fit its opcode's layout gives `{ kind: "malformed" }`.
 * Bits or refs left over after a known layout are ignored.
 */
export function parseMessageBody(
  body: Cell | null | undefined,
  options: ParseBodyOptions = {},
): MessageBody {
  if (!body) return EMPTY;
  let op: number | null = null;
  try {
    const slice = body.beginParse();
    if (slice.remainingBits === 0 && slice.remainingRefs === 0) return EMPTY;
    if (slice.remainingBits < 32) return malformed(null, "body is shorter than a 32-bit opcode");
    op = slice.loadUint(32);
    if (isCommentOp(op)) return decodeComment(op, slice);
    const decoder = (options.bounced ? BOUNCE_DECODERS : DECODERS).get(op);
    return decoder ? decoder(slice) : { kind: "unknown", op };
  } catch (error) {
    return malformed(op, failureReason(error));
  }
}
