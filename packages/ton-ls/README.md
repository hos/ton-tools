# @ton/ls

Pick working TON liteservers instead of hardcoding them. `@ton/ls` reads a network
config (mainnet, testnet, a config URL or your own list), benchmarks every
liteserver in it at once, and tells you which ones answer and which are fast.

```ts
import { filterLiteServers, LiteConnection } from "@ton/ls";
import { LiteClient, LiteRoundRobinEngine } from "ton-lite-client";

const { fast } = await filterLiteServers("mainnet", { timeout: 2000, divergeFromAvg: 100 });

const engine = new LiteRoundRobinEngine(
  fast.map(({ lsConfig }) => new LiteConnection(lsConfig)),
);
const client = new LiteClient({ engine });

console.log(await client.getMasterchainInfo());

engine.close(); // closes every connection; the process can exit
```

## Install

Published on [JSR](https://jsr.io/@ton/ls) (not on npm). Works with Node.js, Deno
and Bun.

```sh
npx jsr add @ton/ls     # Node.js
deno add jsr:@ton/ls    # Deno
bunx jsr add @ton/ls    # Bun
```

`ton-lite-client` comes along as a dependency; add it yourself (^3.1) to import
`LiteClient` as above.

## How servers are picked

`filterLiteServers(servers, options)`:

1. Resolves `servers` into a list of liteservers. It accepts:
   - `"mainnet"` or `"testnet"`: the official config from
     [ton.org](https://ton.org/global.config.json);
   - an `http(s)://` URL of a config in the same format;
   - a list of entries copied from a config's `liteservers` (`LsConfig[]`).
2. Opens a connection to every server in parallel and calls
   `getMasterchainInfo()` on each, up to 100 times or until `timeout` ms
   (default 3000) have passed.
3. Closes every connection, then sorts the servers into:

| field | meaning |
|---|---|
| `good` | answered at least once |
| `fast` | `good` servers whose average answer time is at most `divergeFromAvg` ms above the average of `good`; all of `good` when `divergeFromAvg` is not set |
| `fulfilled` | every server whose benchmark ran, working or not, with its numbers (`successCount`, `errorCount`, `timings`, `avgTiming`, `readyIn`, `seqnos`) |
| `rejected` | errors from benchmarks that could not run at all |
| `goodAvg`, `fastAvg` | average answer time (ms) of `good` and `fast` |

Each entry's `lsConfig` carries the original config plus `host`
(`tcp://<ip>:<port>`) and `publicKey` (a `Buffer`), ready for a connection.

Pass `verbosity: "info"` to print the `fast` servers as a table.

Lower-level pieces are exported too: `getServers(servers)` returns the resolved
list without benchmarking, `benchmark(lsConfig, timeout)` measures a single
server, and `intToIP(int)` turns a config's integer IP into dotted form.

## `LiteConnection`

A ton-lite-client `LiteEngine` for one liteserver: a single connection that
reconnects after it drops (after `reconnectMs`, default 10s) and sends queries
once it is ready.

```ts
const connection = new LiteConnection({ host: lsConfig.host, publicKey: lsConfig.publicKey });
const client = new LiteClient({ engine: connection });
// ...
connection.close();
```

`close()` is final: it cancels reconnecting and every query timeout, destroys the
socket (even mid-handshake) and rejects the queries still pending. Use it instead
of ton-lite-client's `LiteSingleEngine`, which keeps reconnecting after `close()`,
so a process using it does not exit.

`filterLiteServers()` and `benchmark()` close their own connections before they
resolve, so a benchmark never keeps the process alive either.

## License

[MIT](LICENSE.md)
