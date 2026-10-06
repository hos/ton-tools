import { classifyError, SourceError, type ErrorKind } from "../errors";
import { silentLogger, type Logger } from "../logger";
import { Metrics } from "../metrics";

export interface PoolMember<C> {
  id: string;
  client: C;
  /** Archival servers are only asked after a regular one could not serve the data. */
  archive?: boolean;
  isReady?: () => boolean;
}

export interface ServerPoolOptions {
  /** Requests in flight per server. */
  maxInFlightPerServer?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Failed attempts (other than archive misses) before giving up on a call. */
  maxAttempts?: number;
  /** Cap for the per-server rate-limit cooldown. */
  maxCooldownMs?: number;
  metrics?: Metrics;
  logger?: Logger;
}

interface MemberState<C> extends PoolMember<C> {
  inFlight: number;
  cooldownUntil: number;
  rateLimits: number;
  failures: number;
  latency: number;
  calls: number;
  errors: Partial<Record<ErrorKind, number>>;
}

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
  readonly members: MemberState<C>[];
  private readonly maxInFlight: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxCooldownMs: number;
  readonly metrics: Metrics;
  private readonly logger: Logger;
  private waiters: (() => void)[] = [];

  constructor(members: PoolMember<C>[], options: ServerPoolOptions = {}) {
    if (members.length === 0) throw new Error("ServerPool needs at least one server");
    this.members = members.map((m) => ({
      ...m,
      inFlight: 0,
      cooldownUntil: 0,
      rateLimits: 0,
      failures: 0,
      latency: 200,
      calls: 0,
      errors: {},
    }));
    this.maxInFlight = options.maxInFlightPerServer ?? 4;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.maxCooldownMs = options.maxCooldownMs ?? 30_000;
    this.metrics = options.metrics ?? new Metrics();
    this.logger = options.logger ?? silentLogger;
  }

  get capacity() {
    return this.members.filter((m) => !m.archive).length * this.maxInFlight;
  }

  stats(): ServerStats[] {
    const now = Date.now();
    return this.members.map((m) => ({
      id: m.id,
      archive: !!m.archive,
      ready: m.isReady?.() ?? true,
      inFlight: m.inFlight,
      latencyMs: Math.round(m.latency),
      calls: m.calls,
      coolingDownMs: Math.max(0, m.cooldownUntil - now),
      errors: m.errors,
    }));
  }

  async call<T>(method: string, fn: (client: C) => Promise<T>): Promise<T> {
    const skip = new Set<MemberState<C>>();
    let attempts = 0;
    let lastError: unknown;

    for (;;) {
      const member = await this.acquire(skip);
      if (!member) {
        throw lastError instanceof SourceError
          ? lastError
          : new SourceError(
              lastError ? classifyError(lastError) : "network",
              `${method}: no server could serve the request` +
                (lastError ? `: ${String((lastError as Error)?.message ?? lastError)}` : ""),
              lastError
            );
      }

      const started = Date.now();
      this.metrics.call(method);
      member.calls++;
      try {
        const result = await this.withTimeout(fn(member.client), method);
        member.latency = member.latency * 0.8 + (Date.now() - started) * 0.2;
        member.rateLimits = 0;
        member.failures = 0;
        return result;
      } catch (error) {
        lastError = error;
        const kind = classifyError(error);
        member.errors[kind] = (member.errors[kind] ?? 0) + 1;
        this.metrics.error(kind, method);
        this.logger.debug(`${method} failed on ${member.id} (${kind}):`, (error as Error)?.message);

        if (kind === "archive_unavailable" || kind === "bad_response") {
          skip.add(member);
          continue;
        }
        if (kind === "rate_limit") {
          member.rateLimits++;
          member.cooldownUntil = Date.now() + this.backoff(member.rateLimits);
        } else if (kind === "timeout" || kind === "network" || kind === "not_ready") {
          member.failures++;
          member.cooldownUntil = Date.now() + Math.min(this.maxCooldownMs, 250 * 2 ** member.failures);
          if (kind === "not_ready") skip.add(member);
        }
        if (++attempts >= this.maxAttempts) {
          throw error instanceof SourceError ? error : new SourceError(kind, `${method}: ${(error as Error)?.message ?? error}`, error);
        }
      } finally {
        member.inFlight--;
        this.wake();
      }
    }
  }

  private backoff(n: number) {
    const base = Math.min(this.maxCooldownMs, 500 * 2 ** (n - 1));
    return base / 2 + Math.random() * (base / 2);
  }

  private withTimeout<T>(promise: Promise<T>, method: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SourceError("timeout", `${method} timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /**
   * Picks the best available server, waiting while all candidates are busy or
   * cooling down. Returns null when every server has been ruled out for this call.
   */
  private async acquire(skip: Set<MemberState<C>>): Promise<MemberState<C> | null> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const usable = (archive: boolean) =>
        this.members.filter((m) => !!m.archive === archive && !skip.has(m));
      let candidates = usable(false);
      const readyPrimaries = candidates.filter((m) => m.isReady?.() ?? true);
      if (readyPrimaries.length === 0) candidates = usable(true);
      else candidates = readyPrimaries;
      candidates = candidates.filter((m) => m.isReady?.() ?? true);

      if (candidates.length === 0) {
        if (Date.now() > deadline || this.members.every((m) => skip.has(m))) return null;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      const now = Date.now();
      let best: MemberState<C> | null = null;
      let bestScore = Infinity;
      let soonest = Infinity;
      for (const m of candidates) {
        if (m.cooldownUntil > now) {
          soonest = Math.min(soonest, m.cooldownUntil);
          continue;
        }
        if (m.inFlight >= this.maxInFlight) continue;
        const score = m.latency * (1 + m.inFlight) * (0.9 + Math.random() * 0.2);
        if (score < bestScore) {
          best = m;
          bestScore = score;
        }
      }
      if (best) {
        best.inFlight++;
        return best;
      }
      const wait = soonest === Infinity ? 1_000 : Math.max(5, soonest - now);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
