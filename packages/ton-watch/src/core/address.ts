import { Address } from "@ton/core";

import { TonWatchError } from "./errors";

/**
 * An address as ton-watch accepts it: an `@ton/core` `Address`, or a string in
 * friendly (`EQ…`/`UQ…`) or raw (`<workchain>:<hex>`, either hex case) form.
 * Addresses ton-watch hands out are always lowercase raw strings.
 */
export type AddressInput = Address | string;

/**
 * The stored form: canonical decimal workchain (no leading zeros, no `-0`), colon,
 * 64 lowercase hex digits. The `addresses` table checks the same pattern.
 */
const NORMALIZED_RAW = /^(?:0|-?[1-9][0-9]{0,9}):[0-9a-f]{64}$/;

/**
 * Normalizes an address to its lowercase raw form `<workchain>:<hex>`, the only
 * form ton-watch stores and returns. Throws `INVALID_ADDRESS` if it is not one.
 */
export function toRawAddress(address: AddressInput): string {
  if (typeof address === "string" && NORMALIZED_RAW.test(address)) return address;
  try {
    return (typeof address === "string" ? Address.parse(address) : address).toRawString();
  } catch (cause) {
    throw new TonWatchError("INVALID_ADDRESS", `invalid TON address: ${String(address)}`, {
      cause,
    });
  }
}

/** Workchain of a raw address. */
export function workchainOf(rawAddress: string): number {
  return Number(rawAddress.split(":")[0]);
}

const ABBREVIATED_CHARS = 4;

/** Short form for log lines: the first and last four characters. */
export function abbreviateAddress(address: string): string {
  return `${address.slice(0, ABBREVIATED_CHARS)}...${address.slice(-ABBREVIATED_CHARS)}`;
}
