// import axios from 'axios'
import {
  LiteClient,
  type LiteEngine,
  LiteRoundRobinEngine,
  LiteSingleEngine,
} from "ton-lite-client";
import { LRUMap } from "lru_map";

import { filterLiteServers, type ServerDefinition } from "../../ton-ls/src";

let liteClient: LiteClient;
let createLiteClient: Promise<void>;

const engines: LiteEngine[] = [];

export async function getLiteClient(
  config: ServerDefinition = 'mainnet'
): Promise<LiteClient> {
  if (liteClient) {
    return liteClient;
  }

  if (!createLiteClient) {
    createLiteClient = (async () => {
      const { fast } = await filterLiteServers(config, {
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

      const cacheMap = new LRUMap(5000);
      const lc = new LiteClient({
        engine,
        cacheMap: () => cacheMap,
        batchSize: 1,
      }) as LiteClient;

      liteClient = lc;
    })();
  }

  await createLiteClient;

  return liteClient;
}
