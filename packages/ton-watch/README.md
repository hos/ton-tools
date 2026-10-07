# @ton/watch

Watch a set of TON addresses and get every one of their transactions, **in chain
order, with nothing skipped**, straight from public liteservers: no node, no API
key, no third-party indexer.

Restarts, crashes and outages of days or weeks are just a backlog to catch up on.

## Install

```sh
bunx jsr add @ton/watch
```

Published on [JSR](https://jsr.io/@ton/watch) for [Bun](https://bun.sh) ≥ 1.4.

## Quickstart

```ts
import { Pool } from "pg";
import { LiteSource, PgStore, TonWatch } from "@ton/watch";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const watch = new TonWatch({
  store: new PgStore(pool, { onClose: () => pool.end() }), // or new MemoryStore()
  source: await LiteSource.connect({ servers: "mainnet" }),
});

await watch.addAddress("EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMS", { from: "now" });

watch.process("my-consumer", async (tx, ctx) => {
  // tx.address, tx.lt, tx.hash, tx.utime, tx.transaction (@ton/core Transaction)
  // Writes through ctx.db commit together with the consumer's position: exactly once.
  await ctx.db?.query("insert into seen (hash) values ($1)", [tx.hash]);
});

await watch.start();
// on shutdown:
await watch.close();
```

A failing handler is retried; its address waits until it succeeds. Restart the
process and it resumes where it stopped.

## Recipes

### Accept TON payments

```ts
import { incomingPayment } from "@ton/watch/parse";

watch.process("payments", async (tx, ctx) => {
  const payment = incomingPayment(tx); // null unless TON was actually credited
  if (!payment || !["empty", "text-comment"].includes(payment.body.kind)) return;
  await ctx.db!.query("insert into payments values ($1, $2, $3, $4)", [
    tx.hash, payment.sender.toString(), payment.amount.toString(), payment.comment,
  ]);
});
```

Bounces and outgoing transfers return `null`; the body check also drops `excesses`
refunds and the TON attached to jetton notifications. Full example:
[`examples/incoming-payments.ts`](https://github.com/hos/ton-tools/blob/main/packages/ton-watch/examples/incoming-payments.ts).

### Accept jettons (USDT, NOT, …)

```ts
import { incomingJettonTransfer } from "@ton/watch/parse";

// Your jetton wallet for each token (the master's get_wallet_address(you)).
const jettons = incomingJettonTransfer(tx, { jettonWallet: [usdtWallet, notWallet] });
if (jettons) credit(jettons.sender, jettons.amount, jettons.comment, jettons.jettonWallet);
```

Notifications from any other wallet are ignored, so nobody can fake a deposit.

### Run it as a service that calls your webhook

No code on the indexing side: a one-line file and environment variables.

```ts
// ton-watch.ts
import { run } from "@ton/watch/cli";
await run();
```

```sh
TON_WATCH_DATABASE_URL=postgres://… \
TON_WATCH_ADDRESSES=EQ…,EQ… \
TON_WATCH_WEBHOOK_URL=https://your.app/ton \
TON_WATCH_WEBHOOK_SECRET=… \
bun run ton-watch.ts run
```

Every transaction is POSTed as JSON, in order, retried until your endpoint answers
2xx. On the receiving side:

```ts
import { SIGNATURE_HEADER, verifySignature, type WebhookPayload } from "@ton/watch/webhook";

const body = await request.text();
if (!verifySignature(SECRET, body, request.headers.get(SIGNATURE_HEADER))) {
  return new Response(null, { status: 401 });
}
const payload: WebhookPayload = JSON.parse(body); // payload.parsed: the decoded transaction
```

It also serves `/health` and Prometheus `/metrics` on port 9464.

## Documentation

- [Library](docs/library.md): how it works, the full `TonWatch` and consumer API,
  ordering and delivery guarantees, failures and dead letters, errors, decoding.
- [Service](docs/service.md): every setting, the CLI, webhooks (payload, signing,
  retries), HTTP endpoints, metrics.
- [Operations](docs/operations.md): liteservers and history depth, the toncenter
  plug-in, storage and retention, benchmarks, when not to use it, stability policy,
  development.
- [Migrations](docs/migrations.md) and the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE.md)
