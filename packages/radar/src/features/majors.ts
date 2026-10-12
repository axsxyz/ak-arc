import type { Address } from 'viem';
import { MinuteBuckets, MinuteLast, meanStd, minuteOf } from './volume.js';

export interface AnomalyParams {
  z: number;
  pct: number;
  minSamples: number;
  minVolUsd: number;
  cooldownMs: number;
}

export interface AnomalyResult {
  kind: 'vol_z' | 'price_pct';
  cur5: number;
  baselineMean5: number;
  z?: number;
  pctChange?: number;
  samples: number;
}

/** Per-major-token rolling state across its USDC pools. */
export class MajorState {
  vol = new MinuteBuckets();
  price = new MinuteLast(180);
  buyUsd = new MinuteBuckets();
  sellUsd = new MinuteBuckets();
  lastPriceUsd?: number;
  lastPriceMs?: number;
  /**
   * The only pool allowed to set this major's price: its deepest trusted USDC pool with >= MAJOR_PRICE_MIN_LP_USD.
   * Dust pools (observed on mainnet: COOL has two pools holding < $0.0001 USDC next to a $115k pool) must never move
   * the price or feed MAJOR_ANOMALY's price branch. Volume still aggregates across all pools (it is real USDC).
   */
  sourcePool?: Address;
  lastAnomalyMs = -Infinity;
  pools = new Set<Address>();

  constructor(readonly address: Address, readonly symbol: string) {}

  setSource(pool: Address | undefined) {
    if (pool === this.sourcePool) return;
    this.sourcePool = pool;
    // Different pools can sit at slightly different prices: never splice two sources into one series.
    this.price = new MinuteLast(180);
    this.lastPriceUsd = undefined;
    this.lastPriceMs = undefined;
  }

  onSwap(t: number, usd: number, isBuy: boolean, priceUsd: number | undefined, pool: Address) {
    this.pools.add(pool);
    this.vol.add(t, usd);
    (isBuy ? this.buyUsd : this.sellUsd).add(t, usd);
    if (priceUsd !== undefined && pool === this.sourcePool) {
      this.price.set(t, priceUsd);
      this.lastPriceUsd = priceUsd;
      this.lastPriceMs = t;
    }
  }

  /**
   * MAJOR_ANOMALY: current 5m vol vs the prior 60 one-minute buckets (scaled to 5m, iid assumption),
   * or |price Δ| vs 60 minutes ago. std is floored (10% of mean, $1) so a flat baseline can't explode z.
   */
  evaluate(t: number, p: AnomalyParams): AnomalyResult | undefined {
    if (t - this.lastAnomalyMs < p.cooldownMs) return undefined;
    const m = minuteOf(t);
    const cur5 = this.vol.sumMinutes(m - 4, m);
    if (cur5 < p.minVolUsd) return undefined;
    const base = this.vol.series(m - 64, m - 5);
    if (base.length < p.minSamples) return undefined;
    const { mean, std } = meanStd(base);
    const mean5 = mean * 5;
    const std5 = Math.sqrt(5) * Math.max(std, mean * 0.1, 1);
    const z = (cur5 - mean5) / std5;
    if (z >= p.z) return { kind: 'vol_z', cur5, baselineMean5: mean5, z, samples: base.length };
    const p0 = this.price.at(m - 60);
    const first = this.price.first;
    if (p0 && this.lastPriceUsd !== undefined && first && first.m <= m - 60) {
      const pctChange = ((this.lastPriceUsd - p0) / p0) * 100;
      if (Math.abs(pctChange) >= p.pct) return { kind: 'price_pct', cur5, baselineMean5: mean5, pctChange, z, samples: base.length };
    }
    return undefined;
  }
}
