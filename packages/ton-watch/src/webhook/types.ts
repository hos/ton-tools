/**
 * The webhook wire format: the JSON body of every request the service sends.
 *
 * Compatibility rules, for receivers:
 * - Ignore fields you do not know. New fields may be added to any object in any
 *   release without changing `version`.
 * - Ignore values of `type` (top level) and `kind` (message bodies, forward
 *   payloads) you do not know, and treat other enum-like strings (`direction`,
 *   `bouncedBy`, the transaction `type`, ...) as open sets too: new kinds of
 *   events, bodies or transactions may appear without changing `version`.
 * - `version` changes only when an existing field is removed, renamed or changes
 *   meaning; such a change is announced as a breaking release.
 *
 * Encodings: logical times and amounts (nanotons, jetton units) are decimal
 * strings, since they exceed JavaScript's safe integer range; hashes are
 * lower-case hex; addresses are raw (`<workchain>:<64 hex digits>`, lower case);
 * cells are base64 BOCs and binary data is base64. Unix times, opcodes, exit
 * codes and counts are JSON numbers.
 *
 * @module
 */

/** Version of the payload format, sent as `version` in every body. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/** Logical time, or an amount, as a decimal string. */
export type DecimalString = string;
/** Raw address: `<workchain>:<64 lower-case hex digits>`. */
export type RawAddress = string;
/** A 256-bit hash as 64 lower-case hex digits. */
export type HexHash = string;
/** A cell as a base64 bag of cells. */
export type Base64Boc = string;

/** Kinds of event a request can carry. Ignore any other value. */
export type WebhookEventType = "transaction";

/** The JSON body of a webhook request: one transaction of a watched address. */
export interface WebhookPayload {
  /** Payload format version; see the module's compatibility rules. */
  version: typeof WEBHOOK_PAYLOAD_VERSION;
  /** What happened; also sent as the `TON-Watch-Event` header. */
  type: WebhookEventType;
  /**
   * `<address>:<lt>:<hash>`, the same for every attempt to deliver this
   * transaction; also sent as the `Idempotency-Key` header. Deduplicate on it.
   */
  id: string;
  /** Name of the webhook target this was sent to. */
  webhook: string;
  /** The watched account the transaction belongs to. */
  address: RawAddress;
  lt: DecimalString;
  hash: HexHash;
  /** Unix time of the transaction, in seconds. */
  utime: number;
  /** The account's previous transaction; null for its very first one. */
  prev: { lt: DecimalString; hash: HexHash } | null;
  /** The transaction cell. */
  boc: Base64Boc;
  /** Decoded summary of the transaction; null if the BOC could not be decoded. */
  parsed: TransactionJson | null;
  /**
   * True when an operator replays a dead letter: sent again out of order,
   * possibly after later transactions of the address. Also sent as
   * `TON-Watch-Replay: 1`.
   */
  replay: boolean;
}

/** An external (off-chain) address: `bits` bits holding `value`. */
export interface ExternalAddressJson {
  bits: number;
  value: DecimalString;
}

/** Decoded transaction (see `ParsedTransaction` in `ton-watch/parse`). */
export interface TransactionJson {
  /** Transaction kind; `generic` for ordinary message-driven transactions. */
  type:
    | "generic"
    | "storage"
    | "tick-tock"
    | "split-prepare"
    | "split-install"
    | "merge-prepare"
    | "merge-install";
  /** Not aborted, the compute phase ran and succeeded, and the action phase (if any) succeeded. */
  success: boolean;
  aborted: boolean;
  /** Null when the transaction kind has no compute phase. */
  compute: ComputeJson | null;
  /** Null when there was no action phase. */
  action: ActionJson | null;
  /** The inbound message is a bounce: value returning from a failed message this account sent. */
  receivedBounce: boolean;
  /** This transaction bounced the inbound value back to its sender. */
  bouncedBack: boolean;
  /**
   * What started it, from the account's side: `incoming` (internal message from
   * another account), `outgoing` (external message, e.g. a wallet owner sending),
   * `self` (a message to itself) or `system` (no inbound message).
   */
  direction: "incoming" | "outgoing" | "self" | "system";
  inMessage: MessageJson | null;
  outMessages: MessageJson[];
  /** Total fees charged to the account, in nanotons. */
  totalFees: DecimalString;
  /** Value of the inbound internal message, in nanotons; 0 otherwise. */
  valueIn: DecimalString;
  /** Sum of the values of outbound internal messages, in nanotons. */
  valueOut: DecimalString;
}

export type ComputeJson =
  | { type: "skipped"; reason: "no-state" | "bad-state" | "no-gas" }
  | { type: "vm"; success: boolean; exitCode: number; gasUsed: DecimalString };

export interface ActionJson {
  success: boolean;
  resultCode: number;
  totalActions: number;
  skippedActions: number;
}

/** Fields every message has. */
interface MessageJsonBase {
  /** First 32 bits of the body; null for a body shorter than that. */
  op: number | null;
  /** Query id of a decoded body that has one. */
  queryId: DecimalString | null;
  /** Text of a plain text comment body, otherwise null. */
  comment: string | null;
  body: MessageBodyJson;
}

export interface InternalMessageJson extends MessageJsonBase {
  type: "internal";
  src: RawAddress;
  dest: RawAddress;
  /** Attached value in nanotons. */
  value: DecimalString;
  /** Extra currencies: amount by currency id. Empty when none are attached. */
  extraCurrencies: Record<string, DecimalString>;
  /** The message asks to bounce if processing fails. */
  bounce: boolean;
  /** The message is itself a bounce. */
  bounced: boolean;
  fwdFee: DecimalString;
  /** Formerly `ihr_fee`; bit 0: new bounce format, bit 1: bounce with the full body. */
  extraFlags: DecimalString;
  createdLt: DecimalString;
  createdAt: number;
}

export interface ExternalInMessageJson extends MessageJsonBase {
  type: "external-in";
  src: ExternalAddressJson | null;
  dest: RawAddress;
  importFee: DecimalString;
}

export interface ExternalOutMessageJson extends MessageJsonBase {
  type: "external-out";
  src: RawAddress;
  dest: ExternalAddressJson | null;
  createdLt: DecimalString;
  createdAt: number;
}

export type MessageJson = InternalMessageJson | ExternalInMessageJson | ExternalOutMessageJson;

/** `0x00000000` + UTF-8 text. */
export interface TextCommentJson {
  kind: "text-comment";
  text: string;
}

/** `0x00000000 0xff` + bytes, not meant for display. */
export interface BinaryCommentJson {
  kind: "binary-comment";
  /** Base64 of the bytes after the `0xff` marker. */
  data: string;
}

/** `0x2167da4b` + cipher text. */
export interface EncryptedCommentJson {
  kind: "encrypted-comment";
  /** Base64 of the cipher text, without the opcode. */
  data: string;
}

export type CommentJson = TextCommentJson | BinaryCommentJson | EncryptedCommentJson;

/** A body, or part of one, that could not be decoded. */
export interface MalformedJson {
  kind: "malformed";
  op: number | null;
  reason: string;
}

/** The forward payload of a jetton or NFT message. */
export type ForwardPayloadJson =
  | { kind: "empty" }
  | CommentJson
  | { kind: "opaque"; op: number | null; cell: Base64Boc }
  | MalformedJson;

/** A decoded message body. `kind` is an open set: ignore kinds you do not know. */
export type MessageBodyJson =
  | { kind: "empty" }
  | CommentJson
  | JettonTransferJson
  | JettonTransferNotificationJson
  | JettonInternalTransferJson
  | { kind: "excesses"; queryId: DecimalString }
  | JettonBurnJson
  | NftTransferJson
  | NftOwnershipAssignedJson
  | LegacyBounceJson
  | NewBounceJson
  | { kind: "unknown"; op: number }
  | MalformedJson;

/** TEP-74 `transfer#0f8a7ea5`. */
export interface JettonTransferJson {
  kind: "jetton-transfer";
  queryId: DecimalString;
  amount: DecimalString;
  destination: RawAddress | null;
  responseDestination: RawAddress | null;
  customPayload: Base64Boc | null;
  forwardTonAmount: DecimalString;
  forwardPayload: ForwardPayloadJson;
}

/**
 * TEP-74 `transfer_notification#7362d09c`. Anyone can send this opcode: it proves
 * nothing unless it comes from the owner's own jetton wallet of the expected jetton.
 */
export interface JettonTransferNotificationJson {
  kind: "jetton-transfer-notification";
  queryId: DecimalString;
  amount: DecimalString;
  sender: RawAddress | null;
  forwardPayload: ForwardPayloadJson;
}

/** TEP-74 `internal_transfer#178d4519`. */
export interface JettonInternalTransferJson {
  kind: "jetton-internal-transfer";
  queryId: DecimalString;
  amount: DecimalString;
  from: RawAddress | null;
  responseAddress: RawAddress | null;
  forwardTonAmount: DecimalString;
  forwardPayload: ForwardPayloadJson;
}

/** TEP-74 `burn#595f07bc`. */
export interface JettonBurnJson {
  kind: "jetton-burn";
  queryId: DecimalString;
  amount: DecimalString;
  responseDestination: RawAddress | null;
  customPayload: Base64Boc | null;
}

/** TEP-62 `transfer#5fcc3d14`. */
export interface NftTransferJson {
  kind: "nft-transfer";
  queryId: DecimalString;
  newOwner: RawAddress | null;
  responseDestination: RawAddress | null;
  customPayload: Base64Boc | null;
  forwardAmount: DecimalString;
  forwardPayload: ForwardPayloadJson;
}

/** TEP-62 `ownership_assigned#05138d91`; only meaningful if the sender is a verified item. */
export interface NftOwnershipAssignedJson {
  kind: "nft-ownership-assigned";
  queryId: DecimalString;
  prevOwner: RawAddress | null;
  forwardPayload: ForwardPayloadJson;
}

/** Legacy bounce: `0xffffffff` + the first 256 bits of the original body. */
export interface LegacyBounceJson {
  kind: "bounce";
  format: "legacy";
  originalOp: number | null;
  originalQueryId: DecimalString | null;
  originalBody: Base64Boc;
}

/** `new_bounce_body#fffffffe`. */
export interface NewBounceJson {
  kind: "bounce";
  format: "new";
  originalOp: number | null;
  originalQueryId: DecimalString | null;
  originalBody: Base64Boc;
  originalValue: DecimalString;
  originalCreatedLt: DecimalString;
  originalCreatedAt: number;
  bouncedBy: "compute-skipped" | "compute-failed" | "action-failed" | "unknown";
  exitCode: number;
  compute: { gasUsed: number; vmSteps: number } | null;
}
