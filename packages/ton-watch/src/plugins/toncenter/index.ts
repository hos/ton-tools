/**
 * toncenter as a history plug-in for ton-watch. Imported separately and entirely
 * optional:
 *
 *   import { ToncenterHistory } from "ton-watch/toncenter";
 *   new TonWatch({ store, source, history: { source: new ToncenterHistory({ apiKey }) } });
 *
 * @module
 */
export { ToncenterHistory, type ToncenterHistoryOptions } from "./toncenter-history";
