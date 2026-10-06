import type { Slice } from "@ton/core";

import { BINARY_COMMENT_PREFIX, Op } from "./opcodes";
import { DecodeError, failureReason, malformed } from "./reader";
import type { Comment, Malformed } from "./types";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads "snake" bytes: the rest of this cell's bits, then those of its first
 * ref, and so on. Every cell must hold whole bytes.
 */
export function readSnakeBytes(slice: Slice): Buffer {
  const chunks: Buffer[] = [];
  let current: Slice | null = slice;
  while (current) {
    if (current.remainingBits % 8 !== 0) {
      throw new DecodeError("snake data is not byte-aligned");
    }
    chunks.push(current.loadBuffer(current.remainingBits / 8));
    current = current.remainingRefs > 0 ? current.loadRef().beginParse() : null;
  }
  return Buffer.concat(chunks);
}

/**
 * Decodes the rest of a comment body after its opcode (`Op.comment` or
 * `Op.encryptedComment`). Returns `Malformed` for unaligned data or invalid
 * UTF-8 instead of throwing.
 */
export function decodeComment(op: number, slice: Slice): Comment | Malformed {
  let data: Buffer;
  try {
    data = readSnakeBytes(slice);
  } catch (error) {
    return malformed(op, failureReason(error));
  }
  if (op === Op.encryptedComment) return { kind: "encrypted-comment", data };
  if (data[0] === BINARY_COMMENT_PREFIX) return { kind: "binary-comment", data: data.subarray(1) };
  try {
    return { kind: "text-comment", text: utf8.decode(data) };
  } catch {
    return malformed(op, "comment is not valid UTF-8");
  }
}

export function isCommentOp(op: number): boolean {
  return op === Op.comment || op === Op.encryptedComment;
}
