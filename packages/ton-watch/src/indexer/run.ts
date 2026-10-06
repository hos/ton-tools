/**
 * One start…stop cycle of the indexer, as seen by the work started in it. A stop
 * first requests the stop (`stopRequested`: start nothing new and retry nothing),
 * then, once the grace period (`stopTimeoutMs`) is over, aborts `signal`, which
 * every source call of the cycle carries, so what is still in flight is abandoned.
 */
export class Run {
  private readonly controller = new AbortController();
  private stopping = false;

  /** Passed to every source call; aborted when in-flight work is abandoned. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Set as soon as a stop is requested: start no new work, schedule no retry. */
  get stopRequested(): boolean {
    return this.stopping;
  }

  requestStop(): void {
    this.stopping = true;
  }

  /** Abandons the cycle's in-flight source calls. Implies `requestStop()`. */
  abandon(): void {
    this.stopping = true;
    this.controller.abort();
  }
}
