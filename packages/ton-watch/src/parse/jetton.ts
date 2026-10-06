/**
 * TEP-74 jetton message bodies. Each decoder receives the slice positioned right
 * after the 32-bit opcode and throws on a layout mismatch; `parseMessageBody`
 * turns that into a `Malformed` result.
 */
import type { Slice } from "@ton/core";

import { readForwardPayload } from "./forward-payload";
import { readAddress, readMaybeRef, readQueryId } from "./reader";
import type {
  Excesses,
  JettonBurn,
  JettonInternalTransfer,
  JettonTransfer,
  JettonTransferNotification,
} from "./types";

/**
 * `transfer#0f8a7ea5 query_id:uint64 amount:(VarUInteger 16) destination:MsgAddress
 *   response_destination:MsgAddress custom_payload:(Maybe ^Cell)
 *   forward_ton_amount:(VarUInteger 16) forward_payload:(Either Cell ^Cell)`
 */
export function decodeJettonTransfer(slice: Slice): JettonTransfer {
  return {
    kind: "jetton-transfer",
    queryId: readQueryId(slice),
    amount: slice.loadCoins(),
    destination: readAddress(slice),
    responseDestination: readAddress(slice),
    customPayload: readMaybeRef(slice),
    forwardTonAmount: slice.loadCoins(),
    forwardPayload: readForwardPayload(slice),
  };
}

/**
 * `transfer_notification#7362d09c query_id:uint64 amount:(VarUInteger 16)
 *   sender:MsgAddress forward_payload:(Either Cell ^Cell)`
 */
export function decodeJettonTransferNotification(slice: Slice): JettonTransferNotification {
  return {
    kind: "jetton-transfer-notification",
    queryId: readQueryId(slice),
    amount: slice.loadCoins(),
    sender: readAddress(slice),
    forwardPayload: readForwardPayload(slice),
  };
}

/**
 * `internal_transfer#178d4519 query_id:uint64 amount:(VarUInteger 16) from:MsgAddress
 *   response_address:MsgAddress forward_ton_amount:(VarUInteger 16)
 *   forward_payload:(Either Cell ^Cell)`
 */
export function decodeJettonInternalTransfer(slice: Slice): JettonInternalTransfer {
  return {
    kind: "jetton-internal-transfer",
    queryId: readQueryId(slice),
    amount: slice.loadCoins(),
    from: readAddress(slice),
    responseAddress: readAddress(slice),
    forwardTonAmount: slice.loadCoins(),
    forwardPayload: readForwardPayload(slice),
  };
}

/**
 * `burn#595f07bc query_id:uint64 amount:(VarUInteger 16)
 *   response_destination:MsgAddress custom_payload:(Maybe ^Cell)`
 */
export function decodeJettonBurn(slice: Slice): JettonBurn {
  return {
    kind: "jetton-burn",
    queryId: readQueryId(slice),
    amount: slice.loadCoins(),
    responseDestination: readAddress(slice),
    customPayload: readMaybeRef(slice),
  };
}

/** `excesses#d53276db query_id:uint64` (shared with TEP-62). */
export function decodeExcesses(slice: Slice): Excesses {
  return { kind: "excesses", queryId: readQueryId(slice) };
}
