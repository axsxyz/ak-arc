import type { Address } from 'viem';
import type { Dex } from '../decode/types.js';
import type { ChainReader } from '../rpc/reader.js';
import { MinuteBuckets, RollingEvents } from './volume.js';

/** An allowlisted AMM factory (pool provenance root). */
export interface FactoryInfo {
  name: string;
  kind: 'univ2' | 'univ3';
  /** launch: its pools are pad launches; migration: post-graduation pools of a pad; amm: plain liquidity venue. */
  role: 'launch' | 'amm' | 'migration';
}

export interface PoolState {
  pool: Address;
  dex: Dex;
  token0?: Address;
  token1?: Address;
  fee?: number;
  factory?: Address;
  /** Proven to belong to an allowlisted factory (seen PoolCreated from it, or factory()+getPool round-trip). */
  trusted: boolean;
  venue?: string;
  padName?: string;
  createdAtMs?: number;
  createdBlock?: bigint;
  /** 0/1 if one side is the USDC mirror, else undefined (USD uncertain). */
  usdcSide?: 0 | 1;
  token?: Address; // non-USDC side
  tokenDecimals?: number;
  usdcDecimals: number;
  priceUsd?: number;
  reserves?: [bigint, bigint];
  lp: RollingEvents; // signed USDC liquidity deltas, from Mint/Burn
  /**
   * Signed USDC deltas from SWAP flow (buy = +, sell = -), always maintained alongside `lp`. LP_SURGE reads
   * this instead of `lp` for pools whose Mint events seed single-sided (Lift/Tolly/RadarDEX: the non-USDC
   * side only, `lp`'s USDC-side delta is always 0 — see `singleSidedSeed`) — `lp` alone can never see liquidity
   * arrive on those pools, at any threshold, because the USDC side is never touched by Mint/Burn at all.
   */
  lpFromSwaps: RollingEvents;
  /**
   * Decided once, from the pool's first Mint: true if that mint's USDC-side amount was 0 (liquidity is
   * single-sided; LP_SURGE must read `lpFromSwaps`), false if it was nonzero (normal two-sided seed; LP_SURGE
   * keeps reading `lp`, unchanged). undefined until a mint has been observed — treated as two-sided (the prior,
   * proven-safe behavior) until then.
   */
  singleSidedSeed?: boolean;
  lastSurgeFireMs: number;
  vol: MinuteBuckets;
  /** Buy/sell split of `vol`, USDC side. Lets any pool (not just watchlisted majors) report a buy/sell ratio. */
  buyUsd: MinuteBuckets;
  sellUsd: MinuteBuckets;
  usdInSinceBirth: number;
  earlyBuyers: Map<Address, bigint>;
  earlyBuyerFired: boolean;
  /** Metadata/trust resolution hit a transient RPC failure; re-resolve (at most once per RESOLVE_RETRY_MS). */
  resolveIncomplete?: boolean;
  /** USDC held by the pool (last successful balanceOf) — used to pick a major's price source. */
  usdcDepth?: number;
  depthUpdatedMs?: number;
  lastResolveMs?: number;
}

const RESOLVE_RETRY_MS = 60_000;

/** Registry of pools with lazy on-chain resolution + provenance check. */
export class PoolRegistry {
  private pools = new Map<string, PoolState>();
  private pending = new Map<string, Promise<PoolState>>();
  /** Cold-path hook (pool_meta cache). Must not block: callers defer their writes. Errors are swallowed. */
  onResolved?: (p: PoolState) => void;

  constructor(
    private readonly reader: ChainReader,
    private factories: Map<string, FactoryInfo>,
    private readonly usdc: Address,
    private readonly usdcDecimals: () => number,
    private readonly lpHorizonMs: number,
  ) {}

  setFactories(f: Map<string, FactoryInfo>) {
    this.factories = f;
    // Re-evaluate trust/venue for known pools whose factory just became allowlisted.
    for (const p of this.pools.values()) {
      const info = p.factory ? f.get(p.factory) : undefined;
      if (info && p.createdAtMs !== undefined) this.applyFactory(p, info);
    }
  }

  get(pool: string) {
    return this.pools.get(pool.toLowerCase());
  }

  all() {
    return [...this.pools.values()];
  }

  private blank(pool: Address, dex: Dex): PoolState {
    return {
      pool,
      dex,
      trusted: false,
      usdcDecimals: this.usdcDecimals(),
      lp: new RollingEvents(this.lpHorizonMs),
      lpFromSwaps: new RollingEvents(this.lpHorizonMs),
      lastSurgeFireMs: -Infinity,
      vol: new MinuteBuckets(),
      buyUsd: new MinuteBuckets(),
      sellUsd: new MinuteBuckets(),
      usdInSinceBirth: 0,
      earlyBuyers: new Map(),
      earlyBuyerFired: false,
    };
  }

  private applyFactory(p: PoolState, info: FactoryInfo) {
    p.trusted = true;
    p.venue = p.padName ?? info.name;
    if (info.role !== 'amm') p.padName = info.name;
  }

  private async setTokens(p: PoolState, token0: Address, token1: Address) {
    p.token0 = token0;
    p.token1 = token1;
    const u = this.usdc.toLowerCase();
    p.usdcSide = token0 === u ? 0 : token1 === u ? 1 : undefined;
    p.token = p.usdcSide === 0 ? token1 : p.usdcSide === 1 ? token0 : undefined;
    if (p.token) p.tokenDecimals = (await this.reader.erc20Meta(p.token)).decimals;
  }

  /** A launcher event (Lift/Tolly/Radar) named this pool: attribute it to the pad. Trust stays factory-derived. */
  attributePad(p: PoolState, pad: string, t: number, block: bigint) {
    p.padName = pad;
    p.venue = pad;
    if (p.createdAtMs === undefined) {
      p.createdAtMs = t;
      p.createdBlock = block;
    }
  }

  /** Register from a PoolCreated/PairCreated log. Trusted iff emitter factory is allowlisted. */
  async onCreated(args: { pool: Address; dex: Dex; factory: Address; token0: Address; token1: Address; fee?: number; t: number; block: bigint }) {
    const p = this.pools.get(args.pool) ?? this.blank(args.pool, args.dex);
    p.factory = args.factory;
    p.fee = args.fee;
    p.createdAtMs = args.t;
    p.createdBlock = args.block;
    await this.setTokens(p, args.token0, args.token1);
    const info = this.factories.get(args.factory);
    if (info) this.applyFactory(p, info);
    this.pools.set(args.pool, p);
    this.notify(p);
    return p;
  }

  private notify(p: PoolState) {
    if (!this.onResolved || !p.token0 || !p.token1) return;
    try {
      this.onResolved(p);
    } catch {
      // cold path must never break ingest
    }
  }

  /** Get or lazily resolve a pool seen only via Swap/Mint/Burn/Sync (re-resolves pools whose last attempt was throttled). */
  ensure(pool: Address, dex: Dex): Promise<PoolState> {
    const hit = this.pools.get(pool);
    if (hit && !(hit.resolveIncomplete && Date.now() - (hit.lastResolveMs ?? 0) > RESOLVE_RETRY_MS)) return Promise.resolve(hit);
    let pend = this.pending.get(pool);
    if (!pend) {
      pend = (async () => {
        const p = hit ?? this.blank(pool, dex);
        p.lastResolveMs = Date.now();
        let incomplete = false;
        if (!p.token0 || !p.token1 || p.factory === undefined) {
          const on = await this.reader.poolOnchain(pool, dex);
          incomplete ||= Boolean(on.incomplete);
          p.factory = on.factory ?? p.factory;
          p.fee = on.fee ?? p.fee;
          if (on.token0 && on.token1) await this.setTokens(p, on.token0, on.token1);
        } else if (p.token && p.tokenDecimals === undefined) {
          p.tokenDecimals = (await this.reader.erc20Meta(p.token)).decimals;
        }
        if (p.token && p.tokenDecimals === undefined) incomplete = true;
        const info = p.factory ? this.factories.get(p.factory) : undefined;
        if (info && p.token0 && p.token1 && !p.trusted) {
          // factory() is self-reported by the pool — prove it with the factory's own registry.
          const back = await this.reader.factoryLookup(p.factory!, dex, p.token0, p.token1, p.fee);
          if (back === pool) this.applyFactory(p, info);
          else if (back === undefined) incomplete = true; // throttled lookup or genuinely absent: retry later, never trust
        }
        p.resolveIncomplete = incomplete || undefined;
        this.pools.set(pool, p);
        this.pending.delete(pool);
        this.notify(p);
        return p;
      })();
      this.pending.set(pool, pend);
    }
    return pend;
  }
}
