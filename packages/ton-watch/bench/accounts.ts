/**
 * Picks the benchmark address sets once and saves them, so every benchmark run
 * (and re-run after an optimization) uses the same addresses.
 *
 *   bun run bench/accounts.ts
 */
import { saveResult, sampleActiveAccounts, toncenter } from "./lib";

// Sample ~24k recent transactions spread over 12 hours.
const ranked = await sampleActiveAccounts(24, 12);
console.log(`sampled ${ranked.length} distinct active accounts`);

const GETGEMS_FEE = "0:584EE61B2DFF0837116D0FCB5078D93964BCBE9C05FD6A141B1BFCA5D6A43E18";

/** Transactions per day of an account, from its last 1000 (toncenter). */
async function perDay(account: string) {
  const { transactions } = await toncenter("/transactions", { account, limit: 1000, sort: "desc" });
  if (transactions.length < 2) return 0;
  const span = transactions[0].now - transactions.at(-1).now;
  return Math.round((transactions.length / Math.max(span, 1)) * 86400);
}

// Outage set: the Getgems fee wallet plus busy-but-not-extreme accounts
// (marketplace/DEX scale: roughly 300–20,000 tx/day).
const outage: { address: string; perDay: number }[] = [
  { address: GETGEMS_FEE, perDay: await perDay(GETGEMS_FEE) },
];
for (const [address] of ranked.slice(0, 120)) {
  if (outage.length >= 10) break;
  if (address === GETGEMS_FEE) continue;
  const rate = await perDay(address);
  if (rate >= 300 && rate <= 20_000) outage.push({ address, perDay: rate });
}
console.log("outage set:", outage);

saveResult("accounts", {
  sampledAt: new Date().toISOString(),
  // Most active first; backfill uses the first N.
  active: ranked.slice(0, 1000).map(([address, seen]) => ({ address, seen })),
  outage,
});
process.exit(0);
