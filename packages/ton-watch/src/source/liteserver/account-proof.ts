import { Cell, type Slice } from "@ton/core";

import type { TxId } from "../../core/types";

/** Constructor tag of `shard_state#9023afe2` (ShardStateUnsplit). */
const SHARD_STATE_UNSPLIT_TAG = 0x9023afe2;

/** Bits needed to store a number in `0..max` (TL-B `#<= max`). */
function bitsFor(max: number): number {
  return Math.ceil(Math.log2(max + 1));
}

/** Reads an HmLabel (hml_short / hml_long / hml_same) with max length `m`. */
function readLabel(s: Slice, m: number): boolean[] {
  if (!s.loadBit()) {
    // hml_short$0 len:(Unary ~n) s:(n * Bit)
    let n = 0;
    while (s.loadBit()) n++;
    return Array.from({ length: n }, () => s.loadBit());
  }
  if (!s.loadBit()) {
    // hml_long$10 n:(#<= m) s:(n * Bit)
    const n = s.loadUint(bitsFor(m));
    return Array.from({ length: n }, () => s.loadBit());
  }
  // hml_same$11 v:Bit n:(#<= m)
  const v = s.loadBit();
  const n = s.loadUint(bitsFor(m));
  return Array.from({ length: n }, () => v);
}

/**
 * Extracts an account's last transaction id from a `liteServer.getAccountState`
 * proof without parsing the account itself or the whole shard state.
 *
 * Walks ShardStateUnsplit.accounts (HashmapAugE 256 ShardAccount DepthBalanceInfo)
 * along the account's key only, so pruned branches are never touched and new
 * account formats can't break it. Returns null if the account is not in the state.
 */
export function lastTxFromStateProof(proof: Buffer, accountId: Buffer): TxId | null {
  const roots = Cell.fromBoc(proof);
  const stateCell = roots[1]?.refs[0];
  if (!stateCell) throw new Error("unexpected account state proof layout");

  const s = stateCell.beginParse(true);
  if (s.loadUint(32) !== SHARD_STATE_UNSPLIT_TAG) throw new Error("not a ShardStateUnsplit");
  s.skip(32); // global_id
  s.skip(2 + 6 + 32 + 64); // shard_id:ShardIdent
  s.skip(32 + 32 + 32 + 64 + 32); // seq_no vert_seq_no gen_utime gen_lt min_ref_mc_seqno
  s.loadRef(); // out_msg_queue_info
  s.skip(1); // before_split
  const accounts = s.loadRef().beginParse(true);
  if (!accounts.loadBit()) return null; // empty dictionary

  const key: boolean[] = [];
  for (const byte of accountId) for (let i = 7; i >= 0; i--) key.push(((byte >> i) & 1) === 1);

  let node = accounts.loadRef().beginParse(true);
  let pos = 0;
  let n = 256;
  for (;;) {
    const label = readLabel(node, n);
    for (const bit of label) if (key[pos++] !== bit) return null;
    n -= label.length;
    if (n === 0) break;
    if (node.remainingRefs < 2) throw new Error("account path is not covered by the proof");
    const left = node.loadRef();
    const right = node.loadRef();
    const next = key[pos++] ? right : left;
    if (next.isExotic) throw new Error("account path is not covered by the proof");
    node = next.beginParse(true);
    n -= 1;
  }

  // ahmn_leaf: extra:DepthBalanceInfo value:ShardAccount
  node.skip(5); // split_depth:(#<= 30)
  node.loadCoins();
  node.loadMaybeRef(); // extra currencies
  node.loadRef(); // account
  const hash = node.loadBuffer(32);
  const lt = node.loadUintBig(64);
  return lt === 0n ? null : { lt, hash };
}
