import { Cell, Dictionary, type Slice } from "@ton/core";

import type { ShardTop } from "../source";

/** Shard id of the masterchain (the full shard, `0x8000000000000000` as signed 64-bit). */
export const MASTERCHAIN_SHARD = "-9223372036854775808";

/** The root shard of a workchain: only the top tag bit set. */
const ROOT_SHARD = 1n << 63n;

/**
 * Parses `liteServer.allShardsInfo.data` (ShardHashes) into shard tops, keeping the
 * `end_lt` that ton-lite-client's own parser drops.
 *
 * shard_descr#b / shard_descr_new#a: seq_no:uint32 reg_mc_seqno:uint32
 *   start_lt:uint64 end_lt:uint64 root_hash:bits256 file_hash:bits256 ...
 */
export function parseShardTops(data: Buffer): ShardTop[] {
  const root = Cell.fromBoc(data)[0]!.beginParse();
  if (!root.loadBit()) return [];
  const byWorkchain = Dictionary.loadDirect(
    Dictionary.Keys.Uint(32),
    Dictionary.Values.Cell(),
    root.loadRef(),
  );

  const tops: ShardTop[] = [];
  for (const [workchainKey, tree] of byWorkchain) {
    const workchain = workchainKey | 0;
    // Walk the binary shard tree; each fork halves the shard's prefix range.
    const stack: { slice: Slice; shard: bigint }[] = [
      { slice: tree.beginParse(), shard: ROOT_SHARD },
    ];
    while (stack.length > 0) {
      const { slice, shard } = stack.pop()!;
      const isFork = slice.loadBit();
      if (!isFork) {
        slice.skip(4); // constructor tag
        const seqno = slice.loadUint(32);
        slice.skip(32); // reg_mc_seqno
        slice.skip(64); // start_lt
        const endLt = slice.loadUintBig(64);
        const rootHash = slice.loadBuffer(32);
        const fileHash = slice.loadBuffer(32);
        tops.push({
          workchain,
          shard: BigInt.asIntN(64, shard).toString(),
          seqno,
          endLt,
          rootHash,
          fileHash,
        });
        continue;
      }
      const delta = (shard & (~shard + 1n)) >> 1n;
      stack.push({ slice: slice.loadRef().beginParse(), shard: shard - delta });
      stack.push({ slice: slice.loadRef().beginParse(), shard: shard + delta });
    }
  }
  return tops;
}

/** Whether a shard (signed 64-bit id) contains the account id. */
export function shardContains(shard: string, accountId: Buffer): boolean {
  const id = BigInt.asUintN(64, BigInt(shard));
  const tagBit = id & -id;
  const prefixBits = 63 - (tagBit.toString(2).length - 1);
  if (prefixBits === 0) return true;
  const accountPrefix = BigInt(`0x${accountId.subarray(0, 8).toString("hex")}`);
  const mask = ((1n << BigInt(prefixBits)) - 1n) << BigInt(64 - prefixBits);
  return (accountPrefix & mask) === (id & mask);
}
