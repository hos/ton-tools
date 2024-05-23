import { Address, Cell, type Transaction, loadTransaction } from "@ton/core";
import { type tonNode_blockIdExt } from "ton-lite-client/dist/schema";
import type {
  AppLiteClient,
  WalletTransactions,
  WalletTransactionsInitializer,
} from "./types";

export const isValidTonAddress = (address: string) => {
  try {
    Address.parse(address);
    return true;
  } catch (e) {
    return false;
  }
};

export const toRawAddress = (input: string | Address) => {
  const address = typeof input === "string" ? Address.parse(input) : input;

  return address.toRawString();
};

export function toDisplayAddress(input: string | Address): string {
  const address = typeof input === "string" ? Address.parse(input) : input;
  return address.toString({ urlSafe: true, bounceable: true });
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

export async function getAccountTransactions(
  liteClient: AppLiteClient,
  src: Address,
  lt: string,
  hash: Buffer,
  count: number
): Promise<{ ids: tonNode_blockIdExt[]; transactions: Transaction[] }> {
  const transactionsRaw = await liteClient.getAccountTransactions(
    src,
    lt,
    hash,
    count
  );
  const txList = Cell.fromBoc(transactionsRaw.transactions);

  const txes = txList.map((tx) => {
    const transaction = loadTransaction(tx.beginParse());

    return transaction;
  });

  return {
    ids: transactionsRaw.ids,
    transactions: txes,
  };
}

export function decorateWalletTransaction(
  tx: Transaction,
  ltToHash: Map<bigint, bigint>
): WalletTransactionsInitializer | null {
  if (tx.inMessage?.info.type === "internal") {
    return {
      amount: tx.inMessage.info.value.coins.toString(),
      source_wallet: toDisplayAddress(tx.inMessage.info.src)!,
      target_wallet: toDisplayAddress(tx.inMessage.info.dest)!,
      lt: tx.lt.toString(),
      hash: bigIntToHex(ltToHash.get(tx.lt)),
      message: null,
      transaction_created_at: new Date(tx.now * 1000),
      prev_lt: tx.prevTransactionLt.toString(),
    };
  }

  if (tx.inMessage?.info.type === "external-in") {
    return {
      amount: "0",
      source_wallet: "external",
      target_wallet: toDisplayAddress(tx.inMessage.info.dest)!,
      lt: tx.lt.toString(),
      hash: bigIntToHex(ltToHash.get(tx.lt)),
      message: null,
      transaction_created_at: new Date(tx.now * 1000),
      prev_lt: tx.prevTransactionLt.toString(),
    };
  }

  return null;
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
