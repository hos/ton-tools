import { type Cell, loadTransaction } from "@ton/core";

import type { TxRecord } from "./types";

const HASH_BYTES = 32;

/** Builds a `TxRecord` from a transaction cell. The hash is the cell's own hash. */
export function recordFromCell(cell: Cell, rawAddress: string): TxRecord {
  const tx = loadTransaction(cell.beginParse());
  return {
    address: rawAddress,
    lt: tx.lt,
    hash: cell.hash(),
    prevLt: tx.prevTransactionLt,
    prevHash: hashToBuffer(tx.prevTransactionHash),
    utime: tx.now,
    boc: cell.toBoc({ idx: false, crc32: false }),
  };
}

/** A 256-bit hash held as a bigint (as `@ton/core` parses it) to its 32-byte form. */
function hashToBuffer(hash: bigint): Buffer {
  return Buffer.from(hash.toString(16).padStart(HASH_BYTES * 2, "0"), "hex");
}
