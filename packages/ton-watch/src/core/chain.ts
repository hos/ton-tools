import { SourceError } from "./errors";
import type { Gap, TxId, TxRecord } from "./types";

/**
 * Checks a page returned by `getTransactions(from)`: newest first, starting exactly
 * at `from`, every transaction linking to the next one. A page that fails this is a
 * bad liteserver response and must be retried elsewhere, never written.
 */
export function validatePage(from: TxId, page: TxRecord[]): void {
  if (page.length === 0) {
    throw new SourceError("bad_response", `empty page at lt ${from.lt}`);
  }
  const first = page[0]!;
  if (first.lt !== from.lt || !first.hash.equals(from.hash)) {
    throw new SourceError(
      "bad_response",
      `page starts at ${first.lt} but ${from.lt} was requested`,
    );
  }
  for (let i = 0; i + 1 < page.length; i++) {
    const cur = page[i]!;
    const next = page[i + 1]!;
    if (cur.prevLt !== next.lt || !cur.prevHash.equals(next.hash)) {
      throw new SourceError(
        "bad_response",
        `broken chain inside page: ${cur.lt} -> prev ${cur.prevLt}, got ${next.lt}`,
      );
    }
  }
}

/** A transaction is anchored when its predecessor is out of scope (or does not exist). */
export function isAnchored(tx: Pick<TxRecord, "prevLt">, startLt: bigint): boolean {
  return tx.prevLt <= startLt;
}

/** Result of `analyzeChain`. */
export interface ChainAnalysis {
  /** Newest transaction reachable from `startLt` through unbroken links. */
  frontier: TxId | null;
  /** Every unsatisfied link above the frontier, oldest first. */
  gaps: Gap[];
}

/**
 * Reference implementation of frontier/gap detection over an ascending list of one
 * address's transactions (all with `lt > startLt`). Stores may implement the same
 * rules in their query language; `MemoryStore` uses this directly.
 */
export function analyzeChain(
  address: string,
  ascending: TxRecord[],
  startLt: bigint,
  from: TxId | null = null,
): ChainAnalysis {
  const byLt = new Map<bigint, TxRecord>();
  for (const tx of ascending) byLt.set(tx.lt, tx);

  let frontier: TxId | null = from;
  let blocked = false;
  const gaps: Gap[] = [];
  /** Highest lt seen below the current transaction: the floor of a gap found there. */
  let floorLt = startLt;

  for (const tx of ascending) {
    if (from && tx.lt <= from.lt) {
      floorLt = tx.lt;
      continue;
    }
    const linked =
      isAnchored(tx, startLt) || (byLt.get(tx.prevLt)?.hash.equals(tx.prevHash) ?? false);
    if (!linked) {
      blocked = true;
      gaps.push({
        address,
        aboveLt: tx.lt,
        prevLt: tx.prevLt,
        prevHash: tx.prevHash,
        floorLt,
      });
    } else if (!blocked && (!frontier || tx.lt > frontier.lt)) {
      frontier = { lt: tx.lt, hash: tx.hash };
    }
    floorLt = tx.lt;
  }
  return { frontier, gaps };
}
