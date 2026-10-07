# Webhooks

[← @ton/watch](../README.md)

The service POSTs every transaction of the watched addresses to one or more
HTTP endpoints. Each target is a [consumer](consumers.md#consumer-api) named
`webhook:<name>`, so delivery has the same guarantees: per address (or global)
chain order, never past a gap, position stored after each transaction and
resumed after a restart.

| env | default | |
|---|---|---|
| `TON_WATCH_WEBHOOK_URL` | — | one target, named `default` |
| `TON_WATCH_WEBHOOKS` | — | JSON array of named targets (below) |
| `TON_WATCH_WEBHOOK_SECRET` | — | HMAC-SHA256 signing secret for every target; unsigned when unset |
| `TON_WATCH_WEBHOOK_SECRET_PREVIOUS` | — | while [rotating](#rotating-the-secret): the previous secret, signed with as well |
| `TON_WATCH_WEBHOOK_ORDER` | `address` | `address` or `global` (see [ordering](consumers.md#consumer-api)) |
| `TON_WATCH_WEBHOOK_FROM` | `earliest` | first run only: `earliest` (all indexed history), `now` or an lt |
| `TON_WATCH_WEBHOOK_TIMEOUT_MS` | `10000` | per request |
| `TON_WATCH_WEBHOOK_RETRY_MIN_MS` | `1000` | first retry delay, doubling per failure… |
| `TON_WATCH_WEBHOOK_RETRY_MAX_MS` | `60000` | …up to this |
| `TON_WATCH_WEBHOOK_ON_ERROR` | `retry` | `retry`, `skip` or `dead-letter`: what happens to a transaction the receiver keeps refusing (below) |
| `TON_WATCH_WEBHOOK_MAX_ATTEMPTS` | `5` | failed requests before `skip` / `dead-letter` gives up |

The `TON_WATCH_WEBHOOK_*` settings are defaults for every target; a
`TON_WATCH_WEBHOOKS` entry can override them and restrict the addresses:

```sh
TON_WATCH_WEBHOOKS='[
  {"name": "billing", "url": "https://billing.example/ton", "addresses": ["EQ…", "0:…"]},
  {"name": "ledger", "url": "https://ledger.example/in", "order": "global", "secret": "…"}
]'
```

`name` (`[A-Za-z0-9._-]`, at most 64) is required and identifies the stored
position: renaming a target starts it over from `from`, changing its URL does
not. Other keys: `url`, `secret`, `addresses`, `order`, `from`, `timeoutMs`,
`retryMinMs`, `retryMaxMs`, `onError`, `maxAttempts`; unknown keys are rejected.
`secret` is a string, or an array of them (current first) while rotating;
`"secret": null` sends that target unsigned even when `TON_WATCH_WEBHOOK_SECRET` is
set. An empty secret is rejected, and so is a `retryMinMs` above the target's
`retryMaxMs`.

**Delivery.** One request per transaction. A 2xx response is a delivery; the
position advances only after it. Anything else halts that address (in global
order: the whole stream), is logged and reported on `/health` (`degraded`) and
`/status`, and the same transaction is retried with backoff. What happens when it
keeps failing is the target's `onError` (the [consumer
policy](consumers.md#failures)):

| `onError` | retryable failure: network error, timeout, 408, 429, 5xx | rejection: redirect, other 4xx |
|---|---|---|
| `retry` (default) | retried forever; nothing is skipped | retried forever |
| `skip` | skipped after `maxAttempts` failed requests | skipped at once |
| `dead-letter` | dead-lettered after `maxAttempts` failed requests | dead-lettered at once |

A rejection is the receiver saying the request itself is wrong, so sending it
again unchanged will not help. Dead letters are listed with `ton-watch
dead-letters`, sent again with `ton-watch replay` once the receiver is fixed, or
dropped with `ton-watch discard` (see [the CLI](service.md#managing-consumers-from-the-cli)).

Over HTTP this is **at least once**: a request that times out may still have been
processed, and a crash after the receiver answered but before the position was
stored re-sends that transaction. Deduplicate on the `Idempotency-Key` header
(= `id` in the body), which is the same for every attempt.

**Request.** `POST` with `content-type: application/json`, `user-agent:
ton-watch/<version>` and these headers:

| header | |
|---|---|
| `Idempotency-Key` | the payload's `id`: `<raw address>:<lt>:<hex hash>` |
| `TON-Watch-Event` | the payload's `type` (`transaction`), to route before parsing |
| `TON-Watch-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=…]`, one `v1` per secret; only when a secret is set |
| `TON-Watch-Replay` | `1` on a replayed dead letter; absent otherwise |

**Payload, version 1** (`WebhookPayload` in `@ton/watch/webhook`). A real body, from
`tests/fixtures/golden/webhook-payload-ton-transfer-comment.json` (`boc` shortened):

```json
{
  "version": 1,
  "type": "transaction",
  "id": "0:852443f8599fe6a5da34fe43049ac4e0beb3071bb2bfb56635ea9421287c283a:108207748000020:47c766d5144f24f6945222f2885aa5038dae580b4c8bddaae0de58734236e8bc",
  "webhook": "default",
  "address": "0:852443f8599fe6a5da34fe43049ac4e0beb3071bb2bfb56635ea9421287c283a",
  "lt": "108207748000020",
  "hash": "47c766d5144f24f6945222f2885aa5038dae580b4c8bddaae0de58734236e8bc",
  "utime": 1791300482,
  "prev": {
    "lt": "108207746000012",
    "hash": "56fe46f45ef8a234d2055fdc2257c84d1974d57c65b2dd0c7118440f704b4f40"
  },
  "boc": "te6ccgECBwEAAbYAA7N4UkQ/hZn+al2jT+QwSaxOC+swcbsr…",
  "parsed": {
    "type": "generic",
    "success": true,
    "aborted": false,
    "compute": { "type": "vm", "success": true, "exitCode": 0, "gasUsed": "577" },
    "action": { "success": true, "resultCode": 0, "totalActions": 0, "skippedActions": 0 },
    "receivedBounce": false,
    "bouncedBack": false,
    "direction": "incoming",
    "inMessage": {
      "type": "internal",
      "src": "0:bb13003ac17ac2201a7124b7181d3b0c85fc54f254bc60c2eab319880047fc64",
      "dest": "0:852443f8599fe6a5da34fe43049ac4e0beb3071bb2bfb56635ea9421287c283a",
      "value": "962600000",
      "extraCurrencies": {},
      "bounce": false,
      "bounced": false,
      "fwdFee": "44446",
      "extraFlags": "0",
      "createdLt": "108207748000019",
      "createdAt": 1791300482,
      "op": 0,
      "queryId": null,
      "comment": "100 Telegram Stars \n\nRef#Ukt0LZIJA",
      "body": { "kind": "text-comment", "text": "100 Telegram Stars \n\nRef#Ukt0LZIJA" }
    },
    "outMessages": [],
    "totalFees": "38469",
    "valueIn": "962600000",
    "valueOut": "0"
  },
  "replay": false
}
```

Other golden bodies (jetton notification, NFT transfer, bounces) are in
[`tests/fixtures/golden/`](https://github.com/hos/ton-tools/tree/main/packages/ton-watch/tests/fixtures/golden). Encodings: lts and amounts
(nanotons, jetton units) are decimal strings; hashes lowercase hex; addresses
lowercase raw (`<workchain>:<hex>`); cells base64 BOCs, other binary data base64;
unix times, opcodes, exit codes and counts JSON numbers. `prev` is null for the
account's first transaction; `parsed` is null if the BOC could not be decoded. The
field names in `parsed` follow `ParsedTransaction` in [`@ton/watch/parse`](../src/parse/types.ts).

**Compatibility rules for receivers.**

- **Ignore fields you do not know.** New fields may appear in any object in any
  release without changing `version`.
- **Ignore event `type`s and body `kind`s you do not know**, and treat other
  enum-like strings (`direction`, the transaction `type`, …) as open sets too: new
  kinds of events, bodies or transactions may appear without changing `version`.
- `version` changes only when an existing field is removed, renamed or changes
  meaning, and only in a release announced as breaking.

A replay (`"replay": true`) arrives out of order — later transactions of the
address were delivered meanwhile — with the same `id` as the original attempts.
Deduplicate it like any other request: if an earlier attempt was processed after
all (e.g. one that timed out), answer 2xx without processing it again.

**Verifying the signature.** Compute the HMAC over the raw body bytes as received
(before any JSON parsing), compare in constant time, and reject old timestamps so
a captured request cannot be replayed later. Every retry is signed afresh, so a
five-minute window never rejects a legitimate retry. Pair it with the idempotency
key to drop replays inside the window. `@ton/watch/webhook` does all of this and
depends only on `node:crypto`:

```ts
import { SIGNATURE_HEADER, verifySignature, type WebhookPayload } from "@ton/watch/webhook";

// e.g. Bun.serve / fetch handlers:
const body = await request.text();
if (!verifySignature(SECRET, body, request.headers.get(SIGNATURE_HEADER))) {
  return new Response(null, { status: 401 });
}
const payload: WebhookPayload = JSON.parse(body);
if (payload.type !== "transaction") return new Response(null, { status: 204 }); // unknown event
```

`verifySignature(secrets, body, header, { toleranceSeconds = 300 })` takes one
secret or an array of them and is true if any `v1` signature in the header matches
any of them. Signature schemes other than `v1` are ignored.

## Rotating the secret

1. Set `TON_WATCH_WEBHOOK_SECRET=<new>` and `TON_WATCH_WEBHOOK_SECRET_PREVIOUS=<old>`
   (per target: `"secret": ["<new>", "<old>"]`) and restart. Every request now
   carries two `v1` signatures, so receivers still on the old secret keep verifying.
2. Switch the receivers to the new secret (or have them accept both during the
   switch: `verifySignature([NEW, OLD], …)`).
3. Remove `TON_WATCH_WEBHOOK_SECRET_PREVIOUS` and restart.

**Delivery apart from indexing.** `ton-watch deliver` runs only the webhook
consumers: no liteserver connection, same database and webhook settings. Run the
indexer with no webhook variables and one `deliver` process next to it to
restart, deploy or scale delivery without touching indexing. A `deliver` process
learns about new transactions by polling the store (every second). Run each
target in one process at a time: `deliver` exits 1 with `CONSUMER_LOCKED` if
a target already runs elsewhere (and starts none of them). `/health` and
`/status` report the webhook consumers; `/metrics` their counters; `/consumers`
every consumer in the database.
