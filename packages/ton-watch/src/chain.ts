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
export const isAnchored = (tx: Pick<TxRecord, "prevLt">, startLt: bigint) => tx.prevLt <= startLt;

/**
 * Reference implementation of frontier/gap detection over an ascending list of one
 * address's transactions (all with `lt > startLt`). Stores may implement the same
 * rules in their query language; `MemoryStore` uses this directly.
 */
export function analyzeChain(
  address: string,
  txsAsc: TxRecord[],
  startLt: bigint,
  from: TxId | null = null,
): { frontier: TxId | null; gaps: Gap[] } {
  const byLt = new Map<bigint, TxRecord>();
  for (const tx of txsAsc) byLt.set(tx.lt, tx);

  let frontier: TxId | null = from;
  let blocked = false;
  const gaps: Gap[] = [];
  let below: bigint = startLt;

  for (const tx of txsAsc) {
    if (from && tx.lt <= from.lt) {
      below = tx.lt;
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
        floorLt: below,
      });
    } else if (!blocked && (!frontier || tx.lt > frontier.lt)) {
      frontier = { lt: tx.lt, hash: tx.hash };
    }
    below = tx.lt;
  }
  return { frontier, gaps };
}
