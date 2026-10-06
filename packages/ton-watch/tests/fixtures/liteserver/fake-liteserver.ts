/**
 * A liteserver on 127.0.0.1 speaking real ADNL over TCP, for tests that need actual
 * sockets: it completes the handshake, answers `getMasterchainInfoExt` and
 * `getAllShardsInfo` from the recorded mainnet tip (mainnet.json) and leaves every
 * other query unanswered, unless `errorMessage` makes it answer them with a
 * `liteServer.error`.
 */
import {
  type Cipheriv,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  type Decipheriv,
  diffieHellman,
  randomBytes,
} from "node:crypto";
import net from "node:net";
import { Codecs, Functions } from "ton-lite-client/dist/schema.js";
import { TLReadBuffer, TLWriteBuffer } from "ton-tl";
import mainnet from "./mainnet.json";

export interface FakeLiteserver {
  port: number;
  /** Ed25519 public key, base64, as in a global config. */
  publicKey: string;
  /** Sockets currently open on the server side. */
  readonly connections: number;
  close(): Promise<void>;
}

export interface FakeLiteserverOptions {
  /** Accept TCP connections but never answer the handshake. */
  silent?: boolean;
  /** Answer queries other than the tip ones with this error instead of never. */
  errorMessage?: string;
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const P = 2n ** 255n - 19n;

const LITE_QUERY = constructorId((w) =>
  Functions.liteServer_query.encodeRequest({ kind: "liteServer.query", data: Buffer.alloc(0) }, w),
);
const WAIT_SEQNO = constructorId((w) =>
  Functions.liteServer_waitMasterchainSeqno.encodeRequest(
    { kind: "liteServer.waitMasterchainSeqno", seqno: 0, timeoutMs: 0 },
    w,
  ),
);
const GET_MASTERCHAIN_INFO_EXT = constructorId((w) =>
  Functions.liteServer_getMasterchainInfoExt.encodeRequest(
    { kind: "liteServer.getMasterchainInfoExt", mode: 0 },
    w,
  ),
);
const GET_ALL_SHARDS_INFO = constructorId((w) =>
  Functions.liteServer_getAllShardsInfo.encodeRequest(
    { kind: "liteServer.getAllShardsInfo", id: tipBlock() },
    w,
  ),
);

/** A port nothing listens on: connections to it are refused. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function startFakeLiteserver(
  options: FakeLiteserverOptions = {},
): Promise<FakeLiteserver> {
  const seed = randomBytes(32);
  const edPrivate = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(edPrivate)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  // X25519 scalar of an Ed25519 key: the first half of SHA-512(seed) (clamped by X25519).
  const xPrivate = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, createHash("sha512").update(seed).digest().subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    // Silent: read (so the client's close is noticed) but never answer.
    if (options.silent) socket.resume();
    else serve(socket, xPrivate, options);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as net.AddressInfo).port,
    publicKey: Buffer.from(publicKey).toString("base64"),
    get connections() {
      return sockets.size;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function serve(
  socket: net.Socket,
  xPrivate: ReturnType<typeof createPrivateKey>,
  options: FakeLiteserverOptions,
): void {
  let pending = Buffer.alloc(0);
  let tx: Cipheriv | null = null;
  let rx: Decipheriv | null = null;

  const send = (payload: Buffer) => {
    const nonce = randomBytes(32);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length + 64);
    const hash = createHash("sha256").update(nonce).update(payload).digest();
    socket.write(tx!.update(Buffer.concat([size, nonce, payload, hash])));
  };

  socket.on("data", (chunk: Buffer) => {
    if (!rx) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 256) return;
      // Handshake: peer address hash, client key, params hash, encrypted params.
      const clientKey = pending.subarray(32, 64);
      const paramsHash = pending.subarray(64, 96);
      const shared = diffieHellman({
        privateKey: xPrivate,
        publicKey: createPublicKey({
          key: Buffer.concat([SPKI_X25519, edwardsToMontgomery(clientKey)]),
          format: "der",
          type: "spki",
        }),
      });
      const key = Buffer.concat([shared.subarray(0, 16), paramsHash.subarray(16, 32)]);
      const iv = Buffer.concat([paramsHash.subarray(0, 4), shared.subarray(20, 32)]);
      const params = createDecipheriv("aes-256-ctr", key, iv).update(pending.subarray(96, 256));
      // The client's receive key/nonce are our send key/nonce, and vice versa.
      tx = createCipheriv("aes-256-ctr", params.subarray(0, 32), params.subarray(64, 80));
      rx = createDecipheriv("aes-256-ctr", params.subarray(32, 64), params.subarray(80, 96));
      const rest = pending.subarray(256);
      pending = Buffer.alloc(0);
      send(Buffer.alloc(0));
      if (rest.length === 0) return;
      chunk = rest;
    }
    pending = Buffer.concat([pending, rx.update(chunk)]);
    while (pending.length >= 4) {
      const size = pending.readUInt32LE(0);
      if (pending.length < 4 + size) return;
      const payload = pending.subarray(36, 4 + size - 32);
      pending = pending.subarray(4 + size);
      const answer = answerFor(payload, options);
      if (answer) send(answer);
    }
  });
}

function answerFor(payload: Buffer, options: FakeLiteserverOptions): Buffer | null {
  const message = Codecs.adnl_Message.decode(new TLReadBuffer(payload));
  if (message.kind !== "adnl.message.query") return null;
  const query = new TLReadBuffer(message.query);
  if (query.readInt32() !== LITE_QUERY) return null;
  const request = new TLReadBuffer(query.readBuffer());
  let fn = request.readInt32();
  if (fn === WAIT_SEQNO) {
    request.readInt32();
    request.readInt32();
    fn = request.readInt32();
  }

  const writer = new TLWriteBuffer();
  if (fn === GET_MASTERCHAIN_INFO_EXT) {
    Codecs.liteServer_MasterchainInfoExt.encode(
      {
        kind: "liteServer.masterchainInfoExt",
        mode: 0,
        version: 0,
        capabilities: "0",
        last: tipBlock(),
        lastUtime: mainnet.tip.lastUtime,
        now: mainnet.tip.lastUtime,
        stateRootHash: Buffer.alloc(32),
        init: {
          kind: "tonNode.zeroStateIdExt",
          workchain: -1,
          rootHash: Buffer.alloc(32),
          fileHash: Buffer.alloc(32),
        },
      },
      writer,
    );
  } else if (fn === GET_ALL_SHARDS_INFO) {
    Codecs.liteServer_AllShardsInfo.encode(
      {
        kind: "liteServer.allShardsInfo",
        id: tipBlock(),
        proof: Buffer.alloc(0),
        data: Buffer.from(mainnet.tip.shardsData, "base64"),
      },
      writer,
    );
  } else if (options.errorMessage !== undefined) {
    Codecs.liteServer_Error.encode(
      { kind: "liteServer.error", code: 651, message: options.errorMessage },
      writer,
    );
  } else {
    return null;
  }
  const answer = new TLWriteBuffer();
  Codecs.adnl_Message.encode(
    { kind: "adnl.message.answer", queryId: message.queryId, answer: writer.build() },
    answer,
  );
  return answer.build();
}

function tipBlock() {
  const { last } = mainnet.tip;
  return {
    kind: "tonNode.blockIdExt" as const,
    workchain: last.workchain,
    shard: last.shard,
    seqno: last.seqno,
    rootHash: Buffer.from(last.rootHash, "hex"),
    fileHash: Buffer.from(last.fileHash, "hex"),
  };
}

function constructorId(encode: (writer: TLWriteBuffer) => void): number {
  const writer = new TLWriteBuffer();
  encode(writer);
  return writer.build().readInt32LE(0);
}

/** Ed25519 public key to the X25519 one: u = (1 + y) / (1 - y) mod p. */
function edwardsToMontgomery(edwards: Buffer): Buffer {
  const bytes = Buffer.from(edwards);
  bytes[31] = bytes[31]! & 0x7f;
  const y = BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`);
  const u = ((1n + y) * modPow((1n - y + P) % P, P - 2n)) % P;
  return Buffer.from(u.toString(16).padStart(64, "0"), "hex").reverse();
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = base % P;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}
