import { Address } from "@ton/core";

export function toDisplayAddress(input: string | Address): string {
  const address = typeof input === "string" ? Address.parse(input) : input;
  return address.toString({ urlSafe: true, bounceable: true });
}

export function toRawAddress(input: string | Address): string {
  const address = typeof input === "string" ? Address.parse(input) : input;
  return address.toRawString()
}

export function bigIntToBuffer(data: bigint | undefined, len = 64): Buffer {
  if (!data) {
    return Buffer.from([]);
  }
  const hexStr = data.toString(16);
  const pad = hexStr.padStart(len, "0");
  const hashHex = Buffer.from(pad, "hex");

  return hashHex;
}

export function hashBase64ToBigInt(hash: string): bigint {
  return BigInt(`0x${Buffer.from(hash, "base64").toString("hex")}`);
}

export function bigIntToHex(data: bigint | undefined): string {
  if (!data) {
    return "";
  }
  const hexStr = data.toString(16);
  const pad = hexStr.padStart(64, "0");

  return pad;
}

export function hashToHex(hash: Buffer | bigint | string): string {
  if (typeof hash === "bigint") {
    return bigIntToHex(hash);
  }
  if (typeof hash === "string") {
    return hash;
  }

  return hash.toString("hex");
}

export function toFriendlyAddress(address: string, offset = 4) {
  return address.slice(0, offset) + "..." + address.slice(-offset);
}

export function getTonExplorerLinks(
  address: string,
  isTestnet: boolean = false
) {
  const prefix = isTestnet ? "testnet." : "";
  return {
    tonViewer: `https://${prefix}tonviewer.com/${address}`,
    tonScan: `https://${prefix}tonscan.org/address/${address}`,
    dTon: isTestnet ? null : `https://dton.io/a/${address}`,
  };
}
