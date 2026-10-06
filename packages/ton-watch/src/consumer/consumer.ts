import { EventEmitter } from "node:events";

import { type AddressInput, abbreviateAddress, toRawAddress } from "../core/address";
import { errorMessage, TonWatchError } from "../core/errors";
import {
  type AddressState,
  type IndexedTx,
  type TxRecord,
  toIndexedTx,
  watermarkOf,
} from "../core/types";
import { Metrics } from "../metrics/metrics";
import type {
  ConsumerLock,
  CursorState,
  DeadLetter,
  DeadLetterFilter,
} from "../stores/consumer-state";
import { runAtomically, type Store } from "../stores/store";
import { SerialQueue } from "../util/async";
import { exponentialBackoff } from "../util/backoff";
import { type Logger, silentLogger } from "../util/logger";
import { rewindCursors } from "./cursors";
import { ConsumerLockedError, CursorConflictError } from "./errors";
import { measureLag, recordLagGauges } from "./lag";
import { lockConsumer, tryLockConsumer } from "./lock";
import { type ConsumerSettings, resolveSettings } from "./options";
import { earliestBuffered, type ReadBuffer } from "./read-buffer";
import type {
  ConsumerEventMap,
  ConsumerLag,
  ConsumerStatus,
  ConsumerWakeEvents,
  HandlerContext,
  ProcessOptions,
  RewindOptions,
  RewindTarget,
  TxHandler,
} from "./types";

/** Delivery state of one address for this consumer. */
interface Lane {
  address: string;
  /** Lt of the last delivered transaction; null until read from the store. */
  cursor: bigint | null;
  /** Failed attempts on the transaction after the cursor. */
  failures: number;
  /** Halted until this time (ms) after a handler failure. */
  notBefore: number;
  lastError?: unknown;
}

/** What became of one transaction handed to the handler. */
type Outcome = "delivered" | "given-up" | "halted";

/** One `start()`…`stop()` cycle. */
interface Run {
  /** The lock it delivers under; null while waiting for it (or after losing it). */
  lock: ConsumerLock | null;
  loop: Promise<void>;
}

/**
 * Where a consumer is in its lifecycle. `start()` and `stop()` queue transitions
 * that run one at a time: stopped → starting (taking the lock) → running →
 * stopping (ending the round, releasing the lock) → stopped.
 */
type Lifecycle =
  | { phase: "stopped" }
  | { phase: "starting" }
  | { phase: "running"; run: Run }
  | { phase: "stopping"; run: Run };

/** What a delivery round runs under. It ends early once `shouldContinue` says so. */
interface Round {
  lock: ConsumerLock;
  /** The started run the round belongs to; null for `runOnce()` outside `start()`. */
  run: Run | null;
  /** A cursor write found the cursor moved by someone else. */
  conflict: boolean;
}

/**
 * What a `Consumer` is wired to besides its store; `TonWatch` passes its own.
 * @experimental
 */
export interface ConsumerDeps {
  /** Wake up on these instead of waiting for the next poll. */
  events?: ConsumerWakeEvents;
  logger?: Logger;
  metrics?: Metrics;
}

/**
 * Hands indexed transactions to a handler strictly in chain order, never past a
 * gap, and persists the position after each one so restarts resume where they
 * stopped. A failing handler stops its address (or, in global order, the whole
 * stream) and is retried with backoff; with `onError: "skip"` or `"dead-letter"`
 * it is given up on after `maxAttempts`, or at once if `isRetryable` says so.
 *
 * Only one instance of a consumer name delivers at a time: rounds run under the
 * store's consumer lock (see `ProcessOptions.lock`).
 *
 * Emits `handlerError`, `skip` and `deadLetter` (see `ConsumerEventMap`).
 *
 * Get one from `TonWatch.process()`. Constructing one directly (exported from
 * `ton-watch/advanced`) is experimental.
 */
export class Consumer<Db = unknown> extends EventEmitter<ConsumerEventMap> {
  readonly name: string;
  private readonly store: Store<Db>;
  /**
   * Stored as `TxHandler<never>` so that `Consumer<PgQueryable>` is still a
   * `Consumer` (a function-typed field would make `Db` invariant); see `handle`.
   */
  private readonly handler: TxHandler<never>;
  private readonly settings: ConsumerSettings;
  /** Raw addresses to deliver; null for all. */
  private readonly onlyAddresses: Set<string> | null;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly events: ConsumerWakeEvents | undefined;
  private readonly lanes = new Map<string, Lane>();
  /** Lanes mirror the store only while the lock is held without a break; false = reload. */
  private lanesLoaded = false;
  /** Rounds and rewinds, one at a time. */
  private readonly serial = new SerialQueue();
  /** Pending requests for the current round to end early (a rewind waiting for it). */
  private yieldRequests = 0;
  private lifecycle: Lifecycle = { phase: "stopped" };
  /** Whether the latest `start()` / `stop()` call was a start. */
  private wanted = false;
  /** Lifecycle transitions, one at a time. */
  private readonly transitions = new SerialQueue();
  /** The latest `start()`'s lock attempt, for `ready()`. */
  private startAttempt: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  /** Something changed while a round was running: start another right away. */
  private wakePending = false;
  private delivered = 0;
  private lastLag: ConsumerLag | null = null;
  private lagMeasuredAt = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    name: string,
    store: Store<Db>,
    handler: TxHandler<Db>,
    options: ProcessOptions = {},
    deps: ConsumerDeps = {},
  ) {
    super();
    this.name = name;
    this.store = store;
    this.handler = handler;
    this.onlyAddresses = options.addresses ? new Set(options.addresses.map(toRawAddress)) : null;
    this.settings = resolveSettings(options);
    this.logger = deps.logger ?? silentLogger;
    this.metrics = deps.metrics ?? new Metrics();
    this.events = deps.events;
  }

  /**
   * Takes the consumer lock and starts delivering in the background. Await
   * `ready()` to learn whether it got the lock. Calling it while started does
   * nothing; while a `stop()` is finishing, it starts again once that is done.
   */
  start(): this {
    if (this.wanted) return this;
    this.wanted = true;
    const attempt = this.transitions.run(() => this.begin());
    attempt.catch((error: unknown) => {
      this.logger.error(`consumer ${this.name}: not started:`, errorMessage(error));
    });
    this.startAttempt = attempt;
    return this;
  }

  /**
   * Settles once `start()` made its first attempt at the lock: rejects with
   * `ConsumerLockedError` if another instance holds it (`lock: "fail"`), otherwise
   * resolves — delivering, or with `lock: "wait"` waiting for the lock.
   */
  ready(): Promise<void> {
    return this.startAttempt ?? Promise.resolve();
  }

  /**
   * Stops after the transaction being handled (if any) is committed, then releases
   * the lock. Resolves once stopped; a `start()` still taking the lock is undone.
   */
  stop(): Promise<void> {
    this.wanted = false;
    // End the round in progress now, not only once the transition gets its turn.
    if (this.lifecycle.phase === "running") {
      this.lifecycle = { phase: "stopping", run: this.lifecycle.run };
      this.wake();
    }
    return this.transitions.run(() => this.end());
  }

  /** Looks for new transactions now instead of at the next poll. */
  wake(): void {
    this.wakePending = true;
    this.wakeUp?.();
  }

  status(): ConsumerStatus {
    const now = Date.now();
    const { lifecycle } = this;
    return {
      name: this.name,
      running: lifecycle.phase === "running",
      waitingForLock: lifecycle.phase === "running" && !lifecycle.run.lock?.held,
      delivered: this.delivered,
      lag: this.lastLag,
      addresses: [...this.lanes.values()].map((lane) => ({
        address: lane.address,
        cursor: lane.cursor,
        halted: lane.notBefore > now,
        failures: lane.failures,
        lastError: lane.lastError ? errorMessage(lane.lastError) : undefined,
      })),
    };
  }

  /**
   * Runs one delivery round. Resolves to the number of transactions the cursors
   * moved past (delivered, skipped or dead-lettered). Outside `start()` it takes
   * the consumer lock for the round and releases it afterwards. Rejects with
   * `CursorConflictError` if a cursor was moved by someone else meanwhile (the
   * next round resumes from there).
   */
  runOnce(): Promise<number> {
    return this.serial.run(() =>
      this.whileLocked(this.settings.lock, (lock) =>
        this.round({ lock, run: this.activeRun(), conflict: false }),
      ),
    );
  }

  /**
   * Measures how far behind the consumer is (see `ConsumerLag`) and publishes it as
   * `status().lag` and the `ton_watch_consumer_lag_*` gauges.
   */
  async lag(): Promise<ConsumerLag> {
    const lag = await measureLag(this.store, this.name, this.settings.order);
    this.lastLag = lag;
    this.lagMeasuredAt = Date.now();
    recordLagGauges(this.metrics, this.name, lag);
    return lag;
  }

  /**
   * Moves the cursors to `to` (on `addresses`, default all the consumer has) and
   * clears their failure counts. A running consumer applies it between rounds: the
   * current round ends after the transaction being handled. Rejects with
   * `ConsumerLockedError` if another instance runs. Dead letters are kept.
   */
  async rewind(to: RewindTarget, options: RewindOptions = {}): Promise<void> {
    this.yieldRequests++;
    let yielding = true;
    const stopYielding = () => {
      if (yielding) this.yieldRequests--;
      yielding = false;
    };
    try {
      await this.serial.run(async () => {
        stopYielding();
        await this.whileLocked("fail", () =>
          rewindCursors(this.store, this.name, to, options.addresses?.map(toRawAddress)),
        );
        this.lanes.clear();
        this.lanesLoaded = false;
      });
    } finally {
      stopYielding();
    }
    this.wake();
  }

  /** This consumer's dead letters, oldest first. */
  deadLetters(filter: Omit<DeadLetterFilter, "consumer"> = {}): Promise<DeadLetter[]> {
    const address = filter.address === undefined ? undefined : toRawAddress(filter.address);
    return this.store.listDeadLetters({ ...filter, address, consumer: this.name });
  }

  /** Deletes a dead letter without redelivering it. False if there was none. */
  discardDeadLetter(address: AddressInput, lt: bigint): Promise<boolean> {
    return this.store.deleteDeadLetter(this.name, toRawAddress(address), lt);
  }

  /**
   * Hands a dead-lettered transaction to the handler again (`ctx.replay` is true),
   * then deletes the dead letter — atomically with the handler's `ctx.db` writes
   * when transactional. It is out of order by nature and may run alongside live
   * delivery. If the handler throws, the dead letter stays (with the new error)
   * and the error is rethrown — unless it was discarded meanwhile, which stands.
   *
   * Rejects with code `DEAD_LETTER_NOT_FOUND` if there is no such dead letter (or it
   * was discarded during the replay), `TRANSACTION_NOT_FOUND` if the transaction is
   * no longer stored.
   */
  async replayDeadLetter(addressInput: AddressInput, lt: bigint): Promise<void> {
    const address = toRawAddress(addressInput);
    const [letter] = await this.store.listDeadLetters({ consumer: this.name, address, lt });
    if (!letter) {
      throw new TonWatchError(
        "DEAD_LETTER_NOT_FOUND",
        `consumer ${this.name} has no dead letter at ${address} lt ${lt}`,
      );
    }
    const [record] = await this.store.read(address, lt - 1n, lt, 1);
    if (!record?.hash.equals(letter.hash)) {
      throw new TonWatchError(
        "TRANSACTION_NOT_FOUND",
        `transaction ${address} lt ${lt} is no longer stored`,
      );
    }
    const resolvedElsewhere = new TonWatchError(
      "DEAD_LETTER_NOT_FOUND",
      `dead letter ${address} lt ${lt} was discarded meanwhile`,
    );
    try {
      await this.withDeliveryStore(async (store, db) => {
        await this.handle(toIndexedTx(record), {
          consumer: this.name,
          address,
          db,
          replay: true,
        });
        if (!(await store.deleteDeadLetter(this.name, address, lt))) throw resolvedElsewhere;
      });
    } catch (error) {
      if (error !== resolvedElsewhere) {
        await this.store.updateDeadLetter({
          ...letter,
          error: errorMessage(error),
          attempts: letter.attempts + 1,
          lastFailureAt: new Date(),
        });
      }
      throw error;
    }
    this.metrics.inc("ton_watch_consumer_replayed_total", { consumer: this.name });
  }

  /** The run that is delivering (not stopping), if any. */
  private activeRun(): Run | null {
    return this.lifecycle.phase === "running" ? this.lifecycle.run : null;
  }

  /** Transition to running, unless a `stop()` came after the `start()`. */
  private async begin(): Promise<void> {
    if (!this.wanted || this.lifecycle.phase !== "stopped") return;
    this.lifecycle = { phase: "starting" };
    let lock: ConsumerLock | null;
    try {
      lock = await tryLockConsumer(this.store, this.name);
      if (!lock && this.settings.lock === "fail") throw new ConsumerLockedError(this.name);
    } catch (error) {
      this.lifecycle = { phase: "stopped" };
      this.wanted = false;
      throw error;
    }
    if (!this.wanted) {
      this.lifecycle = { phase: "stopped" };
      await this.releaseLock(lock);
      return;
    }
    const run: Run = { lock, loop: Promise.resolve() };
    this.lifecycle = { phase: "running", run };
    this.lanesLoaded = false;
    this.subscribe();
    run.loop = this.runLoop(run);
  }

  /** Transition to stopped: ends the loop, then releases the run's lock (once). */
  private async end(): Promise<void> {
    const { lifecycle } = this;
    if (lifecycle.phase !== "running" && lifecycle.phase !== "stopping") return;
    const { run } = lifecycle;
    this.lifecycle = { phase: "stopping", run };
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.wake();
    await run.loop;
    const lock = run.lock;
    run.lock = null;
    await this.releaseLock(lock);
    this.lifecycle = { phase: "stopped" };
  }

  private subscribe(): void {
    const events = this.events;
    if (!events || this.unsubscribe) return;
    const wake = () => this.wake();
    events.on("frontier", wake);
    events.on("synced", wake);
    this.unsubscribe = () => {
      events.off("frontier", wake);
      events.off("synced", wake);
    };
  }

  private async releaseLock(lock: ConsumerLock | null): Promise<void> {
    await lock?.release().catch((error: unknown) => {
      this.logger.warn(`consumer ${this.name}: releasing its lock failed:`, errorMessage(error));
    });
  }

  /**
   * Runs `fn` under the consumer lock: the one a started consumer holds, or one
   * taken for this call only.
   */
  private async whileLocked<T>(
    mode: "fail" | "wait",
    fn: (lock: ConsumerLock) => Promise<T>,
  ): Promise<T> {
    const held = this.activeRun()?.lock;
    if (held?.held) return fn(held);
    const lock = await lockConsumer(this.store, this.name, mode, this.settings.pollMs);
    // Another instance may have delivered while we did not hold the lock.
    this.lanesLoaded = false;
    try {
      return await fn(lock);
    } finally {
      await lock.release();
    }
  }

  /** The run's lock, re-taken if it was lost; null while another instance has it. */
  private async ensureLock(run: Run): Promise<ConsumerLock | null> {
    if (run.lock?.held) return run.lock;
    if (run.lock) {
      this.logger.warn(`consumer ${this.name}: lost its lock (connection closed), re-taking it`);
      const lost = run.lock;
      run.lock = null;
      await this.releaseLock(lost);
    }
    try {
      run.lock = await tryLockConsumer(this.store, this.name);
    } catch (error) {
      this.logger.warn(`consumer ${this.name}: taking its lock failed:`, errorMessage(error));
    }
    // Another instance may have delivered while we did not hold the lock.
    if (run.lock) this.lanesLoaded = false;
    return run.lock;
  }

  /**
   * A round keeps delivering while its lock is held, no cursor conflict occurred,
   * nothing (a rewind) waits for it, and — once started — until `stop()`.
   */
  private shouldContinue(round: Round): boolean {
    return (
      round.lock.held &&
      !round.conflict &&
      this.yieldRequests === 0 &&
      (round.run === null || this.activeRun() === round.run)
    );
  }

  private async runLoop(run: Run): Promise<void> {
    while (this.activeRun() === run) {
      const lock = await this.ensureLock(run);
      if (!lock) {
        await this.sleepUntilWoken(this.settings.pollMs);
        continue;
      }
      this.wakePending = false;
      let advanced = 0;
      try {
        advanced = await this.serial.run(() => this.round({ lock, run, conflict: false }));
      } catch (error) {
        this.logger.warn(`consumer ${this.name}: round failed:`, errorMessage(error));
      }
      await this.measureLagIfDue();
      if (this.activeRun() !== run) break;
      if (advanced > 0 || this.wakePending) continue;
      await this.sleepUntilWoken(Math.min(this.settings.pollMs, this.msUntilNextRetry()));
    }
  }

  private async measureLagIfDue(): Promise<void> {
    const interval = this.settings.lagIntervalMs;
    if (interval === 0 || Date.now() - this.lagMeasuredAt < interval) return;
    try {
      await this.lag();
    } catch (error) {
      this.lagMeasuredAt = Date.now();
      this.logger.warn(`consumer ${this.name}: measuring lag failed:`, errorMessage(error));
    }
  }

  /** Time until the earliest halted lane may retry; Infinity if none is halted. */
  private msUntilNextRetry(): number {
    const now = Date.now();
    const halted = [...this.lanes.values()].filter((lane) => lane.notBefore > now);
    if (halted.length === 0) return Number.POSITIVE_INFINITY;
    return Math.min(...halted.map((lane) => lane.notBefore)) - Date.now();
  }

  private async sleepUntilWoken(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(1, ms));
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wakeUp = null;
  }

  private async round(round: Round): Promise<number> {
    const states = (await this.store.listAddresses()).filter(
      (state) => !this.onlyAddresses || this.onlyAddresses.has(state.address),
    );
    await this.syncLanes(states);
    return this.settings.order === "global"
      ? this.deliverGlobal(states, round)
      : this.deliverPerAddress(states, round);
  }

  /**
   * Creates lanes for new addresses and drops those of addresses no longer
   * delivered (removed), so their halts hold nothing back. After the lock was
   * (re)taken, first reloads every cursor and failure count from the store; a halt
   * survives the reload if its cursor did not move.
   */
  private async syncLanes(states: AddressState[]): Promise<void> {
    let stored: Map<string, CursorState> | null = null;
    if (!this.lanesLoaded) {
      await this.store.saveConsumer(this.name, this.settings.order);
      const cursors = await this.store.listCursors(this.name);
      stored = new Map(cursors.map((cursor) => [cursor.address, cursor]));
    }
    const previous = stored ? new Map(this.lanes) : null;
    if (stored) {
      this.lanes.clear();
      this.lanesLoaded = true;
    } else {
      const current = new Set(states.map((state) => state.address));
      for (const address of this.lanes.keys()) {
        if (!current.has(address)) this.lanes.delete(address);
      }
    }
    for (const { address } of states) {
      if (this.lanes.has(address)) continue;
      const cursor = stored?.get(address);
      const before = previous?.get(address);
      this.lanes.set(address, {
        address,
        cursor: cursor?.lt ?? null,
        failures: cursor?.attempts ?? 0,
        notBefore: before && before.cursor === cursor?.lt ? before.notBefore : 0,
        lastError: cursor?.lastError ?? undefined,
      });
    }
  }

  /** The lane's position, loading or initializing (and persisting) it on first use. */
  private async cursorFor(lane: Lane, state: AddressState): Promise<bigint> {
    if (lane.cursor !== null) return lane.cursor;
    let cursor = await this.store.getCursor(this.name, state.address);
    if (cursor === null) {
      // Persist so a restart does not re-resolve "now" to a later point.
      const initial = this.initialCursor(state);
      const created = await this.store.compareAndSetCursor(this.name, state.address, null, initial);
      // Created by someone else first: theirs stands.
      cursor = created
        ? initial
        : ((await this.store.getCursor(this.name, state.address)) ?? initial);
    }
    lane.cursor = cursor;
    return cursor;
  }

  /**
   * Where a new lane begins. "now" is resolved (and persisted) the first round the
   * consumer sees the address, also before anything is indexed for it, so it means
   * "indexed after the consumer started" in either order.
   */
  private initialCursor(state: AddressState): bigint {
    const { from } = this.settings;
    if (from === "earliest") return state.startLt;
    if (from === "now") return state.frontier?.lt ?? state.startLt;
    return from;
  }

  private handle(tx: IndexedTx, ctx: HandlerContext<Db>): Promise<void> | void {
    return (this.handler as TxHandler<Db>)(tx, ctx);
  }

  /** Runs `fn` in a store transaction if the consumer is transactional and the store has them. */
  private withDeliveryStore<T>(fn: (store: Store<Db>, db?: Db) => Promise<T>): Promise<T> {
    if (this.settings.transactional && this.store.transaction) {
      return this.store.transaction(({ store, db }) => fn(store, db));
    }
    return fn(this.store);
  }

  /**
   * Hands one transaction to the handler and commits the cursor. A cursor
   * conflict ends the round and makes the next one reload every lane.
   */
  private async deliver(lane: Lane, record: TxRecord, round: Round): Promise<Outcome> {
    try {
      return await this.attempt(lane, record);
    } catch (error) {
      if (error instanceof CursorConflictError) {
        round.conflict = true;
        this.lanesLoaded = false;
      }
      throw error;
    }
  }

  private async attempt(lane: Lane, record: TxRecord): Promise<Outcome> {
    const tx = toIndexedTx(record);
    try {
      await this.withDeliveryStore(async (store, db) => {
        await this.handle(tx, { consumer: this.name, address: lane.address, db, replay: false });
        await this.moveCursor(store, lane, record.lt);
      });
    } catch (error) {
      if (error instanceof CursorConflictError) throw error;
      return this.handleFailure(lane, record, error);
    }
    this.advance(lane, record.lt);
    this.delivered++;
    this.metrics.inc("ton_watch_consumer_delivered_total", { consumer: this.name });
    return "delivered";
  }

  /**
   * Moves the stored cursor from where this lane last saw it to `lt`; throws
   * `CursorConflictError` (rolling back the enclosing transaction) if it is not
   * there any more.
   */
  private async moveCursor(store: Store<Db>, lane: Lane, lt: bigint): Promise<void> {
    if (!(await store.compareAndSetCursor(this.name, lane.address, lane.cursor, lt))) {
      throw new CursorConflictError(this.name, lane.address, lane.cursor);
    }
  }

  private advance(lane: Lane, lt: bigint): void {
    lane.cursor = lt;
    lane.failures = 0;
    lane.notBefore = 0;
    lane.lastError = undefined;
  }

  /**
   * Counts the failure, then halts the lane or, past `maxAttempts` or on a
   * non-retryable error, gives up on the transaction.
   */
  private async handleFailure(lane: Lane, record: TxRecord, error: unknown): Promise<Outcome> {
    const message = errorMessage(error);
    const stored = await this.store.recordFailure(this.name, lane.address, message);
    const attempts = Math.max(stored?.attempts ?? 0, lane.failures + 1);
    lane.failures = attempts;
    lane.lastError = error;
    const { onError, maxAttempts, isRetryable } = this.settings;
    const giveUp = onError !== "retry" && (attempts >= maxAttempts || !isRetryable(error));
    this.metrics.inc("ton_watch_consumer_errors_total", { consumer: this.name });
    this.emit("handlerError", {
      consumer: this.name,
      address: lane.address,
      lt: record.lt,
      hash: record.hash,
      error,
      attempts,
      action: giveUp ? onError : "retry",
    });
    if (!giveUp) {
      this.halt(lane, record, error);
      return "halted";
    }
    const now = new Date();
    await this.giveUp(lane, {
      consumer: this.name,
      address: lane.address,
      lt: record.lt,
      hash: record.hash,
      error: message,
      attempts,
      firstFailureAt: stored?.firstFailureAt ?? now,
      lastFailureAt: stored?.lastFailureAt ?? now,
    });
    return "given-up";
  }

  /** Moves past a failing transaction, recording it as a dead letter first if so configured. */
  private async giveUp(lane: Lane, letter: DeadLetter): Promise<void> {
    const deadLetter = this.settings.onError === "dead-letter";
    await runAtomically(this.store, async (store) => {
      if (deadLetter) await store.putDeadLetter(letter);
      await this.moveCursor(store, lane, letter.lt);
    });
    this.advance(lane, letter.lt);
    const labels = { consumer: this.name };
    if (deadLetter) {
      this.metrics.inc("ton_watch_consumer_dead_letters_total", labels);
      this.emit("deadLetter", letter);
    } else {
      this.metrics.inc("ton_watch_consumer_skipped_total", labels);
      this.emit("skip", letter);
    }
    this.logger.warn(
      `consumer ${this.name} [${abbreviateAddress(lane.address)}] ${deadLetter ? "dead-lettered" : "skipped"} lt ${letter.lt} after ${letter.attempts} attempt(s):`,
      letter.error,
    );
  }

  private halt(lane: Lane, record: TxRecord, error: unknown): void {
    const delay = exponentialBackoff(
      lane.failures,
      this.settings.retryMinMs,
      this.settings.retryMaxMs,
    );
    lane.notBefore = Date.now() + delay;
    this.logger.warn(
      `consumer ${this.name} [${abbreviateAddress(lane.address)}] failed at lt ${record.lt} (attempt ${lane.failures}), retry in ${Math.round(delay / 1000)}s:`,
      errorMessage(error),
    );
  }

  /**
   * Each address up to its own frontier, `concurrency` addresses at a time. The
   * round ends only once every worker has stopped, so no lane is ever delivered by
   * two rounds at once; a store error fails the round after that.
   */
  private async deliverPerAddress(states: AddressState[], round: Round): Promise<number> {
    const now = Date.now();
    const ready = states.filter((state) => this.lanes.get(state.address)!.notBefore <= now);
    let total = 0;
    let next = 0;
    const worker = async () => {
      while (this.shouldContinue(round)) {
        const state = ready[next++];
        if (!state) return;
        // Not `total += await …`: that reads `total` before the await and loses
        // what the other workers added meanwhile.
        const advanced = await this.deliverLane(this.lanes.get(state.address)!, state, round);
        total += advanced;
      }
    };
    const workers = Math.min(this.settings.concurrency, ready.length);
    const results = await Promise.allSettled(Array.from({ length: workers }, worker));
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
    return total;
  }

  /** One batch of one address, up to its frontier. Resolves to the number moved past. */
  private async deliverLane(lane: Lane, state: AddressState, round: Round): Promise<number> {
    const cursor = await this.cursorFor(lane, state);
    const uptoLt = state.frontier?.lt;
    if (uptoLt === undefined || cursor >= uptoLt) return 0;
    const batch = await this.store.read(state.address, cursor, uptoLt, this.settings.batchSize);
    let advanced = 0;
    for (const record of batch) {
      if (!this.shouldContinue(round)) break;
      if ((await this.deliver(lane, record, round)) === "halted") break;
      advanced++;
    }
    return advanced;
  }

  /**
   * All addresses merged by (lt, address), up to the watermark: the lowest point
   * up to which every address is known complete. Any halted address halts all;
   * a transaction given up on (skip / dead letter) does not.
   */
  private async deliverGlobal(states: AddressState[], round: Round): Promise<number> {
    const watermark = watermarkOf(states);
    if (watermark === null) return 0;
    const now = Date.now();
    if ([...this.lanes.values()].some((lane) => lane.notBefore > now)) return 0;
    // Exact below 2^53; see the metric's help in `METRICS`.
    this.metrics.set("ton_watch_consumer_watermark_lt", Number(watermark), {
      consumer: this.name,
    });

    const buffers = new Map<string, ReadBuffer>();
    const fill = async (state: AddressState) => {
      const lane = this.lanes.get(state.address)!;
      const cursor = await this.cursorFor(lane, state);
      const items =
        cursor < watermark
          ? await this.store.read(state.address, cursor, watermark, this.settings.batchSize)
          : [];
      buffers.set(state.address, {
        state,
        items,
        exhausted: items.length < this.settings.batchSize,
      });
    };
    await Promise.all(states.map(fill));

    let total = 0;
    while (this.shouldContinue(round)) {
      const buffer = earliestBuffered(states, buffers);
      if (!buffer) break;
      const record = buffer.items[0]!;
      if ((await this.deliver(this.lanes.get(record.address)!, record, round)) === "halted") break;
      total++;
      buffer.items.shift();
      if (buffer.items.length === 0 && !buffer.exhausted) await fill(buffer.state);
    }
    return total;
  }
}
