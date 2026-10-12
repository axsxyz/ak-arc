import type { Address, Hex } from 'viem';
import { parseRpcLog } from '../decode/index.js';
import type { Dex, RawLog } from '../decode/types.js';
import type { ChainReader, Erc20Meta, LogFilter, PoolOnchain } from '../rpc/reader.js';
import { blockTs } from './world.js';

export interface ChainFixture {
  chainId: number;
  tokens: Record<string, { symbol: string; decimals: number; totalSupply: string }>;
  pools: Record<string, { dex: Dex; factory: string; token0: string; token1: string; fee?: number; registered?: boolean }>;
  code: string[]; // addresses with deployed code
  txFrom: Record<string, string>;
  balances: Record<string, string>; // "token:holder" -> raw
  sqrtPrices: Record<string, string>;
  curves?: Record<string, { factory: string; token: string }>;
  /** Contract creation blocks (for getCodeAt). Addresses in `code` without an entry exist since block 0. */
  createdAt?: Record<string, string>;
  head: string;
}

type RpcLogJson = Parameters<typeof parseRpcLog>[0];

/** Deterministic in-memory chain for fixtures/tests. Records every getLogs range for assertions. */
export class FakeChainReader implements ChainReader {
  getLogsCalls: { from: bigint; to: bigint }[] = [];
  chainLogs: RawLog[] = [];
  head: bigint;

  constructor(private readonly f: ChainFixture, chainLogs: RpcLogJson[] = []) {
    this.chainLogs = chainLogs.map(parseRpcLog);
    this.head = BigInt(f.head);
  }

  async chainId() {
    return this.f.chainId;
  }
  async getCode(a: Address): Promise<Hex> {
    return this.f.code.includes(a.toLowerCase()) ? '0x6080604052' : '0x';
  }
  getCodeAtCalls = 0;
  async getCodeAt(a: Address, block: bigint): Promise<Hex> {
    this.getCodeAtCalls++;
    if (!this.f.code.includes(a.toLowerCase())) return '0x';
    const born = this.f.createdAt?.[a.toLowerCase()];
    return born === undefined || block >= BigInt(born) ? '0x6080604052' : '0x';
  }
  async totalSupply(t: Address) {
    const m = this.f.tokens[t.toLowerCase()];
    return m ? BigInt(m.totalSupply) : undefined;
  }
  async blockNumber() {
    return this.head;
  }
  async blockTimestamp(b: bigint) {
    return blockTs(b);
  }
  async txFrom(h: Hex) {
    return this.f.txFrom[h.toLowerCase()] as Address | undefined;
  }
  async erc20Meta(t: Address): Promise<Erc20Meta> {
    const m = this.f.tokens[t.toLowerCase()];
    return m ? { symbol: m.symbol, decimals: m.decimals, totalSupply: BigInt(m.totalSupply) } : {};
  }
  async poolOnchain(pool: Address, _dex: Dex): Promise<PoolOnchain> {
    const p = this.f.pools[pool.toLowerCase()];
    return p ? { factory: p.factory as Address, token0: p.token0 as Address, token1: p.token1 as Address, fee: p.fee } : {};
  }
  async factoryLookup(factory: Address, dex: Dex, t0: Address, t1: Address, fee?: number) {
    const hit = Object.entries(this.f.pools).find(
      ([, p]) => p.registered !== false && p.factory === factory && p.dex === dex && p.token0 === t0 && p.token1 === t1 && (dex === 'univ2' || p.fee === fee),
    );
    return hit?.[0] as Address | undefined;
  }
  async v3SqrtPrice(pool: Address) {
    const v = this.f.sqrtPrices[pool.toLowerCase()];
    return v ? BigInt(v) : undefined;
  }
  async balanceOf(token: Address, holder: Address) {
    const v = this.f.balances[`${token.toLowerCase()}:${holder.toLowerCase()}`];
    return v === undefined ? undefined : BigInt(v);
  }
  async curveInfo(curve: Address) {
    const c = this.f.curves?.[curve.toLowerCase()];
    return c ? { factory: c.factory as Address, token: c.token as Address } : {};
  }
  async getLogs(filter: LogFilter): Promise<RawLog[]> {
    this.getLogsCalls.push({ from: filter.fromBlock, to: filter.toBlock });
    const t0 = filter.topics[0];
    const allowed = t0 === null || t0 === undefined ? undefined : new Set(Array.isArray(t0) ? t0 : [t0]);
    const addrs = filter.address?.map((a) => a.toLowerCase());
    return this.chainLogs.filter(
      (l) =>
        l.blockNumber >= filter.fromBlock &&
        l.blockNumber <= filter.toBlock &&
        (!allowed || allowed.has(l.topics[0]!)) &&
        (!addrs || addrs.includes(l.address)),
    );
  }
}
