import { Address } from "@ton/core";

/** Normalizes any address form (friendly or raw) to raw `<workchain>:<hex>`. */
export function toRawAddress(address: string): string {
  return Address.parse(address).toRawString();
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
