# Decoding transactions

[← @ton/watch](../README.md)

`@ton/watch/parse` decodes a transaction (`tx` from a handler, or any `@ton/core`
`Transaction`): outcome and bounce flags, comments, TEP-74 jetton and TEP-62 NFT
messages. Two helpers answer what payment processing asks:

```ts
import { incomingJettonTransfer, incomingPayment } from "@ton/watch/parse";

const payment = incomingPayment(tx);
// TON credited by an inbound internal message: not outgoing, not a bounce, not
// bounced back. Also extraCurrencies. Credit only plain transfers:
if (payment && (payment.body.kind === "empty" || payment.body.kind === "text-comment")) {
  credit(payment.sender, payment.amount, payment.comment);
}

// Your jetton wallet(s) — the master's get_wallet_address(owner). Required:
// anyone can send a transfer_notification with any amount.
const jettons = incomingJettonTransfer(tx, { jettonWallet: [usdtWallet, notWallet] });
if (jettons) credit(jettons.sender, jettons.amount, jettons.comment, jettons.jettonWallet);
```

`incomingPayment` also returns `excesses` refunds and the TON attached to jetton
notifications — credited the same way but not payments — hence the body check.
"Credited" covers this transaction only: the account's code may have sent value
onward in it (`parseTransaction(tx).valueOut`). `incomingJettonTransfer` returns
`null` for a notification from any other sender; `{ trustAnySender: true }` opts
out of the check, leaving it to you. A forward payload that does not decode is
`{ kind: "malformed" }` and the transfer is still returned. Both throw on a record
whose BOC is not a transaction, an `address` option that is invalid or names
another account (hash or workchain), and a `jettonWallet` that is not an address.
