import { abbreviateAddress, workchainOf } from "../core/address";
import { classifyError, errorMessage } from "../core/errors";
import { type TxId, txIdEquals } from "../core/types";
import type { Metrics } from "../metrics/metrics";
import type { ChainTip, TxSource } from "../source/source";
import { mapConcurrent } from "../util/async";
import type { Logger } from "../util/logger";
import type { IndexerSettings } from "./options";
import type { AddressTable, TrackedAddress } from "./tracked-address";

type DetectorSettings = Pick<
  IndexerSettings,
  "concurrency" | "tickMs" | "detect" | "autoBlocksThreshold" | "maxIdlePollMs" | "reconcileMs"
>;

/**
 * Finds out which addresses have new transactions, updating each tracked address's
 * `observed` last transaction. Polls account state per address, or lists the
 * transactions of every new block once (see `DetectMode`), with periodic direct
 * reconciliation so a missed listing cannot hide a transaction for long.
 */
export class ChangeDetector {
  private lastDetectedTip: ChainTip | null = null;
  /** Block listing is only trusted once every address has a verified starting point. */
  private blocksVerified = false;

  constructor(
    private readonly source: TxSource,
    private readonly addresses: AddressTable,
    private readonly settings: DetectorSettings,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  /** Runs detection for a new tip; on the same tip only first-time addresses are read. */
  async detect(tip: ChainTip): Promise<void> {
    if (this.lastDetectedTip && tip.seqno === this.lastDetectedTip.seqno) {
      await this.poll(
        this.addresses.all().filter((tracked) => !tracked.observed),
        tip,
      );
      return;
    }
    await this.detectNewBlocks(tip);
    this.lastDetectedTip = tip;
  }

  private useBlocks(): boolean {
    if (!this.source.getTouchedAccounts) return false;
    if (this.settings.detect === "blocks") return true;
    if (this.settings.detect === "poll") return false;
    return this.addresses.size >= this.settings.autoBlocksThreshold;
  }

  private async detectNewBlocks(tip: ChainTip): Promise<void> {
    const now = Date.now();
    let toPoll: TrackedAddress[];
    if (this.useBlocks() && this.lastDetectedTip && this.blocksVerified) {
      toPoll = await this.matchBlockListing(this.lastDetectedTip, tip, now);
    } else {
      const blocks = this.useBlocks();
      toPoll = this.addresses
        .all()
        .filter((tracked) => blocks || !tracked.observed || tracked.nextPollAt <= now);
    }
    const allPolled = await this.poll(toPoll, tip);
    if (this.useBlocks()) this.blocksVerified = allPolled;
  }

  /**
   * Applies the transactions listed in blocks after `prev` up to `tip`. Returns the
   * addresses that still need a direct read: new ones, ones due for
   * reconciliation, or every address when listing failed.
   */
  private async matchBlockListing(
    prev: ChainTip,
    tip: ChainTip,
    now: number,
  ): Promise<TrackedAddress[]> {
    const workchains = new Set(this.addresses.addresses().map(workchainOf));
    let touched: Map<string, TxId> | null = null;
    try {
      touched = await this.source.getTouchedAccounts!(prev, tip, workchains);
    } catch (error) {
      this.metrics.error(classifyError(error), "getTouchedAccounts");
      this.logger.warn("block listing failed, polling instead:", errorMessage(error));
    }
    if (!touched) {
      this.metrics.inc("ton_watch_detect_fallbacks_total");
      return this.addresses.all();
    }

    const toPoll: TrackedAddress[] = [];
    for (const tracked of this.addresses.all()) {
      const observed = tracked.observed;
      if (!observed) {
        toPoll.push(tracked);
        continue;
      }
      // Raw addresses may be stored in either hex case; block listings are lowercase.
      const hit = touched.get(tracked.state.address.toLowerCase());
      if (hit && (!observed.lastTx || hit.lt > observed.lastTx.lt)) observed.lastTx = hit;
      observed.syncLt = tip.syncLt;
      observed.utime = tip.utime;
    }
    for (const tracked of this.dueForReconciliation(now)) {
      tracked.reconcilingFrom = tracked.observed!.lastTx;
      toPoll.push(tracked);
    }
    return toPoll;
  }

  /**
   * Addresses to re-verify directly this tick: every address at least once per
   * `reconcileMs`, spread over ticks, so a transaction block listing missed (for
   * whatever reason) is found within that bound instead of never.
   */
  private dueForReconciliation(now: number): TrackedAddress[] {
    const { reconcileMs, tickMs } = this.settings;
    const due = this.addresses
      .all()
      .filter((tracked) => tracked.observed && now - tracked.verifiedAt >= reconcileMs)
      .sort((a, b) => a.verifiedAt - b.verifiedAt);
    const perTick = Math.ceil((this.addresses.size * tickMs) / reconcileMs) + 1;
    return due.slice(0, perTick);
  }

  /** Reads the last transaction of each address. Resolves to whether all reads succeeded. */
  private async poll(targets: TrackedAddress[], tip: ChainTip): Promise<boolean> {
    const now = Date.now();
    const results = await mapConcurrent(targets, this.settings.concurrency, async (tracked) => {
      try {
        const lastTx = await this.source.getLastTx(tracked.state.address, tip);
        this.finishReconciliation(tracked, lastTx);
        tracked.verifiedAt = now;
        const changed = !tracked.observed || !txIdEquals(tracked.observed.lastTx, lastTx);
        tracked.observed = { lastTx, syncLt: tip.syncLt, utime: tip.utime };
        tracked.idleStreak = changed ? 0 : tracked.idleStreak + 1;
        tracked.nextPollAt = now + this.idlePollDelay(tracked.idleStreak);
        return true;
      } catch (error) {
        this.metrics.error(classifyError(error), "getLastTx");
        return false;
      }
    });
    return results.every(Boolean);
  }

  /** Poll mode: 0 while active, then 1, 3, 7… ticks while idle, capped at `maxIdlePollMs`. */
  private idlePollDelay(idleStreak: number): number {
    return Math.min(this.settings.maxIdlePollMs, this.settings.tickMs * (2 ** idleStreak - 1));
  }

  private finishReconciliation(tracked: TrackedAddress, lastTx: TxId | null): void {
    if (tracked.reconcilingFrom === undefined) return;
    const listed = tracked.reconcilingFrom;
    if (!txIdEquals(listed, lastTx) && (lastTx?.lt ?? 0n) > (listed?.lt ?? 0n)) {
      this.metrics.inc("ton_watch_reconcile_misses_total");
      this.logger.warn(
        `[${abbreviateAddress(tracked.state.address)}] block listing missed a transaction; reconciled`,
      );
    }
    tracked.reconcilingFrom = undefined;
  }
}
