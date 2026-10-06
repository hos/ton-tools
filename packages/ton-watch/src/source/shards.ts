import { Cell, Dictionary, type Slice } from "@ton/core";
import type { ShardTop } from "./source";

/**
 * Parses `liteServer.allShardsInfo.data` (ShardHashes) into shard tops, keeping the
 * `end_lt` that ton-lite-client's own parser drops.
 *
 * shard_descr#b / shard_descr_new#a: seq_no:uint32 reg_mc_seqno:uint32
 *   start_lt:uint64 end_lt:uint64 root_hash:bits256 file_hash:bits256 ...
 */
export function parseShardTops(data: Buffer): ShardTop[] {
  const cs = Cell.fromBoc(data)[0]!.beginParse();
  if (!cs.loadBit()) return [];
  const dict = Dictionary.loadDirect(
    Dictionary.Keys.Uint(32),
    Dictionary.Values.Cell(),
    cs.loadRef()
  );

  const tops: ShardTop[] = [];
  for (const [workchainKey, tree] of dict) {
    const workchain = workchainKey | 0;
    const stack: { slice: Slice; shard: bigint }[] = [
      { slice: tree.beginParse(), shard: 1n << 63n },
    ];
    while (stack.length) {
      const { slice, shard } = stack.pop()!;
      if (!slice.loadBit()) {
        slice.skip(4);
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
