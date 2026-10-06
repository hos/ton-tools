import type { ErrorKind } from "../core/errors";
import type { TxId } from "../core/types";

/** `head`: new transactions found by change detection. `gap`: a hole found in the store. */
export type WalkKind = "head" | "gap";

/** A missing range of one address, fetched backwards page by page. */
export interface WalkRange {
  address: string;
  kind: WalkKind;
  /** Next transaction to fetch (newest first). */
  cursor: TxId;
  /** Stop once the chain reaches this lt (it is stored or out of scope). */
  floorLt: bigint;
  /** Where the walk started; everything in (floorLt, topLt] is this walk's job. */
  topLt: bigint;
}

/** A scheduled walk with its progress and retry state. */
export interface Walk extends WalkRange {
  id: number;
  pages: number;
  /** Transactions received so far (density estimate for splitting). */
  fetched: number;
  /** Already split, or a piece of a split. */
  split: boolean;
  /** Consecutive failed page fetches. */
  failures: number;
  lastError?: ErrorKind;
  /** Earliest time (ms) of the next attempt. */
  notBefore: number;
  running: boolean;
}

/** Archive misses in a row after which a walk counts as stuck rather than unlucky. */
const ARCHIVE_MISSES_BEFORE_PARKING = 3;

/**
 * Repeatedly asked for history that no server (including archival ones) has.
 * "Not found" can also mean "not seen yet" on every server asked, so only a
 * repeated miss counts.
 */
export function isParked(walk: Walk): boolean {
  return walk.lastError === "archive_unavailable" && walk.failures > ARCHIVE_MISSES_BEFORE_PARKING;
}
