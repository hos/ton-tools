import type { Metrics } from "../metrics/metrics";
import { isParked, type Walk, type WalkRange } from "./walk";

/** Consecutive failures after which a walk no longer holds up `hasPendingWork()`. */
const FAILURES_BEFORE_IGNORED_BY_DRAIN = 5;

/**
 * Holds every walk and runs their pages under one shared concurrency limit:
 * head walks first (fresh data), then whichever has waited longest. A walk runs
 * one page at a time; `runPage` advances, finishes or reschedules it.
 *
 * `stop()` pauses it: pages in flight finish, but no new page starts and no retry
 * timer is armed until `resume()`. `abandonRunning()` gives up on the pages in
 * flight.
 */
export class WalkScheduler {
  private readonly walks = new Map<number, Walk>();
  private lastWalkId = 0;
  /** Pages in flight, by walk; a page abandoned by `abandonRunning()` is no longer here. */
  private readonly running = new Set<Walk>();
  private stopped = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly runPage: (walk: Walk) => Promise<void>,
    private readonly metrics: Metrics,
  ) {}

  /** Schedules a new walk and starts it right away if there is capacity. */
  add(range: WalkRange, options: { split?: boolean } = {}): Walk {
    const walk: Walk = {
      ...range,
      id: ++this.lastWalkId,
      pages: 0,
      fetched: 0,
      split: options.split ?? false,
      failures: 0,
      notBefore: 0,
      running: false,
    };
    this.walks.set(walk.id, walk);
    this.metrics.inc("ton_watch_walks_started_total", { kind: range.kind });
    this.pump();
    return walk;
  }

  remove(walk: Walk): void {
    this.walks.delete(walk.id);
  }

  /** Whether the walk is still scheduled (not finished or dropped). */
  has(walk: Walk): boolean {
    return this.walks.has(walk.id);
  }

  all(): Walk[] {
    return [...this.walks.values()];
  }

  forAddress(address: string): Walk[] {
    return this.all().filter((walk) => walk.address === address);
  }

  hasWalks(address: string): boolean {
    return this.all().some((walk) => walk.address === address);
  }

  /** Whether some walk of the address will fetch the transaction at `lt`. */
  covers(address: string, lt: bigint): boolean {
    return this.all().some(
      (walk) => walk.address === address && walk.floorLt < lt && lt <= walk.topLt,
    );
  }

  /** Highest `topLt` among the address's walks, or `atLeast` if that is higher. */
  highestTopLt(address: string, atLeast: bigint): bigint {
    let top = atLeast;
    for (const walk of this.walks.values()) {
      if (walk.address === address && walk.topLt > top) top = walk.topLt;
    }
    return top;
  }

  /**
   * Drops all walks of the address. A page in flight still completes, but its
   * walk is no longer scheduled, so it does not continue (see `has()`).
   */
  dropAddress(address: string): void {
    for (const [id, walk] of this.walks) {
      if (walk.address === address) this.walks.delete(id);
    }
  }

  /** True while a page is in flight or a walk is still worth retrying soon. */
  hasPendingWork(): boolean {
    const pending = this.all().some(
      (walk) =>
        walk.running || (!isParked(walk) && walk.failures < FAILURES_BEFORE_IGNORED_BY_DRAIN),
    );
    return pending || this.running.size > 0;
  }

  /** Whether `stop()` was called and not undone by `resume()`. */
  get isStopped(): boolean {
    return this.stopped;
  }

  get pagesInFlight(): number {
    return this.running.size;
  }

  /** Resolves when no page is in flight, or after `timeoutMs` if given. */
  whenIdle(timeoutMs?: number): Promise<void> {
    return new Promise((resolve) => {
      if (timeoutMs === undefined) {
        this.idleWaiters.push(resolve);
        return;
      }
      const timer = setTimeout(resolve, timeoutMs);
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Starts pages until the concurrency limit is reached or nothing is ready. */
  pump(): void {
    if (this.stopped) return;
    // One clock reading for both decisions: a walk not ready yet at `now` must
    // get a timer, even if its delay elapses while this runs.
    const now = Date.now();
    while (this.running.size < this.concurrency) {
      const walk = this.nextReady(now);
      if (!walk) break;
      walk.running = true;
      this.running.add(walk);
      void this.runPage(walk).finally(() => {
        // Abandoned meanwhile: already accounted for.
        if (!this.running.delete(walk)) return;
        walk.running = false;
        this.pump();
        if (this.running.size === 0) this.notifyIdle();
      });
    }
    this.armWakeTimer(now);
  }

  /** Starts no further pages and cancels the retry timer; pages in flight still finish. */
  stop(): void {
    this.stopped = true;
    this.clearWakeTimer();
  }

  /**
   * Gives up on every page in flight: their walks are dropped (like `dropAddress`,
   * so a page that still completes later neither stores nor continues anything)
   * and they no longer count as in flight. What those walks had left is found
   * again as gaps (once their addresses are scanned), or as a new head walk.
   * Returns the abandoned walks.
   */
  abandonRunning(): Walk[] {
    const abandoned = [...this.running];
    for (const walk of abandoned) this.walks.delete(walk.id);
    this.running.clear();
    if (abandoned.length > 0) this.notifyIdle();
    return abandoned;
  }

  /** Undoes `stop()` and starts whatever is ready. */
  resume(): void {
    this.stopped = false;
    this.pump();
  }

  private nextReady(now: number): Walk | null {
    let best: Walk | null = null;
    for (const walk of this.walks.values()) {
      if (walk.running || walk.notBefore > now) continue;
      if (
        !best ||
        (walk.kind === "head" && best.kind !== "head") ||
        (walk.kind === best.kind && walk.notBefore < best.notBefore)
      ) {
        best = walk;
      }
    }
    return best;
  }

  /** Wakes `pump()` when the earliest waiting walk becomes ready. */
  private armWakeTimer(now: number): void {
    this.clearWakeTimer();
    let soonest = Number.POSITIVE_INFINITY;
    for (const walk of this.walks.values()) {
      if (!walk.running && walk.notBefore > now) soonest = Math.min(soonest, walk.notBefore);
    }
    if (soonest !== Number.POSITIVE_INFINITY) {
      this.wakeTimer = setTimeout(() => this.pump(), Math.max(1, soonest - Date.now()));
      this.wakeTimer.unref?.();
    }
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
