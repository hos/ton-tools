import type { EventEmitter } from "node:events";

import type { ErrorKind } from "../core/errors";
import type { ChainTip } from "../source/source";

/** Events emitted by `Indexer`, with their listener arguments. */
export interface IndexerEventMap {
  /** A detection and maintenance round finished. */
  tick: [tip: ChainTip];
  /** An address's frontier moved forward: new transactions are deliverable. */
  frontier: [address: string, lt: bigint];
  /** An address is known complete up to a newer chain lt. */
  synced: [address: string, syncLt: bigint];
  /** A page fetch failed and will be retried. */
  fetchError: [address: string, kind: ErrorKind, error: unknown];
}

/** The emitting side, as handed to the indexer's components. */
export type IndexerEmitter = Pick<EventEmitter<IndexerEventMap>, "emit">;
