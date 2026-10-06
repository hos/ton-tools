import { classifyError, type ErrorKind, errorMessage, SourceError } from "../../core/errors";
import { Metrics } from "../../metrics/metrics";
import { abortable, sleep } from "../../util/async";
import { exponentialBackoff, withJitter } from "../../util/backoff";
import { type Logger, silentLogger } from "../../util/logger";
import { assertPositiveInteger, invalidOption } from "../../util/validate";

/** One server a `ServerPool` can send calls to. */
export interface PoolMember<C> {
  id: string;
  client: C;
  /** Archival servers are only asked after a regular one could not serve the data. */
  archive?: boolean;
  isReady?: () => boolean;
}

export interface ServerPoolOptions {
  /** Requests in flight per server. Default 4. */
  maxInFlightPerServer?: number;
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
  /** Failed attempts (other than archive misses) before giving up on a call. Default 6. */
  maxAttempts?: number;
  /** Cap for the per-server cooldown after rate limits and failures. Default 30s. */
  maxCooldownMs?: number;
  metrics?: Metrics;
  logger?: Logger;
}

/** A pool member with its live load and health bookkeeping. */
export interface ServerState<C> extends PoolMember<C> {
  inFlight: number;
  cooldownUntil: number;
  /** Consecutive rate-limit responses. */
  rateLimits: number;
  /** Consecutive timeouts / network errors / not-ready answers. */
  failures: number;
  /** Smoothed response time. */
  latencyMs: number;
  calls: number;
  errors: Partial<Record<ErrorKind, number>>;
}

/** Point-in-time view of one server, for status pages. */
export interface ServerStats {
  id: string;
  archive: boolean;
  ready: boolean;
  inFlight: number;
  latencyMs: number;
  calls: number;
  coolingDownMs: number;
  errors: Partial<Record<ErrorKind, number>>;
}

const DEFAULT_MAX_IN_FLIGHT_PER_SERVER = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_COOLDOWN_MS = 30_000;

/** Latency assumed for a server before its first answer. */
const INITIAL_LATENCY_MS = 200;
/** Weight of the newest sample in the latency moving average. */
const LATENCY_SMOOTHING = 0.2;
/** Random spread applied to server scores so equal servers share the load. */
const SCORE_JITTER = 0.1;
/** First cooldown after a rate limit / failure; doubles with each repeat. */
const COOLDOWN_MIN_MS = 500;
/** Re-check interval while no server is connected. */
const NO_SERVER_POLL_MS = 100;
/** Longest wait for a free slot before re-evaluating the servers. */
const BUSY_WAIT_MS = 1_000;
const MIN_COOLDOWN_WAIT_MS = 5;

const isReady = (server: PoolMember<unknown>) => server.isReady?.() ?? true;

/**
 * Spreads calls over a set of servers: least-loaded/fastest first, a bounded number
 * of requests per server, and per-kind error handling:
 *
 * - `rate_limit`: the server cools down (exponential, capped) and the call moves on.
 * - `timeout`/`network`: short cooldown, retry elsewhere.
 * - `archive_unavailable`/`bad_response`: that server is skipped for this call; once
 *   every regular server has failed, archival servers are tried.
 */
export class ServerPool<C> {
  readonly members: ServerState<C>[];
  readonly metrics: Metrics;
  private readonly maxInFlight: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxCooldownMs: number;
  private readonly logger: Logger;
  private slotWaiters: (() => void)[] = [];

  constructor(members: PoolMember<C>[], options: ServerPoolOptions = {}) {
    if (members.length === 0) throw invalidOption("servers", "must contain at least one server");
    this.members = members.map((member) => ({
      ...member,
      inFlight: 0,
      cooldownUntil: 0,
      rateLimits: 0,
      failures: 0,
      latencyMs: INITIAL_LATENCY_MS,
      calls: 0,
      errors: {},
    }));
    this.maxInFlight = options.maxInFlightPerServer ?? DEFAULT_MAX_IN_FLIGHT_PER_SERVER;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxCooldownMs = options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
    assertPositiveInteger("maxInFlightPerServer", this.maxInFlight);
    assertPositiveInteger("maxAttempts", this.maxAttempts);
    this.metrics = options.metrics ?? new Metrics();
    this.logger = options.logger ?? silentLogger;
  }

  /** Requests the regular (non-archival) servers can have in flight at once. */
  get capacity(): number {
    return this.members.filter((member) => !member.archive).length * this.maxInFlight;
  }

  stats(): ServerStats[] {
    const now = Date.now();
    return this.members.map((member) => ({
      id: member.id,
      archive: !!member.archive,
      ready: isReady(member),
      inFlight: member.inFlight,
      latencyMs: Math.round(member.latencyMs),
      calls: member.calls,
      coolingDownMs: Math.max(0, member.cooldownUntil - now),
      errors: member.errors,
    }));
  }

  /**
   * Runs `fn` against the best available server, moving to another one on failure
   * according to the error kind. Throws a `SourceError` once no server can serve it.
   *
   * Once `signal` aborts, it starts no further attempt, stops waiting for the one
   * in flight and rejects with `signal.reason`.
   */
  async call<T>(method: string, fn: (client: C) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const ruledOut = new Set<ServerState<C>>();
    let attempts = 0;
    let lastError: unknown;

    for (;;) {
      signal?.throwIfAborted();
      const server = await this.acquire(ruledOut, signal);
      if (!server) throw this.exhaustedError(method, lastError);

      const startedAt = Date.now();
      this.metrics.call(method);
      server.calls++;
      try {
        const result = await abortable(this.withTimeout(fn(server.client), method), signal);
        server.latencyMs =
          server.latencyMs * (1 - LATENCY_SMOOTHING) + (Date.now() - startedAt) * LATENCY_SMOOTHING;
        server.rateLimits = 0;
        server.failures = 0;
        return result;
      } catch (error) {
        // Abandoned, not failed: no error is counted against the server.
        if (signal?.aborted) throw signal.reason;
        lastError = error;
        const kind = classifyError(error);
        server.errors[kind] = (server.errors[kind] ?? 0) + 1;
        this.metrics.error(kind, method);
        this.logger.debug(`${method} failed on ${server.id} (${kind}):`, errorMessage(error));

        if (kind === "archive_unavailable" || kind === "bad_response") {
          ruledOut.add(server);
          continue;
        }
        this.coolDown(server, kind);
        if (kind === "not_ready") ruledOut.add(server);
        if (++attempts >= this.maxAttempts) {
          throw error instanceof SourceError
            ? error
            : new SourceError(kind, `${method}: ${errorMessage(error)}`, error);
        }
      } finally {
        server.inFlight--;
        this.wakeSlotWaiters();
      }
    }
  }

  private coolDown(server: ServerState<C>, kind: ErrorKind): void {
    if (kind === "rate_limit") {
      server.rateLimits++;
      const delay = exponentialBackoff(server.rateLimits, COOLDOWN_MIN_MS, this.maxCooldownMs);
      server.cooldownUntil = Date.now() + withJitter(delay);
    } else if (kind === "timeout" || kind === "network" || kind === "not_ready") {
      server.failures++;
      server.cooldownUntil =
        Date.now() + exponentialBackoff(server.failures, COOLDOWN_MIN_MS, this.maxCooldownMs);
    }
  }

  private exhaustedError(method: string, lastError: unknown): SourceError {
    if (lastError instanceof SourceError) return lastError;
    if (!lastError)
      return new SourceError("network", `${method}: no server could serve the request`);
    return new SourceError(
      classifyError(lastError),
      `${method}: no server could serve the request: ${errorMessage(lastError)}`,
      lastError,
    );
  }

  private withTimeout<T>(promise: Promise<T>, method: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SourceError("timeout", `${method} timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private wakeSlotWaiters(): void {
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Picks the best available server, waiting while all candidates are busy or
   * cooling down. Returns null when every server has been ruled out for this call.
   */
  private async acquire(
    ruledOut: Set<ServerState<C>>,
    signal: AbortSignal | undefined,
  ): Promise<ServerState<C> | null> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const candidates = this.candidates(ruledOut);
      if (candidates.length === 0) {
        if (Date.now() > deadline || this.members.every((member) => ruledOut.has(member))) {
          return null;
        }
        await sleep(NO_SERVER_POLL_MS, signal);
        continue;
      }

      const now = Date.now();
      let best: ServerState<C> | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      let soonestCooldownEnd = Number.POSITIVE_INFINITY;
      for (const server of candidates) {
        if (server.cooldownUntil > now) {
          soonestCooldownEnd = Math.min(soonestCooldownEnd, server.cooldownUntil);
          continue;
        }
        if (server.inFlight >= this.maxInFlight) continue;
        const jitter = 1 - SCORE_JITTER + Math.random() * 2 * SCORE_JITTER;
        const score = server.latencyMs * (1 + server.inFlight) * jitter;
        if (score < bestScore) {
          best = server;
          bestScore = score;
        }
      }
      if (best) {
        best.inFlight++;
        return best;
      }
      const wait =
        soonestCooldownEnd === Number.POSITIVE_INFINITY
          ? BUSY_WAIT_MS
          : Math.max(MIN_COOLDOWN_WAIT_MS, soonestCooldownEnd - now);
      await this.waitForSlot(wait, signal);
    }
  }

  /** Connected regular servers not ruled out; archival ones only when none is left. */
  private candidates(ruledOut: Set<ServerState<C>>): ServerState<C>[] {
    const usable = (archive: boolean) =>
      this.members.filter(
        (member) => !!member.archive === archive && !ruledOut.has(member) && isReady(member),
      );
    const primaries = usable(false);
    return primaries.length > 0 ? primaries : usable(true);
  }

  /** Waits for a freed slot or `maxWaitMs`; rejects (leaving no timer behind) on abort. */
  private waitForSlot(maxWaitMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const cleanUp = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.slotWaiters = this.slotWaiters.filter((waiter) => waiter !== wake);
      };
      const wake = () => {
        cleanUp();
        resolve();
      };
      const onAbort = () => {
        cleanUp();
        reject(signal?.reason);
      };
      const timer = setTimeout(wake, maxWaitMs);
      this.slotWaiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
