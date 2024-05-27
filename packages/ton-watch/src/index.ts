import { pgClient } from "./stores/pg/pg-client";

import { getLiteClient } from "./lite-client";
import { Watch } from "./watch";
import { PgStore } from "./stores";

const address = "";

const liteClient = await getLiteClient('mainnet');

const store = new PgStore(pgClient);
const watch = new Watch({ liteClient, store });

await watch.migrate({ drop: false });

if (address) {
  await watch.store.setAddress(address, 0n);
}

const allAddresses = await watch.store.allAddresses();
console.log(`Watching addresses:
  ${allAddresses.map((a) => ` "${a}"`).join("\n")}`);

await watch.start();

const {
  rows: [{ count }],
} = await pgClient.query(`select count(*) from transactions`);

console.log(`Stored ${count} transactions`);

// Cleanup on exit
await watch.close();
