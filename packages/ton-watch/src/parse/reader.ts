import { Address, type Cell, type Slice } from "@ton/core";

import type { Malformed } from "./types";

/** A body that does not match its opcode's layout. Never escapes the parse module. */
export class DecodeError extends Error {
  override name = "DecodeError";
}

export function malformed(op: number | null, reason: string): Malformed {
  return { kind: "malformed", op, reason };
}

/** The reason to report for anything thrown while decoding. */
export function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first 32 bits of a cell, or `null` when it is shorter or cannot be read. */
export function peekOp(cell: Cell | null | undefined): number | null {
  if (!cell) return null;
  try {
    const slice = cell.beginParse();
    return slice.remainingBits >= 32 ? slice.preloadUint(32) : null;
  } catch {
    return null;
  }
}

export function readQueryId(slice: Slice): bigint {
  return slice.loadUintBig(64);
}

/**
 * Reads a `MsgAddress` that must be internal or `addr_none` (`null`). Standard
 * jetton and NFT fields never hold external addresses, so one is a layout error.
 */
export function readAddress(slice: Slice): Address | null {
  const address = slice.loadAddressAny();
  if (address === null || Address.isAddress(address)) return address;
  throw new DecodeError("unexpected external address");
}

/** Reads `Maybe ^Cell`. */
export function readMaybeRef(slice: Slice): Cell | null {
  if (!slice.loadBit()) return null;
  if (slice.remainingRefs === 0) throw new DecodeError("missing referenced cell");
  return slice.loadRef();
}
