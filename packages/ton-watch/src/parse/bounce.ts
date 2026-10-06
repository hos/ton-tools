/** Bodies of bounced messages, legacy (`0xffffffff`) and new (`0xfffffffe`). */
import { type Cell, loadCurrencyCollection, type Slice } from "@ton/core";

import { DecodeError } from "./reader";
import type { BouncePhase, LegacyBounce, NewBounce } from "./types";

const BOUNCE_PHASES: readonly BouncePhase[] = [
  "compute-skipped",
  "compute-failed",
  "action-failed",
];

/** `0xffffffff` + up to 256 bits of the original body. */
export function decodeLegacyBounce(slice: Slice): LegacyBounce {
  const originalBody = slice.asCell();
  return { kind: "bounce", format: "legacy", originalBody, ...originalHeader(originalBody) };
}

/**
 * `new_bounce_body#fffffffe original_body:^Cell original_info:^NewBounceOriginalInfo
 *   bounced_by_phase:uint8 exit_code:int32 compute_phase:(Maybe NewBounceComputePhaseInfo)`
 * with `value:CurrencyCollection created_lt:uint64 created_at:uint32 = NewBounceOriginalInfo`
 * and `gas_used:uint32 vm_steps:uint32 = NewBounceComputePhaseInfo`.
 */
export function decodeNewBounce(slice: Slice): NewBounce {
  if (slice.remainingRefs < 2) throw new DecodeError("new bounce body needs two refs");
  const originalBody = slice.loadRef();
  const info = slice.loadRef().beginParse();
  const value = loadCurrencyCollection(info);
  const originalCreatedLt = info.loadUintBig(64);
  const originalCreatedAt = info.loadUint(32);
  const phase = slice.loadUint(8);
  const exitCode = slice.loadInt(32);
  const compute = slice.loadBit()
    ? { gasUsed: slice.loadUint(32), vmSteps: slice.loadUint(32) }
    : null;
  return {
    kind: "bounce",
    format: "new",
    ...originalHeader(originalBody),
    originalBody,
    originalValue: value.coins,
    originalCreatedLt,
    originalCreatedAt,
    bouncedBy: BOUNCE_PHASES[phase] ?? "unknown",
    exitCode,
    compute,
  };
}

/** Opcode and query id of the original body, when it is long enough to have them. */
function originalHeader(body: Cell): { originalOp: number | null; originalQueryId: bigint | null } {
  const slice = body.beginParse();
  const originalOp = slice.remainingBits >= 32 ? slice.loadUint(32) : null;
  const originalQueryId = slice.remainingBits >= 64 ? slice.loadUintBig(64) : null;
  return { originalOp, originalQueryId };
}
