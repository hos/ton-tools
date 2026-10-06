import { abbreviateAddress } from "../core/address";
import { classifyError } from "../core/errors";
import type { TxId } from "../core/types";
import type { Metrics } from "../metrics/metrics";
import type { TxSource } from "../source/source";
import { abortable, PendingTasks } from "../util/async";
import type { Logger } from "../util/logger";
import type { SplitOptions } from "./options";
import type { Run } from "./run";
import type { Walk } from "./walk";
import type { WalkScheduler } from "./walk-scheduler";

/** Pages a walk fetches before its density estimate is trusted for splitting. */
const MIN_PAGES_BEFORE_SPLIT = 3;

/**
 * A single missing range is a sequential walk: each page needs the previous one's
 * prev link. When the range is long, this finds real transactions inside it (block
 * listings, not account state, so it works as far back as blocks are kept) and
 * hands the pieces between them to the scheduler as walks of their own.
 */
export class WalkSplitter {
  private readonly background = new PendingTasks();

  constructor(
    private readonly settings: Required<SplitOptions>,
    /** Must implement `findTxNear`; see `resolveSplit`. */
    private readonly source: TxSource,
    private readonly scheduler: WalkScheduler,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly currentRun: () => Run,
  ) {}

  /**
   * Splits the rest of `walk` if it is long enough. Runs in the background; does
   * nothing once a stop was requested, and an abandoned lookup leaves the walk
   * whole (and splittable again).
   */
  maybeSplit(walk: Walk): void {
    const run = this.currentRun();
    if (run.stopRequested) return;
    if (walk.split || walk.pages < MIN_PAGES_BEFORE_SPLIT || walk.fetched === 0) return;
    const ltPerTx = Number(walk.topLt - walk.cursor.lt) / walk.fetched;
    const remainingTxs = Number(walk.cursor.lt - walk.floorLt) / ltPerTx;
    // Negated so that a NaN estimate does not split.
    if (!(remainingTxs >= this.settings.minTxs)) return;
    walk.split = true;
    const parts = Math.min(
      this.settings.maxParts,
      Math.floor(remainingTxs / this.settings.targetTxs),
    );
    if (parts < 2) return;

    const targets = evenlySpaced(walk.floorLt, walk.cursor.lt, parts);
    this.metrics.inc("ton_watch_splits_total");
    this.background.track(
      Promise.all(targets.map((lt) => this.findSplitPoint(walk.address, lt, ltPerTx, run))).then(
        (found) => {
          if (run.signal.aborted) walk.split = false;
          else this.splitAt(walk, found, remainingTxs);
        },
      ),
    );
  }

  /** Resolves once every split started by `maybeSplit` has been looked up and applied. */
  settled(): Promise<void> {
    return this.background.settled();
  }

  private findSplitPoint(
    address: string,
    lt: bigint,
    ltPerTx: number,
    run: Run,
  ): Promise<TxId | null> {
    const { signal } = run;
    return abortable(this.source.findTxNear!(address, lt, { ltPerTx, signal }), signal).catch(
      (error) => {
        if (!signal.aborted) this.metrics.error(classifyError(error), "findTxNear");
        return null;
      },
    );
  }

  /** Turns the part of `walk` below the found points into separate walks. */
  private splitAt(walk: Walk, found: (TxId | null)[], remainingTxs: number): void {
    if (!this.scheduler.has(walk)) return;
    // Only points strictly inside what is still left of the walk.
    const points = uniqueByLt(
      found.filter(
        (point): point is TxId =>
          point !== null && point.lt > walk.floorLt && point.lt < walk.cursor.lt,
      ),
    ).sort((a, b) => (a.lt < b.lt ? -1 : 1));
    if (points.length === 0) return;

    this.metrics.inc("ton_watch_split_points_total", undefined, points.length);
    let floorLt = walk.floorLt;
    for (const point of points) {
      this.scheduler.add(
        { address: walk.address, kind: walk.kind, cursor: point, floorLt, topLt: point.lt },
        { split: true },
      );
      floorLt = point.lt;
    }
    walk.floorLt = floorLt;
    this.logger.debug(
      `[${abbreviateAddress(walk.address)}] split ~${Math.round(remainingTxs)} txs into ${points.length + 1} parts`,
    );
  }
}

/** The `parts - 1` lts dividing (floorLt, topLt) into `parts` equal spans. */
function evenlySpaced(floorLt: bigint, topLt: bigint, parts: number): bigint[] {
  const span = topLt - floorLt;
  return Array.from(
    { length: parts - 1 },
    (_, i) => floorLt + (span * BigInt(i + 1)) / BigInt(parts),
  );
}

function uniqueByLt(ids: TxId[]): TxId[] {
  const seen = new Set<bigint>();
  return ids.filter((id) => {
    if (seen.has(id.lt)) return false;
    seen.add(id.lt);
    return true;
  });
}
