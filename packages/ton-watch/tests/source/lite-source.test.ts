import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Address } from "@ton/core";
import type { LsConfig } from "@ton/ls";
import { type LiteClient, LiteSingleEngine } from "ton-lite-client";
import type {
  liteServer_blockHeader,
  liteServer_blockTransactions,
  liteServer_transactionId,
  liteServer_transactionId3,
  tonNode_blockIdExt,
} from "ton-lite-client/dist/schema.js";
import { Functions } from "ton-lite-client/dist/schema.js";

import { SourceError } from "../../src/core/errors";
import type { TxId } from "../../src/core/types";
import { Metrics } from "../../src/metrics/metrics";
import {
  LiteSource,
  type LiteSourceOptions,
  serverPoolOf,
} from "../../src/source/liteserver/lite-source";
import type { PoolMember } from "../../src/source/liteserver/server-pool";
import type { ChainTip, ShardTop } from "../../src/source/source";
import mainnet from "../fixtures/liteserver/mainnet.json";
import { SHARD, type ShardTree, shardHashes } from "../fixtures/liteserver/shard-hashes";

// ---------------------------------------------------------------------------
// Fakes: LiteSource only talks to its pool members' `LiteClient`s, so tests build
// it around plain objects with the handful of client methods it uses.

type Fn = (...args: any[]) => Promise<any>;

interface FakeClient {
  getMasterchainInfoExt: ReturnType<typeof mock<Fn>>;
  engine: { query: ReturnType<typeof mock<Fn>> };
  getAccountTransactions: ReturnType<typeof mock<Fn>>;
  lookupBlockByLt: ReturnType<typeof mock<Fn>>;
  lookupBlockByID: ReturnType<typeof mock<Fn>>;
  listBlockTransactions: ReturnType<typeof mock<Fn>>;
}

const unexpected = (name: string) =>
  mock<Fn>(async () => {
    throw new Error(`unexpected call: ${name}`);
  });

function fakeClient(
  impl: Partial<Record<Exclude<keyof FakeClient, "engine">, Fn>> & {
    query?: Fn;
  },
): FakeClient {
  const pick = (name: Exclude<keyof FakeClient, "engine"> | "query") =>
    impl[name] ? mock<Fn>(impl[name]) : unexpected(name);
  return {
    getMasterchainInfoExt: pick("getMasterchainInfoExt"),
    engine: { query: pick("query") },
    getAccountTransactions: pick("getAccountTransactions"),
    lookupBlockByLt: pick("lookupBlockByLt"),
    lookupBlockByID: pick("lookupBlockByID"),
    listBlockTransactions: pick("listBlockTransactions"),
  };
}

type SourceCtor = new (
  members: PoolMember<LiteClient>[],
  engines: { close(): void }[],
  options: LiteSourceOptions,
) => LiteSource;

/** A `LiteSource` over fake clients (the real constructor is private to `connect()`). */
function sourceOver(
  servers: (FakeClient | { client: FakeClient; archive: boolean })[],
  options: LiteSourceOptions = {},
  engines: { close(): void }[] = [],
): LiteSource {
  const members = servers.map((server, i) => {
    const { client, archive } = "client" in server ? server : { client: server, archive: false };
    return { id: `ls${i}`, archive, client: client as unknown as LiteClient };
  });
  return new (LiteSource as unknown as SourceCtor)(members, engines, {
    timeoutMs: 1_000,
    ...options,
  });
}

const hashOf = (n: number) => Buffer.alloc(32, n % 256);

function blockId(workchain: number, shard: string, seqno: number): tonNode_blockIdExt {
  return {
    kind: "tonNode.blockIdExt",
    workchain,
    shard,
    seqno,
    rootHash: hashOf(seqno),
    fileHash: hashOf(seqno + 1),
  };
}

const header = (id: tonNode_blockIdExt): liteServer_blockHeader => ({
  kind: "liteServer.blockHeader",
  id,
  mode: 0,
  headerProof: Buffer.alloc(0),
});

/** A client answering `getTip` from a sequence of masterchain blocks and shard layouts. */
function tipClient(tips: { seqno: number; utime?: number; shards: Record<number, ShardTree> }[]) {
  let i = 0;
  let current = tips[0]!;
  return fakeClient({
    getMasterchainInfoExt: async () => {
      current = tips[Math.min(i++, tips.length - 1)]!;
      return {
        kind: "liteServer.masterchainInfoExt",
        last: blockId(-1, SHARD.root, current.seqno),
        lastUtime: current.utime ?? 1_700_000_000 + current.seqno,
      };
    },
    query: async (f, req) => {
      expect(f).toBe(Functions.liteServer_getAllShardsInfo);
      expect(req.id.seqno).toBe(current.seqno);
      return { kind: "liteServer.allShardsInfo", data: shardHashes(current.shards) };
    },
  });
}

function shardTop(workchain: number, shard: string, seqno: number, endLt: bigint): ShardTop {
  const { kind: _, ...id } = blockId(workchain, shard, seqno);
  return { ...id, endLt };
}

function chainTip(seqno: number, shards: ShardTop[]): ChainTip {
  const { kind: _, ...block } = blockId(-1, SHARD.root, seqno);
  return { seqno, utime: 0, block, shards, syncLt: 0n };
}

const account = (firstByte: number, last = 0) =>
  Buffer.concat([Buffer.from([firstByte]), Buffer.alloc(30), Buffer.from([last])]);
const raw = (workchain: number, id: Buffer) => `${workchain}:${id.toString("hex")}`;

/**
 * Shard blocks with transaction ids, answering `lookupBlockByID` and
 * `listBlockTransactions` like a liteserver: ids sorted by (account, lt), paged
 * by `count`, continued strictly after `after` when mode bit 128 is set.
 */
class FakeBlocks {
  private readonly txs = new Map<string, { account: Buffer; lt: bigint; hash: Buffer }[]>();
  readonly listCalls: { seqno: number; mode: number; count: number; after: unknown; q: unknown }[] =
    [];

  add(workchain: number, shard: string, seqno: number, accountId: Buffer, lt: bigint) {
    const key = `${workchain}:${shard}:${seqno}`;
    const list = this.txs.get(key) ?? [];
    list.push({ account: accountId, lt, hash: hashOf(Number(lt)) });
    list.sort((a, b) => Buffer.compare(a.account, b.account) || Number(a.lt - b.lt));
    this.txs.set(key, list);
    return { lt, hash: hashOf(Number(lt)) } satisfies TxId;
  }

  client(extra: Parameters<typeof fakeClient>[0] = {}): FakeClient {
    return fakeClient({
      lookupBlockByID: async (b: { workchain: number; shard: string; seqno: number }) =>
        header(blockId(b.workchain, b.shard, b.seqno)),
      listBlockTransactions: async (
        id: tonNode_blockIdExt,
        args: { mode: number; count: number; after?: liteServer_transactionId3 | null },
        queryArgs: unknown,
      ): Promise<liteServer_blockTransactions> => {
        this.listCalls.push({
          seqno: id.seqno,
          mode: args.mode,
          count: args.count,
          after: args.after,
          q: queryArgs,
        });
        const all = this.txs.get(`${id.workchain}:${id.shard}:${id.seqno}`) ?? [];
        const after = args.mode & 128 ? args.after : null;
        const rest = after
          ? all.filter(
              (tx) =>
                Buffer.compare(tx.account, after.account) > 0 ||
                (tx.account.equals(after.account) && tx.lt > BigInt(after.lt)),
            )
          : all;
        const ids: liteServer_transactionId[] = rest.slice(0, args.count).map((tx) => ({
          kind: "liteServer.transactionId",
          mode: args.mode,
          account: tx.account,
          lt: tx.lt.toString(),
          hash: tx.hash,
        }));
        return {
          kind: "liteServer.blockTransactions",
          id,
          reqCount: args.count,
          incomplete: rest.length > args.count,
          ids,
          proof: Buffer.alloc(0),
        };
      },
      ...extra,
    });
  }
}

// ---------------------------------------------------------------------------
// Real mainnet responses (tests/fixtures/liteserver/mainnet.json).

const fixtureBlock = (b: typeof mainnet.tip.last): tonNode_blockIdExt => ({
  kind: "tonNode.blockIdExt",
  workchain: b.workchain,
  shard: b.shard,
  seqno: b.seqno,
  rootHash: Buffer.from(b.rootHash, "hex"),
  fileHash: Buffer.from(b.fileHash, "hex"),
});

const accountStateOf = (kind: string) => mainnet.accountStates.find((s) => s.kind === kind)!;

/** A client serving the captured tip and account states. */
function mainnetClient(extra: Parameters<typeof fakeClient>[0] = {}) {
  return fakeClient({
    getMasterchainInfoExt: async () => ({
      kind: "liteServer.masterchainInfoExt",
      last: fixtureBlock(mainnet.tip.last),
      lastUtime: mainnet.tip.lastUtime,
    }),
    query: async (f, req) => {
      if (f === Functions.liteServer_getAllShardsInfo) {
        return { data: Buffer.from(mainnet.tip.shardsData, "base64") };
      }
      if (f === Functions.liteServer_getAccountState) {
        const address = `${req.account.workchain}:${(req.account.id as Buffer).toString("hex")}`;
        const state = mainnet.accountStates.find((s) => s.address === address);
        if (!state) throw new Error(`no fixture for ${address}`);
        return { kind: "liteServer.accountState", proof: Buffer.from(state.proof, "base64") };
      }
      throw new Error("unexpected query");
    },
    ...extra,
  });
}

const txPages = mainnet.transactions.pages;
const pageFrom = (i: number): TxId => ({
  lt: BigInt(txPages[i]!.from.lt),
  hash: Buffer.from(txPages[i]!.from.hash, "hex"),
});
const pageBoc = (i: number) => ({
  ids: [],
  transactions: Buffer.from(txPages[i]!.transactions, "base64"),
});

// ---------------------------------------------------------------------------

describe("getTip", () => {
  test("reads the masterchain block and parses the real shard layout", async () => {
    const client = mainnetClient();
    const source = sourceOver([client]);
    const tip = await source.getTip();

    expect(tip.seqno).toBe(mainnet.tip.last.seqno);
    expect(tip.utime).toBe(mainnet.tip.lastUtime);
    expect(tip.block).toEqual({
      workchain: -1,
      shard: SHARD.root,
      seqno: mainnet.tip.last.seqno,
      rootHash: Buffer.from(mainnet.tip.last.rootHash, "hex"),
      fileHash: Buffer.from(mainnet.tip.last.fileHash, "hex"),
    });
    expect(tip.shards.length).toBeGreaterThan(0);
    expect(tip.shards.every((s) => s.workchain === 0)).toBe(true);
    expect(tip.syncLt).toBe(
      tip.shards.reduce((min, s) => (s.endLt < min ? s.endLt : min), tip.shards[0]!.endLt),
    );
    // The shards are asked for at exactly the block just returned.
    const [fn, req] = client.engine.query.mock.calls[0]!;
    expect(fn).toBe(Functions.liteServer_getAllShardsInfo);
    expect(req).toEqual({
      kind: "liteServer.getAllShardsInfo",
      id: fixtureBlock(mainnet.tip.last),
    });
  });

  test("syncLt is the lowest basechain end_lt, ignoring other workchains", async () => {
    const source = sourceOver([
      tipClient([
        {
          seqno: 10,
          shards: {
            0: [
              { seqno: 1, endLt: 5_000n },
              { seqno: 2, endLt: 4_000n },
            ],
            [-1]: { seqno: 3, endLt: 1_000n },
            7: { seqno: 4, endLt: 2_000n },
          },
        },
      ]),
    ]);
    const tip = await source.getTip();
    expect(tip.shards.length).toBe(4);
    expect(tip.syncLt).toBe(4_000n);
  });

  test("syncLt falls back to all shards without a basechain, and to 0 without shards", async () => {
    const other = sourceOver([
      tipClient([
        {
          seqno: 10,
          shards: {
            3: [
              { seqno: 1, endLt: 900n },
              { seqno: 2, endLt: 700n },
            ],
          },
        },
      ]),
    ]);
    expect((await other.getTip()).syncLt).toBe(700n);

    const none = sourceOver([tipClient([{ seqno: 10, shards: {} }])]);
    const tip = await none.getTip();
    expect(tip.shards).toEqual([]);
    expect(tip.syncLt).toBe(0n);
  });

  test("a lagging server cannot move the tip backwards", async () => {
    const source = sourceOver([
      tipClient([
        { seqno: 100, shards: { 0: { seqno: 50, endLt: 5_000n } } },
        { seqno: 99, shards: { 0: { seqno: 49, endLt: 4_000n } } },
        { seqno: 101, shards: { 0: { seqno: 51, endLt: 6_000n } } },
      ]),
    ]);
    const first = await source.getTip();
    expect(await source.getTip()).toBe(first);
    expect((await source.getTip()).seqno).toBe(101);
  });

  test("a failing server is retried on another one", async () => {
    const broken = fakeClient({
      getMasterchainInfoExt: async () => {
        throw new Error("socket hang up");
      },
    });
    const good = tipClient([{ seqno: 7, shards: { 0: { seqno: 1, endLt: 1n } } }]);
    const source = sourceOver([broken, good]);
    serverPoolOf(source).members[1]!.latencyMs = 10_000; // the broken one is tried first
    expect((await source.getTip()).seqno).toBe(7);
    expect(broken.getMasterchainInfoExt).toHaveBeenCalledTimes(1);
    expect(serverPoolOf(source).stats()[0]!.errors).toEqual({ network: 1 });
  });
});

describe("getLastTx", () => {
  test.each([
    ["active", "active basechain account"],
    ["uninit", "uninit account (has transactions, no code)"],
    ["masterchain", "masterchain account"],
  ])("%s: %s", async (kind) => {
    const client = mainnetClient();
    const source = sourceOver([client]);
    const tip = await source.getTip();
    const state = accountStateOf(kind);

    const got = await source.getLastTx(state.address, tip);
    expect(got?.lt.toString()).toBe(state.expected!.lt);
    expect(got?.hash.toString("hex")).toBe(state.expected!.hash);

    const address = Address.parse(state.address);
    const [fn, req, queryArgs] = client.engine.query.mock.calls.at(-1)!;
    expect(fn).toBe(Functions.liteServer_getAccountState);
    expect(req).toEqual({
      kind: "liteServer.getAccountState",
      id: fixtureBlock(mainnet.tip.last),
      account: { kind: "liteServer.accountId", workchain: address.workChain, id: address.hash },
    });
    // A lagging server waits for the block instead of answering from an older state.
    expect(queryArgs).toEqual({ awaitSeqno: tip.seqno, timeout: 5_000 });
  });

  test("an account that does not exist has no last transaction", async () => {
    const source = sourceOver([mainnetClient()]);
    const tip = await source.getTip();
    const state = accountStateOf("nonexistent");
    expect(state.expected).toBeNull();
    expect(await source.getLastTx(state.address, tip)).toBeNull();
  });

  test("accepts user-friendly addresses", async () => {
    const source = sourceOver([mainnetClient()]);
    const tip = await source.getTip();
    const state = accountStateOf("active");
    const friendly = Address.parse(state.address).toString();
    expect((await source.getLastTx(friendly, tip))?.lt.toString()).toBe(state.expected!.lt);
  });

  test("a lagging server's not-ready answer is retried elsewhere", async () => {
    const lagging = mainnetClient({
      query: async (f) => {
        if (f === Functions.liteServer_getAccountState) throw new Error("block is not applied");
        throw new Error("unexpected");
      },
    });
    const good = mainnetClient();
    const source = sourceOver([lagging, good]);
    serverPoolOf(source).members[1]!.latencyMs = 10_000;
    const tip = await sourceOver([mainnetClient()]).getTip();
    const state = accountStateOf("active");
    expect((await source.getLastTx(state.address, tip))?.lt.toString()).toBe(state.expected!.lt);
    expect(serverPoolOf(source).stats()[0]!.errors).toEqual({ not_ready: 1 });
  });

  test("a malformed proof fails the call", async () => {
    const source = sourceOver(
      [
        mainnetClient({
          query: async () => ({ proof: Buffer.from(mainnet.tip.shardsData, "base64") }),
        }),
      ],
      { maxAttempts: 2 },
    );
    const tip = chainTip(1, []);
    const err = await source.getLastTx(accountStateOf("active").address, tip).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.message).toMatch(/proof layout|ShardStateUnsplit/);
  });
});

describe("getTransactions", () => {
  const address = mainnet.transactions.address;

  test("returns a real page, newest first, linked by prev hashes", async () => {
    const client = fakeClient({ getAccountTransactions: async () => pageBoc(0) });
    const source = sourceOver([client]);
    const from = pageFrom(0);
    const page = await source.getTransactions(address, from, 16);

    expect(page.length).toBe(16);
    expect(page[0]!.lt).toBe(from.lt);
    expect(page[0]!.hash.equals(from.hash)).toBe(true);
    for (let i = 0; i + 1 < page.length; i++) {
      expect(page[i]!.prevLt).toBe(page[i + 1]!.lt);
      expect(page[i]!.prevHash.equals(page[i + 1]!.hash)).toBe(true);
    }
    expect(page.every((tx) => tx.address === address)).toBe(true);

    const [acc, lt, hash, count, queryArgs] = client.getAccountTransactions.mock.calls[0]!;
    expect((acc as Address).toRawString()).toBe(address);
    expect(lt).toBe(from.lt.toString());
    expect(hash).toEqual(from.hash);
    expect(count).toBe(16);
    // No tip seen yet: nothing to wait for.
    expect(queryArgs).toBeUndefined();
  });

  test("consecutive pages continue the chain", async () => {
    const source = sourceOver([
      fakeClient({
        getAccountTransactions: async (_a, lt: string) => {
          const i = txPages.findIndex((p) => p.from.lt === lt && p.count === 16);
          if (i < 0)
            throw new Error("cannot locate transaction in block with specified logical time");
          return pageBoc(i);
        },
      }),
    ]);
    const first = await source.getTransactions(address, pageFrom(0), 16);
    const last = first.at(-1)!;
    const second = await source.getTransactions(
      address,
      { lt: last.prevLt, hash: last.prevHash },
      16,
    );
    expect(second.length).toBe(16);
    expect(second[0]!.lt).toBe(last.prevLt);
    expect(new Set([...first, ...second].map((tx) => tx.lt)).size).toBe(32);
  });

  test("count is capped at the liteserver page size", async () => {
    const client = fakeClient({ getAccountTransactions: async () => pageBoc(0) });
    const source = sourceOver([client]);
    expect(source.maxPageSize).toBe(16);
    await source.getTransactions(address, pageFrom(0), 1_000);
    expect(client.getAccountTransactions.mock.calls[0]![3]).toBe(16);
  });

  test.each([
    [3, 1],
    [1, 2],
  ])("a page of %i", async (count, fixture) => {
    expect(txPages[fixture]!.count).toBe(count);
    const client = fakeClient({ getAccountTransactions: async () => pageBoc(fixture) });
    const page = await sourceOver([client]).getTransactions(address, pageFrom(fixture), count);
    expect(page.length).toBe(count);
    expect(client.getAccountTransactions.mock.calls[0]![3]).toBe(count);
  });

  test("a partial page (fewer than asked) is accepted", async () => {
    const page = await sourceOver([
      fakeClient({ getAccountTransactions: async () => pageBoc(1) }),
    ]).getTransactions(address, pageFrom(1), 16);
    expect(page.length).toBe(3);
  });

  test("waits for the newest known block once a tip has been seen", async () => {
    const client = tipClient([{ seqno: 555, shards: { 0: { seqno: 1, endLt: 1n } } }]);
    client.getAccountTransactions.mockImplementation(async () => pageBoc(2));
    const source = sourceOver([client]);
    await source.getTip();
    await source.getTransactions(address, pageFrom(2), 1);
    expect(client.getAccountTransactions.mock.calls[0]![4]).toEqual({
      awaitSeqno: 555,
      timeout: 5_000,
    });
  });

  test("a page for another hash is a bad response, never retried on the same server", async () => {
    const client = fakeClient({ getAccountTransactions: async () => pageBoc(1) });
    const source = sourceOver([client]);
    const from = { lt: pageFrom(1).lt, hash: Buffer.alloc(32, 7) };
    const err = await source.getTransactions(address, from, 3).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.kind).toBe("bad_response");
    expect(client.getAccountTransactions).toHaveBeenCalledTimes(1);
  });

  test("a page starting at the wrong transaction is a bad response", async () => {
    // Ask from the second transaction of page 1, get page 1 itself.
    const first = await sourceOver([
      fakeClient({ getAccountTransactions: async () => pageBoc(1) }),
    ]).getTransactions(address, pageFrom(1), 3);
    const second: TxId = { lt: first[1]!.lt, hash: first[1]!.hash };
    const err = await sourceOver([fakeClient({ getAccountTransactions: async () => pageBoc(1) })])
      .getTransactions(address, second, 3)
      .catch((e) => e);
    expect(err.kind).toBe("bad_response");
    expect(err.message).toMatch(/page starts at/);
  });

  test("a bad page from one server is fetched from another", async () => {
    const liar = fakeClient({ getAccountTransactions: async () => pageBoc(3) });
    const honest = fakeClient({ getAccountTransactions: async () => pageBoc(2) });
    const source = sourceOver([liar, honest]);
    serverPoolOf(source).members[1]!.latencyMs = 10_000;
    const page = await source.getTransactions(address, pageFrom(2), 1);
    expect(page.length).toBe(1);
    expect(liar.getAccountTransactions).toHaveBeenCalledTimes(1);
    expect(serverPoolOf(source).stats()[0]!.errors).toEqual({ bad_response: 1 });
  });

  test("an empty response is an error, not an empty page", async () => {
    const source = sourceOver(
      [
        fakeClient({
          getAccountTransactions: async () => ({ ids: [], transactions: Buffer.alloc(0) }),
        }),
      ],
      { maxAttempts: 2 },
    );
    const err = await source.getTransactions(address, pageFrom(0), 16).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
  });

  test("history the regular servers dropped comes from an archival server", async () => {
    // The real answer of a public liteserver for transactions it no longer keeps.
    const [missing] = mainnet.transactions.errors;
    expect(missing!.message).toMatch(/cannot locate transaction/);
    const regular = [1, 2].map(() =>
      fakeClient({
        getAccountTransactions: async () => {
          throw new Error(missing!.message);
        },
      }),
    );
    const archive = fakeClient({ getAccountTransactions: async () => pageBoc(0) });
    const source = sourceOver([...regular, { client: archive, archive: true }]);

    const page = await source.getTransactions(address, pageFrom(0), 16);
    expect(page.length).toBe(16);
    for (const client of regular) expect(client.getAccountTransactions).toHaveBeenCalledTimes(1);
    expect(archive.getAccountTransactions).toHaveBeenCalledTimes(1);
  });

  test("without an archival server, missing history fails as archive_unavailable", async () => {
    const source = sourceOver([
      fakeClient({
        getAccountTransactions: async () => {
          throw new Error(mainnet.transactions.errors[0]!.message);
        },
      }),
    ]);
    const err = await source.getTransactions(address, pageFrom(0), 16).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.kind).toBe("archive_unavailable");
  });
});

describe("findTxNear", () => {
  // Basechain split in two; the account lives in the upper half.
  const accountId = account(0xf0);
  const address = raw(0, accountId);
  const splitTip = (seqno: number, highSeqno: number, highEndLt: bigint) => ({
    seqno,
    shards: {
      0: [
        { seqno: 1_000, endLt: 10_000_000n },
        { seqno: highSeqno, endLt: highEndLt },
      ] as ShardTree,
    },
  });

  function setup(
    options: LiteSourceOptions = {},
    tips = [splitTip(10, 200, 1_000_000_000n)],
    nearSeqno = 150,
  ) {
    const blocks = new FakeBlocks();
    const client = blocks.client();
    const tipper = tipClient(tips);
    client.getMasterchainInfoExt = tipper.getMasterchainInfoExt;
    client.engine = tipper.engine;
    client.lookupBlockByLt.mockImplementation(async (b) =>
      header(blockId(b.workchain, b.shard, nearSeqno)),
    );
    return { blocks, client, source: sourceOver([client], options) };
  }

  test("finds the account's newest transaction in the block holding lt", async () => {
    const { blocks, client, source } = setup();
    blocks.add(0, SHARD.high, 150, account(0x80), 1n); // another account, sorted before
    blocks.add(0, SHARD.high, 150, accountId, 10n);
    const newest = blocks.add(0, SHARD.high, 150, accountId, 11n);
    blocks.add(0, SHARD.high, 150, account(0xff), 12n); // another account, sorted after

    expect(await source.findTxNear(address, 12_345n)).toEqual(newest);
    expect(client.lookupBlockByLt.mock.calls[0]![0]).toEqual({
      workchain: 0,
      shard: SHARD.high,
      lt: 12_345n,
    });
    // The listing starts right at the account.
    const call = blocks.listCalls.find((c) => c.seqno === 150)!;
    expect(call.mode).toBe(1 | 2 | 4 | 128);
    expect(call.count).toBe(16);
    expect(call.after).toEqual({ kind: "liteServer.transactionId3", account: accountId, lt: "0" });
  });

  test("walks back over earlier blocks in batches, preferring the newest hit", async () => {
    const { blocks, client, source } = setup();
    const want = blocks.add(0, SHARD.high, 141, accountId, 500n);
    blocks.add(0, SHARD.high, 138, accountId, 400n);
    expect(await source.findTxNear(address, 99_999n)).toEqual(want);
    // Two batches of 8 blocks: 150..143, then 142..135.
    const seqnos = client.lookupBlockByID.mock.calls.map(([b]) => b.seqno).sort((a, b) => b - a);
    expect(seqnos).toEqual(Array.from({ length: 16 }, (_, i) => 150 - i));
  });

  test("gives up after maxProbeBlocks", async () => {
    const { blocks, client, source } = setup({ maxProbeBlocks: 16 });
    blocks.add(0, SHARD.high, 100, accountId, 5n); // too far back
    expect(await source.findTxNear(address, 1n)).toBeNull();
    expect(client.lookupBlockByID).toHaveBeenCalledTimes(16);
  });

  test("other accounts' transactions are not hits", async () => {
    const { blocks, source } = setup({ maxProbeBlocks: 8 });
    blocks.add(0, SHARD.high, 150, account(0xf0, 1), 5n);
    blocks.add(0, SHARD.high, 149, account(0xf1), 6n);
    expect(await source.findTxNear(address, 1n)).toBeNull();
  });

  test("an account in a workchain without a shard top", async () => {
    const { client, source } = setup();
    expect(await source.findTxNear(raw(-1, accountId), 1n)).toBeNull();
    expect(client.lookupBlockByLt).not.toHaveBeenCalled();
  });

  test("fetches a tip only when none has been seen", async () => {
    const { client, source } = setup();
    await source.findTxNear(address, 1n);
    await source.findTxNear(address, 1n);
    expect(client.getMasterchainInfoExt).toHaveBeenCalledTimes(1);
  });

  test("hint: a sparse account is not searched for at all", async () => {
    const { client, source } = setup();
    // 4 txs * 1e9 lt / 1e6 lt per block (default) = 4000 blocks > 128.
    expect(await source.findTxNear(address, 1n, { ltPerTx: 1e9 })).toBeNull();
    expect(client.lookupBlockByLt).not.toHaveBeenCalled();
  });

  test("hint: a busy account is searched in a single batch", async () => {
    const { client, source } = setup();
    expect(await source.findTxNear(address, 1n, { ltPerTx: 1_000 })).toBeNull();
    expect(client.lookupBlockByID).toHaveBeenCalledTimes(8);
  });

  test("hint: lt per shard block is measured from consecutive tips", async () => {
    // Upper shard: 10 blocks for 5_000 lt between the first two tips = 500 lt per block.
    const measured = setup({}, [splitTip(10, 200, 1_000_000n), splitTip(11, 210, 1_005_000n)]);
    await measured.source.getTip();
    await measured.source.getTip();
    // 4 * 20_000 / 500 = 160 blocks > 128.
    expect(await measured.source.findTxNear(address, 1n, { ltPerTx: 20_000 })).toBeNull();
    expect(measured.client.lookupBlockByLt).not.toHaveBeenCalled();

    // With a single tip the default (1e6 lt per block) applies: 1 block, so it searches.
    const unmeasured = setup();
    await unmeasured.source.getTip();
    await unmeasured.source.findTxNear(address, 1n, { ltPerTx: 20_000 });
    expect(unmeasured.client.lookupBlockByLt).toHaveBeenCalledTimes(1);
  });
});

describe("getTouchedAccounts (blocks mode)", () => {
  const a = account(0x10);
  const b = account(0x20);
  const c = account(0x30);
  const basechain = new Set([0]);

  test("lists every new shard block once, including the seqnos skipped between tips", async () => {
    const blocks = new FakeBlocks();
    blocks.add(0, SHARD.root, 11, a, 100n);
    blocks.add(0, SHARD.root, 12, a, 200n);
    blocks.add(0, SHARD.root, 12, b, 210n);
    blocks.add(0, SHARD.root, 13, c, 300n);
    blocks.add(0, SHARD.root, 10, a, 50n); // already seen at prev
    const client = blocks.client();
    const source = sourceOver([client]);

    const prev = chainTip(1_000, [shardTop(0, SHARD.root, 10, 60n)]);
    const next = chainTip(1_002, [shardTop(0, SHARD.root, 13, 400n)]);
    const touched = await source.getTouchedAccounts(prev, next, basechain);

    expect(touched).toEqual(
      new Map([
        [raw(0, a), { lt: 200n, hash: hashOf(200) }],
        [raw(0, b), { lt: 210n, hash: hashOf(210) }],
        [raw(0, c), { lt: 300n, hash: hashOf(300) }],
      ]),
    );
    expect(blocks.listCalls.map((call) => call.seqno).sort()).toEqual([11, 12, 13]);
    // Only the blocks between the tops need a lookup; the new top's id is in the tip.
    expect(client.lookupBlockByID.mock.calls.map(([blk]) => blk.seqno).sort()).toEqual([11, 12]);
    for (const call of blocks.listCalls) {
      expect(call.mode).toBe(1 | 2 | 4);
      expect(call.count).toBe(256);
      expect(call.q).toEqual({ awaitSeqno: 1_002, timeout: 5_000 });
    }
  });

  test("follows incomplete listings page by page", async () => {
    const blocks = new FakeBlocks();
    let lt = 1n;
    for (let i = 0; i < 300; i++) blocks.add(0, SHARD.root, 11, account(i % 256, i >> 8), lt++);
    const source = sourceOver([blocks.client()]);
    const touched = await source.getTouchedAccounts(
      chainTip(1, [shardTop(0, SHARD.root, 10, 0n)]),
      chainTip(2, [shardTop(0, SHARD.root, 11, 0n)]),
      basechain,
    );
    expect(touched!.size).toBe(300);
    expect(blocks.listCalls.length).toBe(2);
    expect(blocks.listCalls[1]!.mode).toBe(1 | 2 | 4 | 128);
    expect(blocks.listCalls[1]!.after).toMatchObject({ kind: "liteServer.transactionId3" });
  });

  test("ids without account/lt/hash are skipped; an incomplete page without a cursor ends", async () => {
    const listBlockTransactions = mock<Fn>(async () => ({
      incomplete: true,
      ids: [
        { account: a, lt: "5", hash: hashOf(5) },
        { account: b, lt: null, hash: hashOf(6) },
        { account: null, lt: "7", hash: hashOf(7) },
      ],
    }));
    const source = sourceOver([fakeClient({ listBlockTransactions })]);
    const touched = await source.getTouchedAccounts(
      chainTip(1, [shardTop(0, SHARD.root, 10, 0n)]),
      chainTip(2, [shardTop(0, SHARD.root, 11, 0n)]),
      basechain,
    );
    expect(touched).toEqual(new Map([[raw(0, a), { lt: 5n, hash: hashOf(5) }]]));
    expect(listBlockTransactions).toHaveBeenCalledTimes(1);
  });

  test("masterchain blocks are listed when workchain -1 is watched", async () => {
    const blocks = new FakeBlocks();
    blocks.add(-1, SHARD.root, 101, a, 1n);
    blocks.add(-1, SHARD.root, 102, b, 2n);
    blocks.add(0, SHARD.root, 11, c, 3n);
    const client = blocks.client();
    const source = sourceOver([client]);
    const touched = await source.getTouchedAccounts(
      chainTip(100, [shardTop(0, SHARD.root, 10, 0n)]),
      chainTip(102, [shardTop(0, SHARD.root, 11, 0n)]),
      new Set([0, -1]),
    );
    expect([...touched!.keys()].sort()).toEqual([raw(-1, a), raw(-1, b), raw(0, c)].sort());
    expect(client.lookupBlockByID.mock.calls.map(([blk]) => [blk.workchain, blk.seqno])).toEqual([
      [-1, 101],
    ]);
  });

  test("only the masterchain", async () => {
    const blocks = new FakeBlocks();
    blocks.add(-1, SHARD.root, 6, a, 1n);
    const touched = await sourceOver([blocks.client()]).getTouchedAccounts(
      chainTip(5, [shardTop(0, SHARD.root, 10, 0n)]),
      chainTip(6, [shardTop(0, SHARD.root, 99, 0n)]),
      new Set([-1]),
    );
    expect([...touched!.keys()]).toEqual([raw(-1, a)]);
  });

  test("no new blocks: nothing touched, nothing asked", async () => {
    const client = new FakeBlocks().client();
    const tip = chainTip(5, [shardTop(0, SHARD.root, 10, 0n)]);
    expect(await sourceOver([client]).getTouchedAccounts(tip, tip, new Set([0, -1]))).toEqual(
      new Map(),
    );
    expect(client.listBlockTransactions).not.toHaveBeenCalled();
  });

  test("split shards are each followed", async () => {
    const blocks = new FakeBlocks();
    blocks.add(0, SHARD.low, 21, a, 1n);
    blocks.add(0, SHARD.high, 31, account(0xc0), 2n);
    const touched = await sourceOver([blocks.client()]).getTouchedAccounts(
      chainTip(1, [shardTop(0, SHARD.low, 20, 0n), shardTop(0, SHARD.high, 30, 0n)]),
      chainTip(2, [shardTop(0, SHARD.low, 21, 0n), shardTop(0, SHARD.high, 31, 0n)]),
      basechain,
    );
    expect(touched!.size).toBe(2);
  });

  test("a shard split between tips: cannot tell, fall back to polling", async () => {
    const client = new FakeBlocks().client();
    const touched = await sourceOver([client]).getTouchedAccounts(
      chainTip(1, [shardTop(0, SHARD.root, 10, 0n)]),
      chainTip(2, [shardTop(0, SHARD.low, 1, 0n), shardTop(0, SHARD.high, 1, 0n)]),
      basechain,
    );
    expect(touched).toBeNull();
    expect(client.listBlockTransactions).not.toHaveBeenCalled();
  });

  test("a shard merge between tips: cannot tell, fall back to polling", async () => {
    const touched = await sourceOver([new FakeBlocks().client()]).getTouchedAccounts(
      chainTip(1, [shardTop(0, SHARD.low, 10, 0n), shardTop(0, SHARD.high, 10, 0n)]),
      chainTip(2, [shardTop(0, SHARD.root, 11, 0n)]),
      basechain,
    );
    expect(touched).toBeNull();
  });

  test("a shard that disappeared while the others kept their ids", async () => {
    // A merge of two quarters into a half while the other half stays: the half is new.
    const touched = await sourceOver([new FakeBlocks().client()]).getTouchedAccounts(
      chainTip(1, [
        shardTop(0, SHARD.lowLow, 10, 0n),
        shardTop(0, SHARD.lowHigh, 10, 0n),
        shardTop(0, SHARD.high, 10, 0n),
      ]),
      chainTip(2, [shardTop(0, SHARD.high, 11, 0n)]),
      basechain,
    );
    expect(touched).toBeNull();
  });

  test("layout changes in unwatched workchains do not matter", async () => {
    const blocks = new FakeBlocks();
    blocks.add(0, SHARD.root, 11, a, 1n);
    const touched = await sourceOver([blocks.client()]).getTouchedAccounts(
      chainTip(1, [shardTop(0, SHARD.root, 10, 0n), shardTop(1, SHARD.root, 5, 0n)]),
      chainTip(2, [
        shardTop(0, SHARD.root, 11, 0n),
        shardTop(1, SHARD.low, 1, 0n),
        shardTop(1, SHARD.high, 1, 0n),
      ]),
      basechain,
    );
    expect([...touched!.keys()]).toEqual([raw(0, a)]);
  });

  test("too many pending blocks: fall back to polling", async () => {
    const client = new FakeBlocks().client();
    const source = sourceOver([client], { maxBlocksPerTick: 5 });
    const touched = await source.getTouchedAccounts(
      chainTip(1, [shardTop(0, SHARD.root, 10, 0n)]),
      chainTip(2, [shardTop(0, SHARD.root, 16, 0n)]),
      basechain,
    );
    expect(touched).toBeNull();
    expect(client.lookupBlockByID).not.toHaveBeenCalled();
    // Exactly at the limit is still listed.
    const ok = await source.getTouchedAccounts(
      chainTip(1, [shardTop(0, SHARD.root, 10, 0n)]),
      chainTip(2, [shardTop(0, SHARD.root, 15, 0n)]),
      basechain,
    );
    expect(ok).toEqual(new Map());
  });
});

describe("close", () => {
  test("closes every engine", async () => {
    const engines = [{ close: mock(() => {}) }, { close: mock(() => {}) }];
    await sourceOver([fakeClient({})], {}, engines).close();
    for (const engine of engines) expect(engine.close).toHaveBeenCalledTimes(1);
  });
});

describe("connect", () => {
  // No sockets: engines are real objects whose connection is stubbed out.
  let ready: (engine: LiteSingleEngine) => boolean;
  const spies: { mockRestore(): void }[] = [];

  beforeEach(() => {
    ready = () => true;
    spies.push(
      spyOn(
        LiteSingleEngine.prototype as unknown as { connect(): void },
        "connect",
      ).mockImplementation(() => {}),
      spyOn(LiteSingleEngine.prototype, "isReady").mockImplementation(function (
        this: LiteSingleEngine,
      ) {
        return ready(this);
      }),
      spyOn(LiteSingleEngine.prototype, "close").mockImplementation(() => {}),
    );
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  /** 192.168.0.1 as the global config stores it (signed 32-bit). */
  const ls = (ip: number, port: number): LsConfig => ({
    ip,
    port,
    id: { key: Buffer.alloc(32, port % 256).toString("base64") },
  });
  const SIGNED_192_168_0_1 = -1062731775;

  function logger() {
    const lines: string[] = [];
    const log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    return { lines, logger: { debug: log, info: log, warn: log, error: log } };
  }

  test("literal server lists: archival first, deduplicated, signed IPs decoded", async () => {
    const { lines, logger: log } = logger();
    const metrics = new Metrics();
    const source = await LiteSource.connect({
      servers: [ls(SIGNED_192_168_0_1, 1), ls(0x0a000002, 2), ls(SIGNED_192_168_0_1, 1)],
      archiveServers: [ls(0x0a000009, 9), ls(0x0a000002, 2)],
      metrics,
      logger: log,
    });
    expect(serverPoolOf(source).members.map((m) => [m.id, !!m.archive])).toEqual([
      ["tcp://10.0.0.9:9", true],
      ["tcp://10.0.0.2:2", true],
      ["tcp://192.168.0.1:1", false],
    ]);
    expect(source.metrics).toBe(metrics);
    expect(serverPoolOf(source).metrics).toBe(metrics);
    const engine = (serverPoolOf(source).members[2]!.client as LiteClient)
      .engine as LiteSingleEngine;
    expect(engine.host).toBe("tcp://192.168.0.1:1");
    expect(engine.publicKey).toEqual(Buffer.alloc(32, 1));
    // The pool sees the engine's connection state.
    ready = (e) => e !== engine;
    expect(
      serverPoolOf(source)
        .stats()
        .map((s) => s.ready),
    ).toEqual([true, true, false]);
    expect(lines).toEqual(["liteservers: 3/3 connected (2 archival configured)"]);
    await source.close();
    expect(LiteSingleEngine.prototype.close).toHaveBeenCalledTimes(3);
  });

  test("defaults to the mainnet global config", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ liteservers: [ls(0x7f000001, 4924)] })) as unknown as typeof fetch);
    try {
      const source = await LiteSource.connect();
      expect(fetchSpy.mock.calls[0]![0]).toBe("https://ton.org/global.config.json");
      expect(serverPoolOf(source).members.map((m) => m.id)).toEqual(["tcp://127.0.0.1:4924"]);
      expect(serverPoolOf(source).members[0]!.archive).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a config URL is fetched", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({
        liteservers: [ls(0x7f000001, 1), ls(0x7f000001, 2)],
      })) as unknown as typeof fetch);
    try {
      const source = await LiteSource.connect({ servers: "https://example.org/config.json" });
      expect(fetchSpy.mock.calls[0]![0]).toBe("https://example.org/config.json");
      expect(serverPoolOf(source).members.length).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("waits for the first connection", async () => {
    const started = Date.now();
    ready = () => Date.now() - started > 150;
    const { lines, logger: log } = logger();
    const source = await LiteSource.connect({
      servers: [ls(1, 1), ls(2, 2)],
      connectTimeoutMs: 5_000,
      logger: log,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(serverPoolOf(source).members.length).toBe(2);
    expect(lines[0]).toBe("liteservers: 2/2 connected (0 archival configured)");
  });

  test("no server reachable: a network error, engines closed", async () => {
    ready = () => false;
    const err = await LiteSource.connect({
      servers: [ls(1, 1), ls(2, 2)],
      connectTimeoutMs: 20,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.kind).toBe("network");
    expect(LiteSingleEngine.prototype.close).toHaveBeenCalledTimes(2);
  });
});
