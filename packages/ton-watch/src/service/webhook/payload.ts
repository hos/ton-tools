import { Address, Cell, ExternalAddress } from "@ton/core";

import type { TxRecord } from "../../core/types";
import { parseTransaction } from "../../parse";
import type { ParsedTransaction } from "../../parse/types";

/** A hash in the two encodings receivers commonly need. */
export interface HashJson {
  hex: string;
  base64: string;
}

/** The JSON body of one webhook request: one transaction. */
export interface WebhookPayload {
  /** `<raw address>:<lt>:<hex hash>`; also sent as the `Idempotency-Key` header. */
  id: string;
  /** Name of the target this was sent to. */
  webhook: string;
  address: { raw: string; friendly: string };
  /** Logical time, as a decimal string. */
  lt: string;
  hash: HashJson;
  utime: number;
  /** The account's previous transaction; null for its very first one. */
  prev: { lt: string; hash: HashJson } | null;
  /** The transaction cell as a base64 BOC. */
  boc: string;
  /** Decoded summary (see `ton-watch/parse`); null if the BOC could not be parsed. */
  parsed: ParsedJson | null;
  /**
   * True when an operator replays a dead letter: sent again out of order, possibly
   * after later transactions of the address. Also sent as `TON-Watch-Replay: 1`.
   */
  replay: boolean;
}

/**
 * `ParsedTransaction` minus the fields already at the top level and the
 * `@ton/core` objects, in JSON form: bigints as decimal strings, addresses as raw
 * strings, cells as base64 BOCs, buffers as base64, maps as objects.
 */
export type ParsedJson = Record<string, unknown>;

export interface PayloadOptions {
  webhook: string;
  /** Format the friendly address for testnet. */
  testOnly: boolean;
  /** A dead letter being replayed. Default false. */
  replay?: boolean;
}

/** Idempotency key of a transaction: stable across retries and restarts. */
export function deliveryId(tx: TxRecord): string {
  return `${tx.address}:${tx.lt}:${tx.hash.toString("hex")}`;
}

export function webhookPayload(
  tx: TxRecord,
  { webhook, testOnly, replay = false }: PayloadOptions,
): WebhookPayload {
  return {
    id: deliveryId(tx),
    webhook,
    address: {
      raw: tx.address,
      friendly: Address.parse(tx.address).toString({ testOnly }),
    },
    lt: tx.lt.toString(),
    hash: hashJson(tx.hash),
    utime: tx.utime,
    prev: tx.prevLt === 0n ? null : { lt: tx.prevLt.toString(), hash: hashJson(tx.prevHash) },
    boc: tx.boc.toString("base64"),
    parsed: parsedJson(tx),
    replay,
  };
}

function hashJson(hash: Buffer): HashJson {
  return { hex: hash.toString("hex"), base64: hash.toString("base64") };
}

function parsedJson(tx: TxRecord): ParsedJson | null {
  let parsed: ParsedTransaction;
  try {
    parsed = parseTransaction(tx);
  } catch {
    return null;
  }
  const { address: _a, lt: _l, hash: _h, utime: _u, raw: _r, ...summary } = parsed;
  return toJsonValue(summary) as ParsedJson;
}

/** Converts parse results to plain JSON values, dropping `raw` `@ton/core` objects. */
export function toJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (Address.isAddress(value)) return value.toRawString();
  if (ExternalAddress.isAddress(value)) return value.toString();
  if (value instanceof Cell) return value.toBoc().toString("base64");
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, item]) => [String(key), toJsonValue(item)]));
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "raw")
      .map(([key, item]) => [key, toJsonValue(item)]),
  );
}
