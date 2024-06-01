import { pgClient, type Transactions } from "./stores/pg/pg-client";

import { getLiteClient } from "./lite-client";
import { Watch } from "./watch";
import { PgStore } from "./stores";
import { Cell, loadTransaction } from "@ton/core";

const address = "UQCJTkhd1W2wztkVNp_dsKBpv2SIoUWoIyzI7mQrbSrj_Ilk";

const liteClient = await getLiteClient("mainnet");

const store = new PgStore(pgClient);
const watch = new Watch({ liteClient, store });

await watch.store.start({ drop: true });

if (address) {
  await watch.store.setAddress(address, 0n);
}

const allAddresses = await watch.store.allAddresses();
console.log(`Watching addresses:
  ${allAddresses.map((a) => ` "${a}"`).join("\n")}`);

await watch.start();

const {
  rows: [{ boc }],
} = await pgClient.query<Pick<Transactions, "boc">>(
  `select boc from transactions order by created_at desc limit 1`
);

if (!boc) {
  throw new Error("No transactions found");
}

const cell = Cell.fromBoc(boc)[0];
const tx = loadTransaction(cell.beginParse());

console.log(`Last transaction: ${tx.hash().toString("hex")}`);

// Cleanup on exit
// await watch.close();
