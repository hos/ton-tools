import type {
  Address,
  Cell,
  ComputeSkipReason,
  ExternalAddress,
  Message,
  Transaction,
  TransactionDescription,
} from "@ton/core";

// ---------------------------------------------------------------- comments

/** `0x00000000` + UTF-8 text, possibly continued through refs ("snake" encoding). */
export interface TextComment {
  kind: "text-comment";
  text: string;
}

/** `0x00000000 0xff` + bytes: a machine-readable comment that is not meant for display. */
export interface BinaryComment {
  kind: "binary-comment";
  /** The bytes after the `0xff` marker. */
  data: Buffer;
}

/** `0x2167da4b` + cipher text. Decrypting needs the recipient's private key. */
export interface EncryptedComment {
  kind: "encrypted-comment";
  /** The cipher text, without the opcode. */
  data: Buffer;
}

export type Comment = TextComment | BinaryComment | EncryptedComment;

/**
 * A body, or part of one, that could not be decoded: a known opcode with a
 * truncated or inconsistent layout, invalid UTF-8 in a comment, and so on.
 */
export interface Malformed {
  kind: "malformed";
  /** The opcode, when at least 32 bits were present. */
  op: number | null;
  reason: string;
}

// ---------------------------------------------------------------- payloads

/** No forward payload, or an empty one. */
export interface EmptyPayload {
  kind: "empty";
}

/** A forward payload that is not a comment, e.g. a call into a DEX. */
export interface OpaquePayload {
  kind: "opaque";
  /** The first 32 bits, when present. */
  op: number | null;
  cell: Cell;
}

/** The `forward_payload:(Either Cell ^Cell)` of a jetton or NFT message. */
export type ForwardPayload = EmptyPayload | Comment | OpaquePayload | Malformed;

// ---------------------------------------------------------------- bodies

/** TEP-74 `transfer#0f8a7ea5`: the owner asks its jetton wallet to send jettons. */
export interface JettonTransfer {
  kind: "jetton-transfer";
  queryId: bigint;
  /** Jetton amount in elementary units. */
  amount: bigint;
  /** Owner (not jetton wallet) that receives the jettons. */
  destination: Address | null;
  responseDestination: Address | null;
  customPayload: Cell | null;
  /** Nanotons the receiving jetton wallet forwards to `destination` with the notification. */
  forwardTonAmount: bigint;
  forwardPayload: ForwardPayload;
}

/**
 * TEP-74 `transfer_notification#7362d09c`: a jetton wallet tells its owner it
 * received jettons.
 *
 * Anyone can send a message with this opcode. It proves nothing unless the
 * message comes from the owner's own jetton wallet of the expected jetton.
 */
export interface JettonTransferNotification {
  kind: "jetton-transfer-notification";
  queryId: bigint;
  amount: bigint;
  /** Previous owner of the jettons, as claimed by the sending jetton wallet. */
  sender: Address | null;
  forwardPayload: ForwardPayload;
}

/** TEP-74 `internal_transfer#178d4519`: jetton wallet to jetton wallet (or minter to wallet). */
export interface JettonInternalTransfer {
  kind: "jetton-internal-transfer";
  queryId: bigint;
  amount: bigint;
  from: Address | null;
  responseAddress: Address | null;
  forwardTonAmount: bigint;
  forwardPayload: ForwardPayload;
}

/** TEP-74 / TEP-62 `excesses#d53276db`: leftover TON returned after an operation. */
export interface Excesses {
  kind: "excesses";
  queryId: bigint;
}

/** TEP-74 `burn#595f07bc`: the owner asks its jetton wallet to burn jettons. */
export interface JettonBurn {
  kind: "jetton-burn";
  queryId: bigint;
  amount: bigint;
  responseDestination: Address | null;
  customPayload: Cell | null;
}

/** TEP-62 `transfer#5fcc3d14`: the owner asks an NFT item to change owner. */
export interface NftTransfer {
  kind: "nft-transfer";
  queryId: bigint;
  newOwner: Address | null;
  responseDestination: Address | null;
  customPayload: Cell | null;
  forwardAmount: bigint;
  forwardPayload: ForwardPayload;
}

/**
 * TEP-62 `ownership_assigned#05138d91`: an NFT item tells its new owner.
 * Like jetton notifications, only meaningful if the sender is a verified item.
 */
export interface NftOwnershipAssigned {
  kind: "nft-ownership-assigned";
  queryId: bigint;
  prevOwner: Address | null;
  forwardPayload: ForwardPayload;
}

/** Legacy bounce: `0xffffffff` + the first 256 bits of the original body. */
export interface LegacyBounce {
  kind: "bounce";
  format: "legacy";
  /** Opcode of the bounced message, when the original body had one. */
  originalOp: number | null;
  /** The 64 bits after the opcode, by convention the query id, when present. */
  originalQueryId: bigint | null;
  /** The returned bits of the original body (at most 256, no refs). */
  originalBody: Cell;
}

/** Why a message bounced under the new bounce format. */
export type BouncePhase = "compute-skipped" | "compute-failed" | "action-failed" | "unknown";

/** `new_bounce_body#fffffffe` (global version 12). */
export interface NewBounce {
  kind: "bounce";
  format: "new";
  originalOp: number | null;
  originalQueryId: bigint | null;
  /** The original body: its root only, or the whole tree if the sender asked for it. */
  originalBody: Cell;
  /** Value of the original message, in nanotons. */
  originalValue: bigint;
  originalCreatedLt: bigint;
  originalCreatedAt: number;
  bouncedBy: BouncePhase;
  /** Compute exit code, action result code, or the negative skip reason (see `block.tlb`). */
  exitCode: number;
  /** Present when the compute phase ran. */
  compute: { gasUsed: number; vmSteps: number } | null;
}

export type Bounce = LegacyBounce | NewBounce;

/** A body with an opcode this parser does not decode. */
export interface UnknownBody {
  kind: "unknown";
  op: number;
}

/** No body bits and no refs. */
export interface EmptyBody {
  kind: "empty";
}

/** A decoded message body. Decoding never throws; bad input becomes `Malformed`. */
export type MessageBody =
  | EmptyBody
  | Comment
  | JettonTransfer
  | JettonTransferNotification
  | JettonInternalTransfer
  | Excesses
  | JettonBurn
  | NftTransfer
  | NftOwnershipAssigned
  | Bounce
  | UnknownBody
  | Malformed;

// ---------------------------------------------------------------- messages

interface ParsedMessageBase {
  /** First 32 bits of the body, or `null` for a body shorter than that. */
  op: number | null;
  /** Query id of a decoded body that has one. */
  queryId: bigint | null;
  body: MessageBody;
  /** Text of a plain text comment body, otherwise `null`. */
  comment: string | null;
  /** The `@ton/core` message this was parsed from. */
  raw: Message;
}

export interface ParsedInternalMessage extends ParsedMessageBase {
  type: "internal";
  src: Address;
  dest: Address;
  /** Attached value in nanotons. */
  value: bigint;
  /** Extra currencies by id; empty when none are attached. */
  extraCurrencies: Map<number, bigint>;
  /** Whether the message asks to bounce if processing fails. */
  bounce: boolean;
  /** Whether this message is itself a bounce, returning value to its original sender. */
  bounced: boolean;
  fwdFee: bigint;
  /**
   * The field formerly named `ihr_fee`. It has carried no fee since global
   * version 11 and is `extra_flags` since version 12 (bit 0: new bounce format,
   * bit 1: bounce with the full body).
   */
  extraFlags: bigint;
  createdLt: bigint;
  createdAt: number;
}

export interface ParsedExternalInMessage extends ParsedMessageBase {
  type: "external-in";
  src: ExternalAddress | null;
  dest: Address;
  importFee: bigint;
}

export interface ParsedExternalOutMessage extends ParsedMessageBase {
  type: "external-out";
  src: Address;
  dest: ExternalAddress | null;
  createdLt: bigint;
  createdAt: number;
}

export type ParsedMessage =
  | ParsedInternalMessage
  | ParsedExternalInMessage
  | ParsedExternalOutMessage;

// ---------------------------------------------------------------- transactions

/**
 * What started the transaction, from the account's point of view:
 * - `incoming`: an internal message from another account;
 * - `outgoing`: an external message, e.g. a wallet owner sending funds;
 * - `self`: an internal message the account sent to itself;
 * - `system`: no inbound message (tick-tock, storage, split/merge).
 */
export type Direction = "incoming" | "outgoing" | "self" | "system";

/** Outcome of the compute phase. */
export type ComputeResult =
  | { type: "skipped"; reason: ComputeSkipReason }
  | { type: "vm"; success: boolean; exitCode: number; gasUsed: bigint };

/** Outcome of the action phase. */
export interface ActionResult {
  success: boolean;
  resultCode: number;
  totalActions: number;
  skippedActions: number;
}

export interface ParsedTransaction {
  /** The account, when it could be determined (option, record, or messages). */
  address: Address | null;
  lt: bigint;
  hash: Buffer;
  /** Unix time of the transaction. */
  utime: number;
  /** Transaction kind, `generic` for ordinary message-driven transactions. */
  type: TransactionDescription["type"];
  /**
   * The transaction did what its code asked: not aborted, the compute phase ran
   * and succeeded, and the action phase (if any) succeeded.
   */
  success: boolean;
  aborted: boolean;
  /** `null` when the transaction kind has no compute phase. */
  compute: ComputeResult | null;
  /** `null` when there was no action phase. */
  action: ActionResult | null;
  /** The inbound message is a bounce: value returning from a failed message this account sent. */
  receivedBounce: boolean;
  /** This transaction bounced the inbound value back to its sender (bounce phase succeeded). */
  bouncedBack: boolean;
  direction: Direction;
  inMessage: ParsedMessage | null;
  outMessages: ParsedMessage[];
  /** Total fees charged to the account, in nanotons. */
  totalFees: bigint;
  /** Value of the inbound internal message, 0 otherwise. */
  valueIn: bigint;
  /** Sum of the values of outbound internal messages. */
  valueOut: bigint;
  /** The `@ton/core` transaction this was parsed from. */
  raw: Transaction;
}
