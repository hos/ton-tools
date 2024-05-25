// import axios from 'axios'
import {
  LiteClient,
  type LiteEngine,
  LiteRoundRobinEngine,
  LiteSingleEngine,
} from "ton-lite-client";
import { LRUMap } from "lru_map";

import { TON_NETWORK_CONFIG_URL } from "./config";
import type { LsConfig } from "./types";
import { filterLiteServers } from "../../ton-ls/src";

let liteClient: LiteClient;
let createLiteClient: Promise<void>;

const engines: LiteEngine[] = [];

export async function getLiteClient(_configUrl?: string): Promise<LiteClient> {
  if (liteClient) {
    return liteClient;
  }

  if (!createLiteClient) {
    createLiteClient = (async () => {
      const data = await fetch(TON_NETWORK_CONFIG_URL).then((r) => r.json());

      const liteServers = data.liteservers as LsConfig[];
      const { fast } = await filterLiteServers(liteServers, {
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
