import type { Slice } from "@ton/core";

import { decodeComment, isCommentOp } from "./comment";
import { DecodeError } from "./reader";
import type { ForwardPayload } from "./types";

const EMPTY: ForwardPayload = { kind: "empty" };

/**
 * Reads `forward_payload:(Either Cell ^Cell)`: inline in the rest of the slice
 * (bit 0) or in the next ref (bit 1). A slice that ends right before the
 * `Either` bit is read as an empty payload, since some deployed jetton wallets
 * omit it.
 */
export function readForwardPayload(slice: Slice): ForwardPayload {
  if (slice.remainingBits === 0 && slice.remainingRefs === 0) return EMPTY;
  if (!slice.loadBit()) return decodePayload(slice);
  if (slice.remainingRefs === 0) throw new DecodeError("forward payload ref is missing");
  return decodePayload(slice.loadRef().beginParse());
}

function decodePayload(slice: Slice): ForwardPayload {
  if (slice.remainingBits === 0 && slice.remainingRefs === 0) return EMPTY;
  if (slice.remainingBits < 32) return { kind: "opaque", op: null, cell: slice.asCell() };
  const op = slice.preloadUint(32);
  if (!isCommentOp(op)) return { kind: "opaque", op, cell: slice.asCell() };
  slice.skip(32);
  return decodeComment(op, slice);
}
