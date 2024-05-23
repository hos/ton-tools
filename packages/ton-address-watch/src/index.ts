import { fromNano } from "@ton/core";
import { pgClient } from "./database";

import { forEachTx } from "./forEachTx";

await pgClient.query(`delete from wallet_transactions`);

let count = 0;

await forEachTx("ADDRESS_HERE", {
  beforeWrite: async (tx) => {
    console.log(`${tx.lt} ${fromNano(tx.totalFees.coins)} /// ${count++}`);
  },
});
