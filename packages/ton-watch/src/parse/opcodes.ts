/**
 * Message opcodes the parser understands: the first 32 bits of a message body.
 *
 * Jetton values are from TEP-74, NFT values from TEP-62, the bounce prefixes from
 * `block.tlb`, and the encrypted comment from the reference wallet
 * (`WalletInterface::EncryptedCommentOp`).
 */
export const Op = {
  /** Text or binary comment: `0x00000000` followed by the comment bytes. */
  comment: 0x00000000,
  /** Encrypted comment: `0x2167da4b` followed by the cipher text. */
  encryptedComment: 0x2167da4b,
  /** Legacy bounced body: `0xffffffff` followed by the first 256 bits of the original body. */
  bounce: 0xffffffff,
  /** `new_bounce_body#fffffffe` (global version 12), sent when the original message asked for it. */
  newBounce: 0xfffffffe,

  jettonTransfer: 0x0f8a7ea5,
  jettonTransferNotification: 0x7362d09c,
  jettonInternalTransfer: 0x178d4519,
  jettonBurn: 0x595f07bc,
  /** Shared by jettons (TEP-74) and NFTs (TEP-62). */
  excesses: 0xd53276db,

  nftTransfer: 0x5fcc3d14,
  nftOwnershipAssigned: 0x05138d91,
} as const;

/** First byte of a binary (machine-readable, not for display) comment. */
export const BINARY_COMMENT_PREFIX = 0xff;
