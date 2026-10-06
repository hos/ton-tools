/**
 * toncenter as a history plug-in for ton-watch. Imported separately and entirely
 * optional:
 *
 *   import { ToncenterHistory } from "ton-watch/toncenter";
 *   new TonWatch({ store, source, history: { source: new ToncenterHistory({ apiKey }) } });
 *
 * Uses toncenter API v2 `getTransactions` with `archival=true`: the same "newest
 * first, from (lt, hash)" walk as liteservers, but up to 1000 per page and with
 * full history. Pages are raw transaction BOCs, re-hashed and link-checked by the
 * indexer exactly like liteserver pages, so a wrong answer is rejected, not stored.
 */
import { Address, Cell } from "@ton/core";

import { SourceError } from "../errors";
import type { HistorySource } from "../history";
import { recordFromCell } from "../tx-cell";
import type { TxId, TxRecord } from "../types";

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

interface V2Tx {
  data: string;
  transaction_id: { lt: string; hash: string };
}

export class ToncenterHistory implements HistorySource {
  readonly name = "toncenter";
  readonly maxPageSize: number;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private nextSlot = 0;

  constructor(options: ToncenterHistoryOptions = {}) {
    this.apiKey = options.apiKey;
    this.endpoint = (options.endpoint ?? "https://toncenter.com/api/v2").replace(/\/$/, "");
    const rps = options.rps ?? (options.apiKey ? 10 : 1);
    this.intervalMs = 1000 / rps;
    this.maxPageSize = Math.min(1000, options.pageSize ?? 256);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 4;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Busy when the next request slot is more than one interval away. */
  busy() {
    return this.nextSlot - Date.now() > this.intervalMs;
  }

  private async slot() {
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + this.intervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  async getTransactions(address: string, from: TxId, count: number): Promise<TxRecord[]> {
    const raw = Address.parse(address).toRawString();
    const params = new URLSearchParams({
      address: raw,
      lt: from.lt.toString(),
      hash: from.hash.toString("hex"),
      limit: String(Math.min(count, this.maxPageSize)),
      archival: "true",
    });
    const body = await this.request(`/getTransactions?${params}`);
    const txs = body.result as V2Tx[];
    if (!Array.isArray(txs))
      throw new SourceError("bad_response", "toncenter: result is not a list");
    if (txs.length === 0) {
      throw new SourceError("archive_unavailable", `toncenter has no transaction at lt ${from.lt}`);
    }
    return txs.map((t) => recordFromCell(Cell.fromBoc(Buffer.from(t.data, "base64"))[0]!, raw));
  }

  private async request(path: string): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.slot();
      try {
        const res = await this.fetchImpl(`${this.endpoint}${path}`, {
          headers: this.apiKey ? { "X-API-Key": this.apiKey } : {},
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        let body: any;
        try {
          body = JSON.parse(text);
        } catch {
          body = { ok: false, error: text.slice(0, 200) };
        }
        if (res.ok && body.ok) return body;
        const message = `toncenter ${res.status}: ${body.error ?? body.result ?? text.slice(0, 200)}`;
        if (res.status === 429) {
          lastError = new SourceError("rate_limit", message);
        } else if (res.status >= 500 && !/lt not in db|cannot locate|not found/i.test(message)) {
          lastError = new SourceError("network", message);
        } else if (/lt not in db|cannot locate|not found|-400/i.test(message)) {
          throw new SourceError("archive_unavailable", message);
        } else {
          throw new SourceError("unknown", message);
        }
      } catch (e) {
        if (e instanceof SourceError && e.kind !== "rate_limit" && e.kind !== "network") throw e;
        lastError =
          e instanceof SourceError
            ? e
            : new SourceError(
                /timeout|abort/i.test(String(e)) ? "timeout" : "network",
                String((e as Error)?.message ?? e),
                e,
              );
      }
      // Back off: push our own next slot out.
      this.nextSlot = Math.max(this.nextSlot, Date.now() + Math.min(30_000, 1000 * 2 ** attempt));
    }
    throw lastError;
  }
}
