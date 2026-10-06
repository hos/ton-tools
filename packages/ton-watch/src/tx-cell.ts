import { type Cell, loadTransaction } from "@ton/core";

import { bigIntToBuffer } from "./ton";
import type { TxRecord } from "./types";

/** Builds a `TxRecord` from a transaction cell. The hash is the cell's own hash. */
export function recordFromCell(cell: Cell, rawAddress: string): TxRecord {
  const tx = loadTransaction(cell.beginParse());
  return {
    address: rawAddress,
    lt: tx.lt,
    hash: cell.hash(),
    prevLt: tx.prevTransactionLt,
    prevHash: bigIntToBuffer(tx.prevTransactionHash, 64),
    utime: tx.now,
    boc: cell.toBoc({ idx: false, crc32: false }),
  };
}
