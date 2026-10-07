/**
 * Pick working TON liteservers: `filterLiteServers()` benchmarks every server of a
 * network config and returns the ones that answer (`good`) and the fastest of them
 * (`fast`). `LiteConnection` is a ton-lite-client engine for one server whose
 * `close()` leaves nothing running.
 *
 * @module
 */
export * from "./filter.ts";
export * from "./ip.ts";
export { LiteConnection, type LiteConnectionOptions } from "./lite-connection.ts";
