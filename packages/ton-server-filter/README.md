# @ton/server-filter

This is a server filter package for the TON (The Open Network) project. It run benchmarks on the servers and filters them based on the results.

## Installation

To install the package and its dependencies, use the following command:

```bash
npx jsr add @ton/server-filter
yarn dlx jsr add @ton/server-filter
pnpm dlx jsr add @ton/server-filter
bunx jsr add @ton/server-filter
```

## Usage

After installation, you can use the package in your project as follows:

```javascript
// import axios from 'axios'
import {
  LiteClient,
  type LiteEngine,
  LiteRoundRobinEngine,
  LiteSingleEngine,
} from "ton-lite-client";


import { filterLiteServers, type LsConfig, getServers } from "@ton/server-filter";

let liteClient: LiteClient;
let createLiteClient: Promise<void>;

const engines: LiteEngine[] = [];

export async function getLiteClient(_configUrl?: string): Promise<LiteClient> {
  if (liteClient) {
    return liteClient;
  }

  if (!createLiteClient) {
    createLiteClient = (async () => {
      const customURL = await getServers("https://ton.org/global.config.json");
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
          new LiteSingleEngine({
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

## Contributing

Contributions are welcome, after the project will be open sourced. Please submit a pull request or create an issue to discuss the changes you want to make.

## License

This project is licensed under the MIT License.