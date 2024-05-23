import { test, beforeAll, expect } from "bun:test";
import { pgClient } from "../src/database";
import { forEachTx } from "../src/forEachTx";

beforeAll(async () => {
  // await pgClient.query(`delete from wallet_transactions`);
});

test(
  "test it",
  async () => {
    for (let a = 0; a < 100; a++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await forEachTx("EQCA14o1-VWhS2efqoh_9M1b_A9DtKTuoqfmkn83AbJzwnPi");
      console.log("done: ", a);
    }

    const { rowCount } = await pgClient.query(
      `select * from wallet_transactions`
    );

    expect(rowCount).toBe(73);
  },
  { timeout: 1000000 }
);
