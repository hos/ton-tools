import { describe, expect, test } from "bun:test";

import {
  MASTERCHAIN_SHARD,
  parseShardTops,
  shardContains,
} from "../../src/source/liteserver/shards";
import mainnet from "../fixtures/liteserver/mainnet.json";
import { emptyShardHashes, SHARD, shardHashes } from "../fixtures/liteserver/shard-hashes";

const byShard = <T extends { workchain: number; shard: string }>(tops: T[]) =>
  [...tops].sort((a, b) => a.workchain - b.workchain || a.shard.localeCompare(b.shard));

/** A 32-byte account id whose first byte is `firstByte`. */
const account = (firstByte: number) => Buffer.concat([Buffer.from([firstByte]), Buffer.alloc(31)]);

describe("parseShardTops", () => {
  test("parses a real mainnet allShardsInfo response", () => {
    const tops = parseShardTops(Buffer.from(mainnet.tip.shardsData, "base64"));
    expect(tops.length).toBeGreaterThan(0);
    for (const top of tops) {
      expect(top.workchain).toBe(0);
      expect(top.seqno).toBeGreaterThan(100_000_000);
      expect(top.rootHash.length).toBe(32);
      expect(top.fileHash.length).toBe(32);
      // Basechain end_lt sits close to the masterchain's lt at the same moment.
      expect(top.endLt).toBeGreaterThan(108_000_000_000_000n);
      expect(top.endLt).toBeLessThan(109_000_000_000_000n);
    }
    // Shard tops partition the workchain.
    expect(tops.filter((t) => shardContains(t.shard, account(0x00))).length).toBe(1);
    expect(tops.filter((t) => shardContains(t.shard, account(0xff))).length).toBe(1);
  });

  test("a single unsplit shard keeps seqno, end_lt and hashes", () => {
    const rootHash = Buffer.alloc(32, 0xaa);
    const fileHash = Buffer.alloc(32, 0xbb);
    const tops = parseShardTops(
      shardHashes({ 0: { seqno: 42, endLt: 123_456_789n, rootHash, fileHash } }),
    );
    expect(tops).toEqual([
      { workchain: 0, shard: SHARD.root, seqno: 42, endLt: 123_456_789n, rootHash, fileHash },
    ]);
  });

  test("a split shard yields both halves with their own ids", () => {
    const tops = parseShardTops(
      shardHashes({
        0: [
          { seqno: 10, endLt: 1_000n },
          { seqno: 20, endLt: 2_000n },
        ],
      }),
    );
    expect(byShard(tops).map((t) => [t.shard, t.seqno, t.endLt])).toEqual([
      [SHARD.high, 20, 2_000n],
      [SHARD.low, 10, 1_000n],
    ]);
  });

  test("an uneven, deeper split", () => {
    const tops = parseShardTops(
      shardHashes({
        0: [
          [
            { seqno: 1, endLt: 100n },
            { seqno: 2, endLt: 200n },
          ],
          { seqno: 3, endLt: 300n },
        ],
      }),
    );
    expect(Object.fromEntries(tops.map((t) => [t.shard, t.seqno]))).toEqual({
      [SHARD.lowLow]: 1,
      [SHARD.lowHigh]: 2,
      [SHARD.high]: 3,
    });
  });

  test("several workchains, including negative ids", () => {
    const tops = parseShardTops(
      shardHashes({
        0: [
          { seqno: 5, endLt: 50n },
          { seqno: 6, endLt: 60n },
        ],
        [-1]: { seqno: 7, endLt: 70n },
        1: { seqno: 8, endLt: 80n },
      }),
    );
    expect(byShard(tops).map((t) => [t.workchain, t.shard, t.seqno])).toEqual([
      [-1, SHARD.root, 7],
      [0, SHARD.high, 6],
      [0, SHARD.low, 5],
      [1, SHARD.root, 8],
    ]);
  });

  test("no workchains", () => {
    expect(parseShardTops(emptyShardHashes())).toEqual([]);
  });
});

describe("shardContains", () => {
  test("the root shard (and the masterchain shard id) contains every account", () => {
    expect(MASTERCHAIN_SHARD).toBe(SHARD.root);
    for (const first of [0x00, 0x7f, 0x80, 0xff]) {
      expect(shardContains(SHARD.root, account(first))).toBe(true);
    }
  });

  test("halves split on the first bit", () => {
    expect(shardContains(SHARD.low, account(0x00))).toBe(true);
    expect(shardContains(SHARD.low, account(0x7f))).toBe(true);
    expect(shardContains(SHARD.low, account(0x80))).toBe(false);
    expect(shardContains(SHARD.high, account(0x80))).toBe(true);
    expect(shardContains(SHARD.high, account(0xff))).toBe(true);
    expect(shardContains(SHARD.high, account(0x7f))).toBe(false);
  });

  test("quarters split on the first two bits", () => {
    expect(shardContains(SHARD.lowLow, account(0x3f))).toBe(true);
    expect(shardContains(SHARD.lowLow, account(0x40))).toBe(false);
    expect(shardContains(SHARD.lowHigh, account(0x40))).toBe(true);
    expect(shardContains(SHARD.lowHigh, account(0x7f))).toBe(true);
    expect(shardContains(SHARD.lowHigh, account(0x80))).toBe(false);
  });

  test("every account falls in exactly one shard of a split layout", () => {
    const layout = [SHARD.lowLow, SHARD.lowHigh, SHARD.high];
    for (let first = 0; first < 256; first++) {
      expect(layout.filter((shard) => shardContains(shard, account(first))).length).toBe(1);
    }
  });

  test("deep shards compare bits beyond the first byte", () => {
    // Prefix of 12 bits: 0xabc, tag bit right after.
    const shard = BigInt.asIntN(64, (0xabcn << 52n) | (1n << 51n)).toString();
    const inside = Buffer.concat([Buffer.from([0xab, 0xc7]), Buffer.alloc(30)]);
    const outside = Buffer.concat([Buffer.from([0xab, 0xd0]), Buffer.alloc(30)]);
    expect(shardContains(shard, inside)).toBe(true);
    expect(shardContains(shard, outside)).toBe(false);
  });
});
