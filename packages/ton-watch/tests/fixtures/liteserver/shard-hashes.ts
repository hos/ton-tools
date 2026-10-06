import { beginCell, type Cell, Dictionary } from "@ton/core";

/** One shard top: a `shard_descr` leaf of the shard tree. */
export interface LeafSpec {
  seqno: number;
  endLt: bigint;
  rootHash?: Buffer;
  fileHash?: Buffer;
}

/** A shard tree: a leaf, or a fork into the lower and upper half of the prefix range. */
export type ShardTree = LeafSpec | [ShardTree, ShardTree];

function treeCell(tree: ShardTree): Cell {
  if (Array.isArray(tree)) {
    return beginCell()
      .storeBit(1)
      .storeRef(treeCell(tree[0]))
      .storeRef(treeCell(tree[1]))
      .endCell();
  }
  return beginCell()
    .storeBit(0) // bt_leaf
    .storeUint(0xb, 4) // shard_descr
    .storeUint(tree.seqno, 32)
    .storeUint(0, 32) // reg_mc_seqno
    .storeUint(tree.endLt > 1000n ? tree.endLt - 1000n : 0n, 64) // start_lt
    .storeUint(tree.endLt, 64)
    .storeBuffer(tree.rootHash ?? Buffer.alloc(32, tree.seqno % 256))
    .storeBuffer(tree.fileHash ?? Buffer.alloc(32, 0xf1))
    .endCell();
}

/** Serializes `liteServer.allShardsInfo.data` (ShardHashes) for the given workchain trees. */
export function shardHashes(workchains: Record<number, ShardTree>): Buffer {
  const dict = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
  for (const [workchain, tree] of Object.entries(workchains)) {
    dict.set(Number(workchain) >>> 0, treeCell(tree));
  }
  return beginCell().storeDict(dict).endCell().toBoc();
}

/** ShardHashes with no workchains at all. */
export function emptyShardHashes(): Buffer {
  return beginCell().storeBit(0).endCell().toBoc();
}

/** Signed 64-bit shard ids. */
export const SHARD = {
  root: "-9223372036854775808",
  /** Prefix 0. */
  low: "4611686018427387904",
  /** Prefix 1. */
  high: "-4611686018427387904",
  /** Prefix 00. */
  lowLow: "2305843009213693952",
  /** Prefix 01. */
  lowHigh: "6917529027641081856",
} as const;
