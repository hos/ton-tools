import { Address, Cell } from "@ton/core";
import { getServers, type LsConfig, type ServerDefinition } from "@ton/ls";
import { LiteClient, LiteSingleEngine } from "ton-lite-client";
import type {
  liteServer_accountState,
  liteServer_allShardsInfo,
  liteServer_blockTransactions,
  liteServer_transactionId3,
  tonNode_blockIdExt,
} from "ton-lite-client/dist/schema.js";
import { Functions } from "ton-lite-client/dist/schema.js";

import { validatePage } from "../../core/chain";
import { SourceError } from "../../core/errors";
import { recordFromCell } from "../../core/transaction";
import type { TxId, TxRecord } from "../../core/types";
import { Metrics } from "../../metrics/metrics";
import { sleep } from "../../util/async";
import { silentLogger } from "../../util/logger";
import type { BlockRef, ChainTip, ShardTop, TxSource } from "../source";
import { lastTxFromStateProof } from "./account-proof";
import {
  type PoolMember,
  ServerPool,
  type ServerPoolOptions,
  type ServerStats,
} from "./server-pool";
import { MASTERCHAIN_SHARD, parseShardTops, shardContains } from "./shards";

export interface LiteSourceOptions extends ServerPoolOptions {
  /** Regular liteservers. Default: mainnet public config. */
  servers?: ServerDefinition;
  /** Archival liteservers, asked only for history the regular ones no longer have. */
  archiveServers?: ServerDefinition;
  /** How long to wait for the first connections. Default 10s. */
  connectTimeoutMs?: number;
  /** Blocks mode gives up (returns null → poll) when more shard blocks than this are pending. Default 400. */
  maxBlocksPerTick?: number;
  /** `findTxNear` gives up after looking at this many shard blocks. Default 128. */
  maxProbeBlocks?: number;
}

/** Liteservers cap `getTransactions` at 16 per call. */
const LITESERVER_MAX_PAGE_SIZE = 16;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BLOCKS_PER_TICK = 400;
const DEFAULT_MAX_PROBE_BLOCKS = 128;
const CONNECT_POLL_MS = 100;
/** Extra wait after the first connection so the first calls spread over more servers. */
const CONNECT_SETTLE_MS = 500;
/** ton-lite-client response cache size per server. */
const CLIENT_CACHE_ENTRIES = 1000;
/** How long a lagging server may wait for a block it has not seen yet. */
const AWAIT_SEQNO_TIMEOUT_MS = 5_000;
/** Shard block lt span assumed until two tips have been observed. */
const DEFAULT_LT_PER_SHARD_BLOCK = 1_000_000;

/** Transaction ids per `listBlockTransactions` call when scanning whole blocks. */
const BLOCK_LIST_PAGE_SIZE = 256;
/** Transaction ids per `listBlockTransactions` call when probing for one account. */
const PROBE_LIST_PAGE_SIZE = 16;
/** Shard blocks probed in parallel by `findTxNear`. */
const PROBE_BATCH_BLOCKS = 8;
/** `findTxNear` searches about this many of the account's transactions' worth of blocks. */
const PROBE_SPAN_TXS = 4;

/** `liteServer.listBlockTransactions` mode bits. */
const ListMode = {
  account: 1,
  lt: 2,
  hash: 4,
  /** `after` is set: continue past that transaction. */
  after: 128,
} as const;
const LIST_IDS = ListMode.account | ListMode.lt | ListMode.hash;

/** The pool behind each `LiteSource`, for `serverPoolOf`. */
const pools = new WeakMap<LiteSource, ServerPool<LiteClient>>();

/**
 * The server pool of a `LiteSource`. Internal: for tests and benchmarks that make
 * raw liteserver calls through the same rotation; not part of the public API.
 */
export function serverPoolOf(source: LiteSource): ServerPool<LiteClient> {
  return pools.get(source)!;
}

/** Liteserver-backed `TxSource` with rotation, rate-limit backoff and archival fallback. */
export class LiteSource implements TxSource {
  readonly maxPageSize: number = LITESERVER_MAX_PAGE_SIZE;
  readonly metrics: Metrics;
  private readonly pool: ServerPool<LiteClient>;
  private readonly engines: LiteSingleEngine[];
  private readonly maxBlocksPerTick: number;
  private readonly maxProbeBlocks: number;
  private lastTip: ChainTip | null = null;
  private firstTip: ChainTip | null = null;

  private constructor(
    members: PoolMember<LiteClient>[],
    engines: LiteSingleEngine[],
    options: LiteSourceOptions,
  ) {
    this.metrics = options.metrics ?? new Metrics();
    this.pool = new ServerPool(members, { ...options, metrics: this.metrics });
    pools.set(this, this.pool);
    this.engines = engines;
    this.maxBlocksPerTick = options.maxBlocksPerTick ?? DEFAULT_MAX_BLOCKS_PER_TICK;
    this.maxProbeBlocks = options.maxProbeBlocks ?? DEFAULT_MAX_PROBE_BLOCKS;
  }

  /** Resolves the server lists, opens connections and waits for at least one. */
  static async connect(options: LiteSourceOptions = {}): Promise<LiteSource> {
    const logger = options.logger ?? silentLogger;
    const primary = await getServers(options.servers ?? "mainnet");
    const archive = options.archiveServers ? await getServers(options.archiveServers) : [];

    const engines: LiteSingleEngine[] = [];
    const members: PoolMember<LiteClient>[] = [];
    const seenHosts = new Set<string>();
    const addServer = (config: LsConfig, isArchive: boolean) => {
      const host = `tcp://${formatIpv4(config.ip)}:${config.port}`;
      if (seenHosts.has(host)) return;
      seenHosts.add(host);
      const engine = new LiteSingleEngine({
        host,
        publicKey: Buffer.from(config.id.key, "base64"),
      });
      // Connection errors surface as failed calls; the engine reconnects by itself.
      engine.on("error", () => {});
      engines.push(engine);
      members.push({
        id: host,
        archive: isArchive,
        client: new LiteClient({ engine, batchSize: 1, cacheMap: CLIENT_CACHE_ENTRIES }),
        isReady: () => engine.isReady(),
      });
    };
    for (const config of archive) addServer(config, true);
    for (const config of primary) addServer(config, false);

    const deadline = Date.now() + (options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    while (Date.now() < deadline && !engines.some((engine) => engine.isReady())) {
      await sleep(CONNECT_POLL_MS);
    }
    await sleep(CONNECT_SETTLE_MS);
    const ready = engines.filter((engine) => engine.isReady()).length;
    logger.info(
      `liteservers: ${ready}/${engines.length} connected (${archive.length} archival configured)`,
    );
    if (ready === 0) {
      for (const engine of engines) engine.close();
      throw new SourceError("network", "no liteserver could be reached");
    }
    return new LiteSource(members, engines, options);
  }

  /** Load, latency and errors of every liteserver, for status pages. */
  stats(): ServerStats[] {
    return this.pool.stats();
  }

  async getTip(): Promise<ChainTip> {
    const tip = await this.pool.call("getTip", async (client) => {
      const info = await client.getMasterchainInfoExt();
      const shardsInfo = (await client.engine.query(Functions.liteServer_getAllShardsInfo, {
        kind: "liteServer.getAllShardsInfo",
        id: info.last,
      })) as liteServer_allShardsInfo;
      const shards = parseShardTops(shardsInfo.data);
      return {
        seqno: info.last.seqno,
        utime: info.lastUtime,
        block: toBlockRef(info.last),
        shards,
        syncLt: syncLtOf(shards),
      } satisfies ChainTip;
    });
    // A lagging server must not move the tip backwards.
    if (this.lastTip && tip.seqno < this.lastTip.seqno) return this.lastTip;
    this.lastTip = tip;
    this.firstTip ??= tip;
    return tip;
  }

  async getLastTx(address: string, tip: ChainTip): Promise<TxId | null> {
    const account = Address.parse(address);
    return this.pool.call("getAccountState", async (client) => {
      const state = (await client.engine.query(
        Functions.liteServer_getAccountState,
        {
          kind: "liteServer.getAccountState",
          id: toBlockIdExt(tip.block),
          account: { kind: "liteServer.accountId", workchain: account.workChain, id: account.hash },
        },
        this.awaitSeqno(tip.seqno),
      )) as liteServer_accountState;
      return lastTxFromStateProof(state.proof, account.hash);
    });
  }

  async getTransactions(address: string, from: TxId, count: number): Promise<TxRecord[]> {
    const account = Address.parse(address);
    const rawAddress = account.toRawString();
    return this.pool.call("getTransactions", async (client) => {
      const response = await client.getAccountTransactions(
        account,
        from.lt.toString(),
        from.hash,
        Math.min(count, this.maxPageSize),
        this.awaitSeqno(),
      );
      const page = Cell.fromBoc(response.transactions).map((cell) =>
        recordFromCell(cell, rawAddress),
      );
      validatePage(from, page);
      return page;
    });
  }

  async getTouchedAccounts(
    prev: ChainTip,
    next: ChainTip,
    workchains: ReadonlySet<number>,
  ): Promise<Map<string, TxId> | null> {
    const blocks = this.blocksBetween(prev, next, workchains);
    if (!blocks) return null;

    const touched = new Map<string, TxId>();
    await Promise.all(
      blocks.map(async (block) => {
        const ref = "rootHash" in block ? block : await this.lookupBlock(block);
        for await (const id of this.listBlockTransactions(ref, next.seqno)) {
          const address = `${ref.workchain}:${id.account.toString("hex")}`;
          const lt = BigInt(id.lt);
          const known = touched.get(address);
          if (!known || lt > known.lt) touched.set(address, { lt, hash: id.hash });
        }
      }),
    );
    return touched;
  }

  async findTxNear(
    address: string,
    lt: bigint,
    hint: { ltPerTx?: number } = {},
  ): Promise<TxId | null> {
    const account = Address.parse(address);
    const tip = this.lastTip ?? (await this.getTip());
    const top = tip.shards.find(
      (shard) => shard.workchain === account.workChain && shardContains(shard.shard, account.hash),
    );
    if (!top) return null;

    // Budget the search by how often the account shows up in blocks.
    let maxBlocks = this.maxProbeBlocks;
    if (hint.ltPerTx) {
      const expected = Math.ceil((PROBE_SPAN_TXS * hint.ltPerTx) / this.ltPerShardBlock(top));
      if (expected > this.maxProbeBlocks) return null;
      maxBlocks = Math.max(PROBE_BATCH_BLOCKS, expected);
    }

    // The shard block holding `lt`, then earlier blocks in batches until one has a
    // transaction of the account.
    let seqno = (
      await this.pool.call("lookupBlock", (client) =>
        client.lookupBlockByLt({ workchain: top.workchain, shard: top.shard, lt }),
      )
    ).id.seqno;
    for (let round = 0; round < maxBlocks / PROBE_BATCH_BLOCKS; round++) {
      const seqnos = Array.from({ length: PROBE_BATCH_BLOCKS }, (_, i) => seqno - i);
      const found = await Promise.all(
        seqnos.map((s) => this.lastTxOfAccountInBlock(top, s, account.hash)),
      );
      const hit = found.find((txId) => txId !== null);
      if (hit) return hit;
      seqno -= PROBE_BATCH_BLOCKS;
    }
    return null;
  }

  async close(): Promise<void> {
    for (const engine of this.engines) engine.close();
  }

  /**
   * Makes a lagging server wait for the newest block we know about instead of
   * answering "not found" for data it simply has not seen yet.
   */
  private awaitSeqno(seqno = this.lastTip?.seqno) {
    return seqno === undefined ? undefined : { awaitSeqno: seqno, timeout: AWAIT_SEQNO_TIMEOUT_MS };
  }

  /** Logical time a shard block spans, measured from consecutive tips. */
  private ltPerShardBlock(top: ShardTop): number {
    const sameShard = (shard: ShardTop) =>
      shard.shard === top.shard && shard.workchain === top.workchain;
    const first = this.firstTip?.shards.find(sameShard);
    const last = this.lastTip?.shards.find(sameShard);
    if (first && last && last.seqno > first.seqno) {
      return Number(last.endLt - first.endLt) / (last.seqno - first.seqno);
    }
    return DEFAULT_LT_PER_SHARD_BLOCK;
  }

  /**
   * Every block of the watched workchains after `prev` up to `next`: shard tops with
   * full ids, the blocks between them by seqno only. Null when the shard layout
   * changed (split/merge) or there are too many to list.
   */
  private blocksBetween(
    prev: ChainTip,
    next: ChainTip,
    workchains: ReadonlySet<number>,
  ): (BlockRef | BlockSeqnoRef)[] | null {
    const prevTops = new Map(prev.shards.map((top) => [`${top.workchain}:${top.shard}`, top]));
    const blocks: (BlockRef | BlockSeqnoRef)[] = [];

    for (const top of next.shards) {
      if (!workchains.has(top.workchain)) continue;
      const before = prevTops.get(`${top.workchain}:${top.shard}`);
      if (!before) return null;
      for (let seqno = before.seqno + 1; seqno < top.seqno; seqno++) {
        blocks.push({ workchain: top.workchain, shard: top.shard, seqno });
      }
      if (top.seqno > before.seqno) blocks.push(top);
    }
    const watchedShards = (tip: ChainTip) =>
      tip.shards.filter((top) => workchains.has(top.workchain)).length;
    if (watchedShards(next) !== watchedShards(prev)) return null;

    if (workchains.has(-1)) {
      for (let seqno = prev.seqno + 1; seqno < next.seqno; seqno++) {
        blocks.push({ workchain: -1, shard: MASTERCHAIN_SHARD, seqno });
      }
      if (next.seqno > prev.seqno) blocks.push(next.block);
    }
    return blocks.length > this.maxBlocksPerTick ? null : blocks;
  }

  private async lookupBlock(block: BlockSeqnoRef): Promise<BlockRef> {
    const { id } = await this.pool.call("lookupBlock", (client) =>
      client.lookupBlockByID({
        workchain: block.workchain,
        shard: block.shard,
        seqno: block.seqno,
      }),
    );
    return toBlockRef(id);
  }

  /** Every transaction id in a block, following `incomplete` pages. */
  private async *listBlockTransactions(
    block: BlockRef,
    awaitSeqno: number,
  ): AsyncGenerator<{ account: Buffer; lt: string; hash: Buffer }> {
    let after: liteServer_transactionId3 | null = null;
    for (;;) {
      const cursor = after;
      const response: liteServer_blockTransactions = await this.pool.call(
        "listBlockTransactions",
        (client) =>
          client.listBlockTransactions(
            toBlockIdExt(block),
            {
              mode: LIST_IDS | (cursor ? ListMode.after : 0),
              count: BLOCK_LIST_PAGE_SIZE,
              after: cursor,
            },
            this.awaitSeqno(awaitSeqno),
          ),
      );
      for (const id of response.ids) {
        if (!id.account || !id.lt || !id.hash) continue;
        yield { account: id.account, lt: id.lt, hash: id.hash };
      }
      const last = response.ids.at(-1);
      if (!response.incomplete || !last?.account || !last.lt) return;
      after = { kind: "liteServer.transactionId3", account: last.account, lt: last.lt };
    }
  }

  /** The account's newest transaction in one shard block, if it has any there. */
  private async lastTxOfAccountInBlock(
    shard: ShardTop,
    seqno: number,
    accountId: Buffer,
  ): Promise<TxId | null> {
    const { id } = await this.pool.call("lookupBlock", (client) =>
      client.lookupBlockByID({ workchain: shard.workchain, shard: shard.shard, seqno }),
    );
    // Start the listing at the account itself: ids are sorted by account.
    const after: liteServer_transactionId3 = {
      kind: "liteServer.transactionId3",
      account: accountId,
      lt: "0",
    };
    const response = await this.pool.call("listBlockTransactions", (client) =>
      client.listBlockTransactions(id, {
        mode: LIST_IDS | ListMode.after,
        count: PROBE_LIST_PAGE_SIZE,
        after,
      }),
    );
    const own = response.ids.filter((tx) => tx.account?.equals(accountId) && tx.lt && tx.hash);
    const last = own.at(-1);
    return last ? { lt: BigInt(last.lt!), hash: last.hash! } : null;
  }
}

/** A block known only by position; its hashes still have to be looked up. */
type BlockSeqnoRef = Pick<BlockRef, "workchain" | "shard" | "seqno">;

/**
 * Every transaction with `lt <= syncLt` is final at this tip: the lowest `end_lt`
 * over the basechain shard tops (all shards when there is no basechain).
 */
function syncLtOf(shards: ShardTop[]): bigint {
  const basechain = shards.filter((shard) => shard.workchain === 0);
  return (basechain.length > 0 ? basechain : shards).reduce(
    (min, shard) => (shard.endLt < min ? shard.endLt : min),
    shards[0]?.endLt ?? 0n,
  );
}

function toBlockRef(id: tonNode_blockIdExt): BlockRef {
  return {
    workchain: id.workchain,
    shard: id.shard,
    seqno: id.seqno,
    rootHash: id.rootHash,
    fileHash: id.fileHash,
  };
}

function toBlockIdExt(block: BlockRef): tonNode_blockIdExt {
  return {
    kind: "tonNode.blockIdExt",
    workchain: block.workchain,
    shard: block.shard,
    seqno: block.seqno,
    rootHash: block.rootHash,
    fileHash: block.fileHash,
  };
}

/** Global config stores liteserver IPs as signed 32-bit integers. */
function formatIpv4(ip: number): string {
  const unsigned = ip >>> 0;
  return [unsigned >>> 24, (unsigned >>> 16) & 255, (unsigned >>> 8) & 255, unsigned & 255].join(
    ".",
  );
}
