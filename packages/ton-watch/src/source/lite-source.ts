import { Address, Cell, loadTransaction } from "@ton/core";
import { getServers, type LsConfig, type ServerDefinition } from "@ton/ls";
import { LiteClient, LiteSingleEngine } from "ton-lite-client";
import { Functions } from "ton-lite-client/dist/schema";
import type {
  liteServer_accountState,
  liteServer_allShardsInfo,
  liteServer_blockTransactions,
  tonNode_blockIdExt,
} from "ton-lite-client/dist/schema";

import { validatePage } from "../chain";
import { SourceError } from "../errors";
import { silentLogger, type Logger } from "../logger";
import { Metrics } from "../metrics";
import { bigIntToBuffer } from "../ton";
import type { TxId, TxRecord } from "../types";
import { ServerPool, type PoolMember, type ServerPoolOptions } from "./pool";
import { lastTxFromStateProof } from "./account-proof";
import { parseShardTops } from "./shards";
import { recordFromCell } from "../tx-cell";
import type { BlockRef, ChainTip, ShardTop, TxSource } from "./source";

export interface LiteSourceOptions extends ServerPoolOptions {
  /** Regular liteservers. Default: mainnet public config. */
  servers?: ServerDefinition;
  /** Archival liteservers, asked only for history the regular ones no longer have. */
  archiveServers?: ServerDefinition;
  /** How long to wait for the first connections. */
  connectTimeoutMs?: number;
  /** Blocks mode gives up (returns null → poll) when more shard blocks than this are pending. */
  maxBlocksPerTick?: number;
  /** `findTxNear` gives up after looking at this many shard blocks. Default 128. */
  maxProbeBlocks?: number;
}

/** Whether a shard (signed 64-bit id) contains the account id. */
export function shardContains(shard: string, accountId: Buffer): boolean {
  const id = BigInt.asUintN(64, BigInt(shard));
  const lowBit = id & -id;
  const prefixBits = 63 - (lowBit.toString(2).length - 1);
  if (prefixBits === 0) return true;
  const accountTop = BigInt(`0x${accountId.subarray(0, 8).toString("hex")}`);
  const mask = ((1n << BigInt(prefixBits)) - 1n) << BigInt(64 - prefixBits);
  return (accountTop & mask) === (id & mask);
}

const ip = (n: number) => {
  const u = n >>> 0;
  return [u >>> 24, (u >>> 16) & 255, (u >>> 8) & 255, u & 255].join(".");
};

const MASTER_SHARD = "-9223372036854775808";

const toRef = (id: tonNode_blockIdExt): BlockRef => ({
  workchain: id.workchain,
  shard: id.shard,
  seqno: id.seqno,
  rootHash: id.rootHash,
  fileHash: id.fileHash,
});

const toBlockId = (b: BlockRef): tonNode_blockIdExt => ({
  kind: "tonNode.blockIdExt",
  workchain: b.workchain,
  shard: b.shard,
  seqno: b.seqno,
  rootHash: b.rootHash,
  fileHash: b.fileHash,
});

/** Liteserver-backed `TxSource` with rotation, rate-limit backoff and archival fallback. */
export class LiteSource implements TxSource {
  readonly maxPageSize = 16; // liteservers cap getTransactions at 16
  readonly pool: ServerPool<LiteClient>;
  readonly metrics: Metrics;
  private readonly engines: LiteSingleEngine[];
  private readonly maxBlocksPerTick: number;
  private readonly maxProbeBlocks: number;
  private lastTip: ChainTip | null = null;
  private firstTip: ChainTip | null = null;

  /**
   * Makes a lagging server wait for the newest block we know about instead of
   * answering "not found" for data it simply has not seen yet.
   */
  private awaitArgs(seqno = this.lastTip?.seqno) {
    return seqno === undefined ? undefined : { awaitSeqno: seqno, timeout: 5_000 };
  }

  private constructor(
    members: PoolMember<LiteClient>[],
    engines: LiteSingleEngine[],
    options: LiteSourceOptions
  ) {
    this.metrics = options.metrics ?? new Metrics();
    this.pool = new ServerPool(members, { ...options, metrics: this.metrics });
    this.engines = engines;
    this.maxBlocksPerTick = options.maxBlocksPerTick ?? 400;
    this.maxProbeBlocks = options.maxProbeBlocks ?? 128;
  }

  static async connect(options: LiteSourceOptions = {}): Promise<LiteSource> {
    const logger: Logger = options.logger ?? silentLogger;
    const primary = await getServers(options.servers ?? "mainnet");
    const archive = options.archiveServers ? await getServers(options.archiveServers) : [];

    const engines: LiteSingleEngine[] = [];
    const seen = new Set<string>();
    const members: PoolMember<LiteClient>[] = [];
    const add = (ls: LsConfig, isArchive: boolean) => {
      const host = `tcp://${ip(ls.ip)}:${ls.port}`;
      if (seen.has(host)) return;
      seen.add(host);
      const engine = new LiteSingleEngine({
        host,
        publicKey: Buffer.from(ls.id.key, "base64"),
      });
      engine.on("error", () => {});
      engines.push(engine);
      members.push({
        id: host,
        archive: isArchive,
        client: new LiteClient({ engine, batchSize: 1, cacheMap: 1000 }),
        isReady: () => engine.isReady(),
      });
    };
    for (const ls of archive) add(ls, true);
    for (const ls of primary) add(ls, false);

    const deadline = Date.now() + (options.connectTimeoutMs ?? 10_000);
    while (Date.now() < deadline && !engines.some((e) => e.isReady())) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // Give the rest a moment so the first calls spread out.
    await new Promise((r) => setTimeout(r, 500));
    const ready = engines.filter((e) => e.isReady()).length;
    logger.info(`liteservers: ${ready}/${engines.length} connected (${archive.length} archival configured)`);
    if (ready === 0) {
      for (const e of engines) e.close();
      throw new SourceError("network", "no liteserver could be reached");
    }
    return new LiteSource(members, engines, options);
  }

  async getTip(): Promise<ChainTip> {
    const tip = await this.pool.call("getTip", async (c) => {
      const info = await c.getMasterchainInfoExt();
      const shardsInfo = (await c.engine.query(Functions.liteServer_getAllShardsInfo, {
        kind: "liteServer.getAllShardsInfo",
        id: info.last,
      })) as liteServer_allShardsInfo;
      const shards = parseShardTops(shardsInfo.data);
      const basechain = shards.filter((s) => s.workchain === 0);
      const syncLt = (basechain.length ? basechain : shards).reduce(
        (min, s) => (s.endLt < min ? s.endLt : min),
        shards[0]?.endLt ?? 0n
      );
      return {
        seqno: info.last.seqno,
        utime: info.lastUtime,
        block: toRef(info.last),
        shards,
        syncLt,
      } satisfies ChainTip;
    });
    // A lagging server must not move the tip backwards.
    if (this.lastTip && tip.seqno < this.lastTip.seqno) return this.lastTip;
    this.lastTip = tip;
    this.firstTip ??= tip;
    return tip;
  }

  /** Logical time a shard block spans, measured from consecutive tips. */
  private ltPerShardBlock(top: ShardTop): number {
    const first = this.firstTip?.shards.find((s) => s.shard === top.shard && s.workchain === top.workchain);
    const last = this.lastTip?.shards.find((s) => s.shard === top.shard && s.workchain === top.workchain);
    if (first && last && last.seqno > first.seqno) {
      return Number(last.endLt - first.endLt) / (last.seqno - first.seqno);
    }
    return 1_000_000;
  }

  async getLastTx(address: string, tip: ChainTip): Promise<TxId | null> {
    const addr = Address.parse(address);
    return this.pool.call("getAccountState", async (c) => {
      const res = (await c.engine.query(
        Functions.liteServer_getAccountState,
        {
          kind: "liteServer.getAccountState",
          id: toBlockId(tip.block),
          account: { kind: "liteServer.accountId", workchain: addr.workChain, id: addr.hash },
        },
        this.awaitArgs(tip.seqno)
      )) as liteServer_accountState;
      return lastTxFromStateProof(res.proof, addr.hash);
    });
  }

  async getTransactions(address: string, from: TxId, count: number): Promise<TxRecord[]> {
    const addr = Address.parse(address);
    const raw = addr.toRawString();
    return this.pool.call("getTransactions", async (c) => {
      const res = await c.getAccountTransactions(
        addr,
        from.lt.toString(),
        from.hash,
        Math.min(count, this.maxPageSize),
        this.awaitArgs()
      );
      const page = Cell.fromBoc(res.transactions).map((cell) => recordFromCell(cell, raw));
      validatePage(from, page);
      return page;
    });
  }

  async getTouchedAccounts(
    prev: ChainTip,
    next: ChainTip,
    workchains: ReadonlySet<number>
  ): Promise<Map<string, TxId> | null> {
    const prevTops = new Map(prev.shards.map((s) => [`${s.workchain}:${s.shard}`, s]));
    const blocks: (BlockRef | Omit<BlockRef, "rootHash" | "fileHash">)[] = [];

    for (const top of next.shards) {
      if (!workchains.has(top.workchain)) continue;
      const before = prevTops.get(`${top.workchain}:${top.shard}`);
      if (!before) return null; // split/merge: can't enumerate safely
      for (let seqno = before.seqno + 1; seqno < top.seqno; seqno++) {
        blocks.push({ workchain: top.workchain, shard: top.shard, seqno });
      }
      if (top.seqno > before.seqno) blocks.push(top);
    }
    if (next.shards.filter((s) => workchains.has(s.workchain)).length !==
        prev.shards.filter((s) => workchains.has(s.workchain)).length) {
      return null;
    }
    if (workchains.has(-1)) {
      for (let seqno = prev.seqno + 1; seqno < next.seqno; seqno++) {
        blocks.push({ workchain: -1, shard: MASTER_SHARD, seqno });
      }
      if (next.seqno > prev.seqno) blocks.push(next.block);
    }
    if (blocks.length > this.maxBlocksPerTick) return null;

    const touched = new Map<string, TxId>();
    await Promise.all(
      blocks.map(async (b) => {
        const ref: BlockRef =
          "rootHash" in b
            ? b
            : toRef(
                (
                  await this.pool.call("lookupBlock", (c) =>
                    c.lookupBlockByID({ workchain: b.workchain, shard: b.shard, seqno: b.seqno })
                  )
                ).id
              );
        let after: { account: Buffer; lt: string } | null = null;
        for (;;) {
          const res: liteServer_blockTransactions = await this.pool.call(
            "listBlockTransactions",
            (c) =>
              c.listBlockTransactions(
                toBlockId(ref),
                {
                  mode: 1 + 2 + 4 + (after ? 128 : 0),
                  count: 256,
                  after: after ? { kind: "liteServer.transactionId3", ...after } : null,
                },
                this.awaitArgs(next.seqno)
              )
          );
          for (const id of res.ids) {
            if (!id.account || !id.lt || !id.hash) continue;
            const address = `${ref.workchain}:${id.account.toString("hex")}`;
            const lt = BigInt(id.lt);
            const known = touched.get(address);
            if (!known || lt > known.lt) touched.set(address, { lt, hash: id.hash });
          }
          const last = res.ids.at(-1);
          if (!res.incomplete || !last?.account || !last.lt) break;
          after = { account: last.account, lt: last.lt };
        }
      })
    );
    return touched;
  }

  async findTxNear(
    address: string,
    lt: bigint,
    hint: { ltPerTx?: number } = {}
  ): Promise<TxId | null> {
    const addr = Address.parse(address);
    const tip = this.lastTip ?? (await this.getTip());
    const top = tip.shards.find(
      (s) => s.workchain === addr.workChain && shardContains(s.shard, addr.hash)
    );
    if (!top) return null;
    // Budget the search by how often the account shows up in blocks.
    let maxBlocks = this.maxProbeBlocks;
    if (hint.ltPerTx) {
      const expected = Math.ceil((4 * hint.ltPerTx) / this.ltPerShardBlock(top));
      if (expected > this.maxProbeBlocks) return null;
      maxBlocks = Math.max(8, expected);
    }
    const after = { kind: "liteServer.transactionId3" as const, account: addr.hash, lt: "0" };

    // The shard block holding `lt`, then earlier blocks in batches until one has a
    // transaction of the account.
    let seqno = (
      await this.pool.call("lookupBlock", (c) =>
        c.lookupBlockByLt({ workchain: top.workchain, shard: top.shard, lt })
      )
    ).id.seqno;
    const batch = 8;
    for (let round = 0; round < maxBlocks / batch; round++) {
      const seqnos = Array.from({ length: batch }, (_, i) => seqno - i);
      const found = await Promise.all(
        seqnos.map(async (s) => {
          const id = (
            await this.pool.call("lookupBlock", (c) =>
              c.lookupBlockByID({ workchain: top.workchain, shard: top.shard, seqno: s })
            )
          ).id;
          const res = await this.pool.call("listBlockTransactions", (c) =>
            c.listBlockTransactions(id, { mode: 1 + 2 + 4 + 128, count: 16, after })
          );
          const mine = res.ids.filter((x) => x.account?.equals(addr.hash) && x.lt && x.hash);
          const last = mine.at(-1);
          return last ? { lt: BigInt(last.lt!), hash: last.hash! } : null;
        })
      );
      const hit = found.find((f) => f !== null);
      if (hit) return hit;
      seqno -= batch;
    }
    return null;
  }

  async close() {
    for (const e of this.engines) e.close();
  }
}

export type { ShardTop };
