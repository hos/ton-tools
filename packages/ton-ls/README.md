# @ton/ls

This is a server filter package for the TON (The Open Network) project. It run benchmarks on the servers and filters them based on the results.

## Installation

To install the package and its dependencies, use the following command:

```bash
npx jsr add @ton/ls
yarn dlx jsr add @ton/ls
pnpm dlx jsr add @ton/ls
bunx jsr add @ton/ls
```

## Usage

After installation, you can use the package in your project as follows:

```javascript
import { LiteClient, type LiteEngine, LiteRoundRobinEngine } from "ton-lite-client";

import { filterLiteServers, getServers, LiteConnection, type LsConfig } from "@ton/ls";

let liteClient: LiteClient;
let createLiteClient: Promise<void>;

const engines: LiteEngine[] = [];

export async function getLiteClient(_configUrl?: string): Promise<LiteClient> {
  if (liteClient) {
    return liteClient;
  }

  if (!createLiteClient) {
    createLiteClient = (async () => {
      const customURL = await getServers("https://ton-blockchain.github.io/global.config.json");
      const mainnetServers = await getServers("mainnet");
      const testnetServers = await getServers("testnet");
      const customServers = [{id: {key: "base64"}, ip: 123, }] as LsConfig[];


      // Same values as above can be passed here, mainnet, testnet, customURL or server list
      const { fast, good } = await filterLiteServers('mainnet', {
        timeout: 1000,
        divergeFromAvg: 100, // ms - at most 100ms slower than the avg response time
        // this will console.table the benchmark results
        verbosity: "info",
      });

      for (const server of fast) {
        const { lsConfig } = server;

        engines.push(
          new LiteConnection({
            host: lsConfig.host,
            publicKey: lsConfig.publicKey,
          })
        );
      }

      const engine: LiteEngine = new LiteRoundRobinEngine(engines);

      const lc = new LiteClient({
        engine,
        batchSize: 1,
      }) as LiteClient;

      liteClient = lc;
    })();
  }

  await createLiteClient;

  return liteClient;
}

```

## `LiteConnection`

`filterLiteServers()` closes every connection it opened before it resolves, so it
never keeps the process alive. For your own clients, `LiteConnection` is a
ton-lite-client `LiteEngine` for one liteserver that can be closed for good:
`close()` cancels reconnecting and query timeouts, destroys the socket and rejects
pending queries. ton-lite-client's `LiteSingleEngine` (3.1.x) does not, so a process
using it does not exit after `close()`.

```ts
const engine = new LiteConnection({ host: lsConfig.host, publicKey: lsConfig.publicKey });
const client = new LiteClient({ engine });
// ...
engine.close();
```

## Contributing

Contributions are welcome, after the project will be open sourced. Please submit a pull request or create an issue to discuss the changes you want to make.

## License

This project is licensed under the MIT License.