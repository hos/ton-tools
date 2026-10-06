import { Address, Cell } from "@ton/core";

import { errorMessage, SourceError } from "../../core/errors";
import { recordFromCell } from "../../core/transaction";
import type { TxId, TxRecord } from "../../core/types";
import type { SourceCallOptions } from "../../source/call-options";
import type { HistorySource } from "../../source/history";
import { sleep } from "../../util/async";
import { exponentialBackoff } from "../../util/backoff";

export interface ToncenterHistoryOptions {
  /** API key; without one toncenter allows 1 request/s. */
  apiKey?: string;
  /** Default https://toncenter.com/api/v2 (testnet: https://testnet.toncenter.com/api/v2). */
  endpoint?: string;
  /** Requests per second to stay under. Default 10 with a key, 1 without. */
  rps?: number;
  /** Transactions per request, up to 1000. Default 256. */
  pageSize?: number;
  /** Per-request timeout. Default 20s. */
  timeoutMs?: number;
  /** Retries on 429/5xx/network errors before giving up on a page. Default 4. */
  retries?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

const DEFAULT_ENDPOINT = "https://toncenter.com/api/v2";
const DEFAULT_RPS_WITH_KEY = 10;
const DEFAULT_RPS_WITHOUT_KEY = 1;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 256;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 4;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Characters of a non-JSON error body kept in the error message. */
const ERROR_BODY_PREVIEW_CHARS = 200;

/** toncenter's ways of saying it does not have that transaction. */
const NOT_FOUND = /lt not in db|cannot locate|not found/i;

/** A toncenter API v2 response envelope. */
interface V2Response {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** One entry of a v2 `getTransactions` result; only the raw BOC is used. */
interface V2Transaction {
  data: string;
  transaction_id: { lt: string; hash: string };
}

/**
 * History plug-in backed by toncenter API v2 `getTransactions` with
 * `archival=true`: the same "newest first, from (lt, hash)" walk as liteservers,
 * but up to 1000 per page and with full history. Pages are raw transaction BOCs,
 * re-hashed and link-checked by the indexer exactly like liteserver pages, so a
 * wrong answer is rejected, not stored.
 *
 * @experimental Not tested against paid-plan rate limits; see the module docs.
 */
export class ToncenterHistory implements HistorySource {
  readonly name = "toncenter";
  readonly maxPageSize: number;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  /** Earliest time the next request may be sent. */
  private nextSlotAt = 0;

  constructor(options: ToncenterHistoryOptions = {}) {
    this.apiKey = options.apiKey;
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
    const rps = options.rps ?? (options.apiKey ? DEFAULT_RPS_WITH_KEY : DEFAULT_RPS_WITHOUT_KEY);
    this.intervalMs = 1000 / rps;
    this.maxPageSize = Math.min(MAX_PAGE_SIZE, options.pageSize ?? DEFAULT_PAGE_SIZE);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Busy when the next request slot is more than one interval away. */
  busy(): boolean {
    return this.nextSlotAt - Date.now() > this.intervalMs;
  }

  async getTransactions(
    address: string,
    from: TxId,
    count: number,
    options: SourceCallOptions = {},
  ): Promise<TxRecord[]> {
    const rawAddress = Address.parse(address).toRawString();
    const params = new URLSearchParams({
      address: rawAddress,
      lt: from.lt.toString(),
      hash: from.hash.toString("hex"),
      limit: String(Math.min(count, this.maxPageSize)),
      archival: "true",
    });
    const { result } = await this.request(`/getTransactions?${params}`, options.signal);
    if (!Array.isArray(result)) {
      throw new SourceError("bad_response", "toncenter: result is not a list");
    }
    if (result.length === 0) {
      throw new SourceError("archive_unavailable", `toncenter has no transaction at lt ${from.lt}`);
    }
    return (result as V2Transaction[]).map((tx) =>
      recordFromCell(Cell.fromBoc(Buffer.from(tx.data, "base64"))[0]!, rawAddress),
    );
  }

  /** Waits for the next request slot under the rate limit. */
  private async takeSlot(signal: AbortSignal | undefined): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = at + this.intervalMs;
    if (at > now) await sleep(at - now, signal);
  }

  /** GET with rate limiting; retries rate limits, 5xx and network errors. */
  private async request(path: string, signal: AbortSignal | undefined): Promise<V2Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.takeSlot(signal);
      try {
        return await this.fetchOnce(path, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const retryable =
          !(error instanceof SourceError) ||
          error.kind === "rate_limit" ||
          error.kind === "network";
        if (!retryable) throw error;
        lastError = error instanceof SourceError ? error : transportError(error);
      }
      // Back off by pushing our own next slot out.
      this.nextSlotAt = Math.max(
        this.nextSlotAt,
        Date.now() + exponentialBackoff(attempt + 1, RETRY_MIN_MS, RETRY_MAX_MS),
      );
    }
    throw lastError;
  }

  /** One HTTP round trip; throws a classified `SourceError` for any non-ok answer. */
  private async fetchOnce(path: string, signal: AbortSignal | undefined): Promise<V2Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(`${this.endpoint}${path}`, {
      headers: this.apiKey ? { "X-API-Key": this.apiKey } : {},
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    let body: V2Response;
    try {
      body = JSON.parse(text) as V2Response;
    } catch {
      body = { ok: false, error: text.slice(0, ERROR_BODY_PREVIEW_CHARS) };
    }
    if (response.ok && body.ok) return body;

    const detail = body.error ?? body.result ?? text.slice(0, ERROR_BODY_PREVIEW_CHARS);
    const message = `toncenter ${response.status}: ${detail}`;
    if (response.status === 429) throw new SourceError("rate_limit", message);
    if (response.status >= 500 && !NOT_FOUND.test(message)) {
      throw new SourceError("network", message);
    }
    if (NOT_FOUND.test(message) || message.includes("-400")) {
      throw new SourceError("archive_unavailable", message);
    }
    throw new SourceError("unknown", message);
  }
}

function transportError(error: unknown): SourceError {
  const kind = /timeout|abort/i.test(String(error)) ? "timeout" : "network";
  return new SourceError(kind, errorMessage(error), error);
}
