// import axios from 'axios'
import {
  LiteClient,
  type LiteEngine,
  LiteRoundRobinEngine,
  LiteSingleEngine,
} from "ton-lite-client";
import { LRUMap } from "lru_map";
import { createHash } from "node:crypto";
import { filterLiteServers, type ServerDefinition } from "@ton/ls";

const engines: LiteEngine[] = [];

const clients = new Map<string, LiteClient>();

export async function getLiteClient(
  config: ServerDefinition = "mainnet"
): Promise<LiteClient> {
  const configHash =
    typeof config === "string"
      ? config
      : createHash("md5")
          .update(JSON.stringify(config))
          .digest("hex")
          .toString();

  const cachedLc = clients.get(configHash);
  if (cachedLc) {
    return cachedLc;
  }

  const createLiteClient = (async () => {
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

    return lc;
  })();

  const lc = await createLiteClient;

  clients.set(configHash, lc);

  return lc;
}
