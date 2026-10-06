import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { ADNLClientTCP } from "adnl";
import type { LiteEngine } from "ton-lite-client";
import { Codecs, Functions } from "ton-lite-client/dist/schema.js";
import { type TLFunction, TLReadBuffer, TLWriteBuffer } from "ton-tl";

/** Same default as ton-lite-client: also the server-side `waitMasterchainSeqno` timeout. */
const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
/** Delay before reconnecting after the connection closed. */
const DEFAULT_RECONNECT_MS = 10_000;
/** `liteServer.error` constructor id: the answer is an error, not the response. */
const LITE_SERVER_ERROR = -1146494648;

interface PendingQuery {
  packet: Buffer;
  decode: (reader: TLReadBuffer) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ADNL-over-TCP client that can be torn down at any point. `ADNLClient.end()` only
 * half-closes the socket (it stays open until the peer answers the FIN) and does
 * nothing while the handshake keys are still being generated, after which
 * `connect()` would open the socket anyway.
 */
class AdnlConnection extends ADNLClientTCP {
  private destroyed = false;

  override async connect(): Promise<void> {
    await this.onBeforeConnect();
    if (!this.destroyed) this.socket.connect(this.port, this.host);
  }

  destroy(): void {
    this.destroyed = true;
    this.socket.destroy();
  }
}

/** Options of a `LiteConnection`. */
export interface LiteConnectionOptions {
  /** `tcp://<ip>:<port>`, as `LsConfigResolved.host`. */
  host: string;
  /** The server's Ed25519 public key (32 bytes). */
  publicKey: Buffer;
  /** Delay before reconnecting after the connection dropped. Default 10s. */
  reconnectMs?: number;
}

/**
 * A ton-lite-client `LiteEngine` for one liteserver: one ADNL connection,
 * reconnected after it drops, with queries sent once it is ready. Use it as
 * `new LiteClient({ engine: new LiteConnection(...) })` and `close()` it when done.
 *
 * Replaces ton-lite-client's `LiteSingleEngine` (3.1.1), whose `close()` leaves the
 * process unable to exit: after a connection error it unconditionally reopens the
 * connection 30s later, even once closed, so an unreachable server keeps the event
 * loop alive forever; it also never clears its per-query timeouts or reconnect timer
 * and only half-closes the socket. Here `close()` cancels every timer, destroys the
 * socket and rejects the queries still pending.
 */
export class LiteConnection extends EventEmitter implements LiteEngine {
  readonly host: string;
  readonly publicKey: Buffer;
  private readonly reconnectMs: number;
  private client: AdnlConnection | null = null;
  private ready = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queries = new Map<string, PendingQuery>();

  constructor(args: LiteConnectionOptions) {
    super();
    this.host = args.host;
    this.publicKey = args.publicKey;
    this.reconnectMs = args.reconnectMs ?? DEFAULT_RECONNECT_MS;
    this.connect();
  }

  /** True once `close()` was called. */
  isClosed(): boolean {
    return this.closed;
  }

  /** True while the connection is established and handshaken. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Sends one query; rejects with `Timeout` after `timeout` ms (default 5s), with
   * the server's message on a `liteServer.error`, and with `Engine is closed` once
   * closed. Queries made before the connection is ready are sent when it is.
   */
  query<REQ, RES>(
    f: TLFunction<REQ, RES>,
    req: REQ,
    args: { timeout?: number; awaitSeqno?: number } = {},
  ): Promise<RES> {
    if (this.closed) return Promise.reject(new Error("Engine is closed"));
    const timeout = args.timeout ?? DEFAULT_QUERY_TIMEOUT_MS;
    const queryId = randomBytes(32);

    const request = new TLWriteBuffer();
    if (args.awaitSeqno !== undefined) {
      Functions.liteServer_waitMasterchainSeqno.encodeRequest(
        { kind: "liteServer.waitMasterchainSeqno", seqno: args.awaitSeqno, timeoutMs: timeout },
        request,
      );
    }
    f.encodeRequest(req, request);
    const liteQuery = new TLWriteBuffer();
    Functions.liteServer_query.encodeRequest(
      { kind: "liteServer.query", data: request.build() },
      liteQuery,
    );
    const message = new TLWriteBuffer();
    Codecs.adnl_Message.encode(
      { kind: "adnl.message.query", queryId, query: liteQuery.build() },
      message,
    );
    const packet = message.build();

    return new Promise<RES>((resolve, reject) => {
      const key = queryId.toString("hex");
      const timer = setTimeout(() => {
        this.queries.delete(key);
        reject(new Error("Timeout"));
      }, timeout);
      this.queries.set(key, {
        packet,
        decode: (reader) => f.decodeResponse(reader),
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      // Not connected yet: sent once the connection is ready.
      if (this.ready) this.client?.write(packet);
    });
  }

  /** Final: cancels reconnecting, destroys the socket and rejects pending queries. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.client?.destroy();
    this.client = null;
    const pending = [...this.queries.values()];
    this.queries.clear();
    for (const query of pending) {
      clearTimeout(query.timer);
      query.reject(new Error("Engine is closed"));
    }
    this.emit("close");
  }

  private connect(): void {
    const client = new AdnlConnection(this.host, this.publicKey);
    this.client = client;
    const current = () => this.client === client;
    client.on("connect", () => {
      if (current()) this.emit("connect");
    });
    client.on("ready", () => {
      if (!current()) return;
      this.ready = true;
      for (const query of this.queries.values()) client.write(query.packet);
      this.emit("ready");
    });
    client.on("data", (data: Buffer) => {
      if (current()) this.onData(data);
    });
    // A socket error is followed by `close`, which schedules the reconnect.
    client.on("error", () => {
      if (current()) client.destroy();
    });
    client.on("close", () => {
      if (current()) this.onDisconnected();
    });
    client.connect().catch(() => {
      if (current()) {
        client.destroy();
        this.onDisconnected();
      }
    });
  }

  private onDisconnected(): void {
    this.client = null;
    this.ready = false;
    if (this.closed || this.reconnectTimer) return;
    this.emit("close");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect();
    }, this.reconnectMs);
  }

  private onData(data: Buffer): void {
    let message: ReturnType<typeof Codecs.adnl_Message.decode>;
    try {
      message = Codecs.adnl_Message.decode(new TLReadBuffer(data));
    } catch {
      return;
    }
    if (message.kind !== "adnl.message.answer") return;
    const key = message.queryId.toString("hex");
    const query = this.queries.get(key);
    if (!query) return;
    this.queries.delete(key);
    clearTimeout(query.timer);
    try {
      if (message.answer.readInt32LE(0) === LITE_SERVER_ERROR) {
        const error = Codecs.liteServer_Error.decode(new TLReadBuffer(message.answer));
        query.reject(new Error(error.message));
      } else {
        query.resolve(query.decode(new TLReadBuffer(message.answer)));
      }
    } catch (error) {
      query.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
