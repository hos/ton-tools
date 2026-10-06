/**
 * TEP-62 NFT message bodies. Each decoder receives the slice positioned right
 * after the 32-bit opcode and throws on a layout mismatch.
 */
import type { Slice } from "@ton/core";

import { readForwardPayload } from "./forward-payload";
import { readAddress, readMaybeRef, readQueryId } from "./reader";
import type { NftOwnershipAssigned, NftTransfer } from "./types";

/**
 * `transfer#5fcc3d14 query_id:uint64 new_owner:MsgAddress response_destination:MsgAddress
 *   custom_payload:(Maybe ^Cell) forward_amount:(VarUInteger 16)
 *   forward_payload:(Either Cell ^Cell)`
 */
export function decodeNftTransfer(slice: Slice): NftTransfer {
  return {
    kind: "nft-transfer",
    queryId: readQueryId(slice),
    newOwner: readAddress(slice),
    responseDestination: readAddress(slice),
    customPayload: readMaybeRef(slice),
    forwardAmount: slice.loadCoins(),
    forwardPayload: readForwardPayload(slice),
  };
}

/**
 * `ownership_assigned#05138d91 query_id:uint64 prev_owner:MsgAddress
 *   forward_payload:(Either Cell ^Cell)`
 */
export function decodeNftOwnershipAssigned(slice: Slice): NftOwnershipAssigned {
  return {
    kind: "nft-ownership-assigned",
    queryId: readQueryId(slice),
    prevOwner: readAddress(slice),
    forwardPayload: readForwardPayload(slice),
  };
}
