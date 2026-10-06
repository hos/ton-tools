/**
 * toncenter as a history plug-in for ton-watch. Imported separately and entirely
 * optional:
 *
 *   import { ToncenterHistory } from "ton-watch/toncenter";
 *   new TonWatch({ store, source, history: { source: new ToncenterHistory({ apiKey }) } });
 *
 * Experimental: covered by unit tests against a recorded toncenter response and by
 * the free-tier mainnet check in tests/live.test.ts (`LIVE=1`). Paid-plan rate limits
 * and long runs at volume are not tested. Every page is still re-hashed and
 * chain-checked, so a bad answer is rejected rather than stored.
 *
 * @experimental
 * @module
 */
export { ToncenterHistory, type ToncenterHistoryOptions } from "./toncenter-history";
