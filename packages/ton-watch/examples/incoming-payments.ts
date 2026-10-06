/**
 * Example: record incoming TON payments of a few addresses into your own table,
 * exactly once, in chain order.
 *
 *   DATABASE_URL=postgres://… bun run examples/incoming-payments.ts EQ…address
 */
import { Pool } from "pg";
import { LiteSource, PgStore, TonWatch } from "../src";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const watch = new TonWatch({
  store: new PgStore(pool, { onClose: () => pool.end() }),
  source: await LiteSource.connect({ servers: "mainnet" }),
});
await watch.init();
await pool.query(`create table if not exists payments (
  tx_hash bytea primary key, address text, sender text, amount numeric, utime integer)`);

for (const address of process.argv.slice(2)) {
  // "now": only what happens from here on. Use { from: "genesis" } for full history.
  await watch.addAddress(address, { from: "now" });
}

watch.process("payments", async (tx, ctx) => {
  const msg = tx.transaction.inMessage;
  if (msg?.info.type !== "internal") return;
  // ctx.db is the transaction the consumer cursor is committed in: this insert and
  // the cursor commit together, so a crash never records a payment twice or loses one.
  const db = ctx.db as Pool;
  await db.query(`insert into payments values ($1, $2, $3, $4, $5)`, [
    tx.hash,
    tx.address,
    msg.info.src.toString(),
    msg.info.value.coins.toString(),
    tx.utime,
  ]);
});

await watch.start();
process.on("SIGINT", () => void watch.stop().then(() => process.exit(0)));
