import { createPublicClient, http, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { erc20Abi } from '../abi/erc20.js';
import { univ2FactoryAbi, univ2PairAbi } from '../abi/univ2.js';
import { univ3FactoryAbi, univ3PoolAbi } from '../abi/univ3.js';
import { parseRpcLog } from '../decode/index.js';
import { warpCurveAbi } from '../abi/pads-mainnet.js';
import type { Dex, RawLog } from '../decode/types.js';
import { isTransient, RateLimiter, withRetry } from './limiter.js';
import type { ChainReader, Erc20Meta, LogFilter, PoolOnchain } from './reader.js';

const lc = (a: string) => a.toLowerCase() as Address;
const toHex = (n: bigint) => `0x${n.toString(16)}` as Hex;

/** RPC-backed reader: rate-limited, retried, with permanent caches for immutable data. */
export class RpcChainReader implements ChainReader {
  readonly client: PublicClient;
  private readonly limiter: RateLimiter;
  private metaCache = new Map<string, Promise<Erc20Meta>>();
  private poolCache = new Map<string, Promise<PoolOnchain>>();
  private tsCache = new Map<bigint, number>();
  private txFromCache = new Map<string, Address | undefined>();
  private lookupCache = new Map<string, Promise<{ value: unknown; retryable: boolean }>>();

  /**
   * @param retry attempts/backoff for transient errors (rate limits, throttling, 5xx). Hot path keeps it short;
   *              background jobs use long backoff to ride out public-RPC rate-limit windows (-32005 "exceeds defined limit").
   */
  constructor(url: string, maxRps: number, private readonly retry: { attempts: number; baseMs: number } = { attempts: 4, baseMs: 250 }) {
    this.client = createPublicClient({ transport: http(url, { timeout: 15_000, retryCount: 0 }) });
    this.limiter = new RateLimiter(maxRps);
  }

  private call<T>(fn: () => Promise<T>): Promise<T> {
    return this.limiter.schedule(() => withRetry(fn, this.retry.attempts, this.retry.baseMs));
  }

  private async safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
    return (await this.attempt(fn)).v;
  }

  /** v = result; retryable = failed for a transient reason (throttle/5xx/timeout), so the absence must not be cached. */
  private async attempt<T>(fn: () => Promise<T>): Promise<{ v?: T; retryable: boolean }> {
    try {
      return { v: await this.call(fn), retryable: false };
    } catch (e) {
      return { v: undefined, retryable: isTransient(e) };
    }
  }

  /** Cache a promise, evicting it once resolved if the result came from a transient failure. */
  private cached<T extends { incomplete?: boolean } | { value: unknown; retryable: boolean }>(map: Map<string, Promise<T>>, k: string, make: () => Promise<T>): Promise<T> {
    let p = map.get(k);
    if (!p) {
      p = make();
      map.set(k, p);
      void p.then((r) => {
        if (('incomplete' in r && r.incomplete) || ('retryable' in r && r.retryable)) map.delete(k);
      });
    }
    return p;
  }

  chainId() {
    return this.call(() => this.client.getChainId());
  }

  async getCode(address: Address): Promise<Hex> {
    return (await this.call(() => this.client.getCode({ address }))) ?? '0x';
  }

  async getCodeAt(address: Address, block: bigint): Promise<Hex> {
    return (await this.call(() => this.client.getCode({ address, blockNumber: block }))) ?? '0x';
  }

  blockNumber() {
    return this.call(() => this.client.getBlockNumber());
  }

  /** Arc blocks are ~0.5s; caller may prime the cache from newHeads. */
  primeTimestamp(block: bigint, ts: number) {
    this.tsCache.set(block, ts);
    if (this.tsCache.size > 20_000) {
      const first = this.tsCache.keys().next().value;
      if (first !== undefined) this.tsCache.delete(first);
    }
  }

  async blockTimestamp(block: bigint) {
    const hit = this.tsCache.get(block);
    if (hit !== undefined) return hit;
    const b = await this.safe(() => this.client.getBlock({ blockNumber: block }));
    if (!b) return undefined;
    const ts = Number(b.timestamp);
    this.primeTimestamp(block, ts);
    return ts;
  }

  async txFrom(txHash: Hex) {
    if (this.txFromCache.has(txHash)) return this.txFromCache.get(txHash);
    const tx = await this.safe(() => this.client.getTransaction({ hash: txHash }));
    const from = tx ? lc(tx.from) : undefined;
    this.txFromCache.set(txHash, from);
    if (this.txFromCache.size > 20_000) this.txFromCache.clear();
    return from;
  }

  erc20Meta(token: Address) {
    return this.cached(this.metaCache, lc(token), async () => {
      const [symbol, decimals, totalSupply] = await Promise.all([
        this.attempt(() => this.client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })),
        this.attempt(() => this.client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })),
        this.attempt(() => this.client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })),
      ]);
      return {
        symbol: symbol.v,
        decimals: decimals.v === undefined ? undefined : Number(decimals.v),
        totalSupply: totalSupply.v,
        incomplete: symbol.retryable || decimals.retryable || totalSupply.retryable || undefined,
      };
    });
  }

  /** totalSupply changes (mints/burns) — fetch fresh, not cached. */
  async totalSupply(token: Address) {
    return this.safe(() => this.client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }));
  }

  poolOnchain(pool: Address, dex: Dex) {
    const abi = dex === 'univ3' ? univ3PoolAbi : univ2PairAbi;
    return this.cached(this.poolCache, `${dex}:${lc(pool)}`, async () => {
      const [factory, token0, token1] = await Promise.all([
        this.attempt(() => this.client.readContract({ address: pool, abi, functionName: 'factory' }) as Promise<Address>),
        this.attempt(() => this.client.readContract({ address: pool, abi, functionName: 'token0' }) as Promise<Address>),
        this.attempt(() => this.client.readContract({ address: pool, abi, functionName: 'token1' }) as Promise<Address>),
      ]);
      const fee = dex === 'univ3' ? await this.attempt(() => this.client.readContract({ address: pool, abi: univ3PoolAbi, functionName: 'fee' })) : { v: undefined, retryable: false };
      return {
        factory: factory.v && lc(factory.v),
        token0: token0.v && lc(token0.v),
        token1: token1.v && lc(token1.v),
        fee: fee.v === undefined ? undefined : Number(fee.v),
        incomplete: factory.retryable || token0.retryable || token1.retryable || fee.retryable || undefined,
      };
    });
  }

  async factoryLookup(factory: Address, dex: Dex, token0: Address, token1: Address, fee?: number) {
    const k = `${dex}:${factory}:${token0}:${token1}:${fee ?? ''}`;
    const r = await this.cached(this.lookupCache, k, async () => {
      const res =
        dex === 'univ3'
          ? await this.attempt(() => this.client.readContract({ address: factory, abi: univ3FactoryAbi, functionName: 'getPool', args: [token0, token1, fee ?? 0] }))
          : await this.attempt(() => this.client.readContract({ address: factory, abi: univ2FactoryAbi, functionName: 'getPair', args: [token0, token1] }));
      return { value: res.v && res.v !== zeroAddress ? lc(res.v) : undefined, retryable: res.retryable };
    });
    return r.value as Address | undefined;
  }

  async v3SqrtPrice(pool: Address) {
    const r = await this.safe(() => this.client.readContract({ address: pool, abi: univ3PoolAbi, functionName: 'slot0' }));
    return r?.[0];
  }

  balanceOf(token: Address, holder: Address) {
    return this.safe(() => this.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }));
  }

  async curveInfo(curve: Address) {
    const [factory, token] = await Promise.all([
      this.safe(() => this.client.readContract({ address: curve, abi: warpCurveAbi, functionName: 'factory' })),
      this.safe(() => this.client.readContract({ address: curve, abi: warpCurveAbi, functionName: 'token' })),
    ]);
    return { factory: factory && lc(factory), token: token && lc(token) };
  }

  async getLogs(f: LogFilter): Promise<RawLog[]> {
    const params: Record<string, unknown> = { fromBlock: toHex(f.fromBlock), toBlock: toHex(f.toBlock), topics: f.topics };
    if (f.address?.length) params.address = f.address;
    const raw = await this.call(() => this.client.request({ method: 'eth_getLogs', params: [params] } as never));
    return (raw as Parameters<typeof parseRpcLog>[0][]).map(parseRpcLog);
  }
}
