import type { Dex } from '../decode/types.js';
import type { SignalType } from './types.js';

/**
 * Paper scoring math (pure). Cold path only: used by the precision job, `report:scorecard` and `calibrate`.
 * Nothing here can change a gate decision — promotion is computed and reported, never wired to pings.
 */

export type Direction = 'long' | 'avoid';

/**
 * How each signal type is scored. long = buy the token at the paper fill; avoid = the signal says get out, so the
 * score is the price drop avoided. null = meta signal, never scored (no token/pool to trade).
 * Exhaustive on purpose: a new SignalType must pick a direction here.
 */
export const SIGNAL_DIRECTION: Record<SignalType, Direction | null> = {
  LP_SURGE: 'long',
  LP_WATCH: 'long',
  LP_REMOVE: 'avoid',
  NEW_LAUNCH: 'long',
  PAD_GRADUATED: 'long',
  PAD_MIGRATE_HOT: 'long',
  WATCHLIST_WALLET_FAST: 'long',
  WALLET_ACTIVITY: 'long',
  EARLY_BUYER_DENSITY: 'long',
  FUNDER_CLUSTER: 'long',
  BRIDGE_FLOW: 'long',
  BRIDGE_INFLOW: 'long',
  BRIDGE_OUTFLOW: 'long',
  BRIDGE_DEPLOY: 'long',
  MAJOR_ANOMALY: 'long',
  MISSING_ON_CHAIN: null,
  MAJOR_DIGEST: null,
  PAD_LEADERBOARD: null,
  BRIDGE_NET_FLOW: null,
};

export const directionOf = (t: SignalType): Direction | null => SIGNAL_DIRECTION[t];

/** Live sampling horizons for every scored signal (T+1m/5m/15m/1h). */
export const SIGNAL_HORIZONS_SEC = [60, 300, 900, 3600];

/** UniV2-style pairs don't expose a fee tier; assume the canonical 0.30%. */
export const DEFAULT_V2_FEE_PPM = 3000;

/**
 * Round-trip cost as a fraction of size: 2 × fee tier + impact ≈ size / (2 × USDC depth).
 * undefined when depth is unknown (bonding curves, unresolved pools): such fills are reported as unpriced, not free.
 * Capped at 1 (a paper trade can't lose more than its stake).
 */
export function roundTripCost(a: { feePpm?: number; dex?: Dex; sizeUsd: number; depthUsd?: number }): number | undefined {
  if (a.depthUsd === undefined || !(a.depthUsd > 0)) return undefined;
  const feePpm = a.feePpm ?? (a.dex === 'univ2' ? DEFAULT_V2_FEE_PPM : undefined);
  if (feePpm === undefined) return undefined;
  return Math.min(1, (2 * feePpm) / 1e6 + a.sizeUsd / (2 * a.depthUsd));
}

/**
 * USDC-per-token price in RAW units (no decimals applied). Returns are ratios, so decimals cancel; never display it.
 * V3: mid price after the swap from sqrtPriceX96. V2 (no sqrtPrice): execution price |usdc| / |token|.
 */
export function swapPriceRaw(sw: { amount0: bigint; amount1: bigint; sqrtPriceX96?: bigint }, usdcSide: 0 | 1): number | undefined {
  if (sw.sqrtPriceX96 !== undefined && sw.sqrtPriceX96 > 0n) {
    const r = Number(sw.sqrtPriceX96) / 2 ** 96;
    const token1PerToken0 = r * r;
    if (!(token1PerToken0 > 0) || !Number.isFinite(token1PerToken0)) return undefined;
    return usdcSide === 1 ? token1PerToken0 : 1 / token1PerToken0;
  }
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const usdc = abs(usdcSide === 0 ? sw.amount0 : sw.amount1);
  const tok = abs(usdcSide === 0 ? sw.amount1 : sw.amount0);
  return tok > 0n && usdc > 0n ? Number(usdc) / Number(tok) : undefined;
}

/** Bonding-curve trade price (quote per token, raw units). */
export function curvePriceRaw(t: { quoteRaw: bigint; tokenRaw: bigint }): number | undefined {
  return t.tokenRaw > 0n && t.quoteRaw > 0n ? Number(t.quoteRaw) / Number(t.tokenRaw) : undefined;
}

export interface PricePoint {
  t: number;
  px: number;
}

export interface PaperFill {
  entryMs: number;
  entryPx: number;
  exitMs: number;
  exitPx: number;
  /** Direction-adjusted return before costs (long: exit/entry − 1; avoid: 1 − exit/entry). */
  gross: number;
  cost?: number;
  /** gross − cost, floored at −1. undefined when cost is unknown. */
  net?: number;
  /** avoid only: 1 − min(price in [entry, exit]) / entry, ≥ 0. */
  drawdownAvoided?: number;
}

export type FillOutcome = { status: 'filled'; fill: PaperFill } | { status: 'pending' } | { status: 'no_fill' };

/**
 * Paper fill: entry = first print at/after firedMs + latencyMs; exit = last print at/before firedMs + horizonMs.
 * pending = the horizon hasn't elapsed in the data yet; no_fill = no print between entry time and horizon end.
 * `series` must be sorted by t (ties keep chain order).
 */
export function paperFill(
  series: PricePoint[],
  o: { firedMs: number; latencyMs: number; horizonMs: number; direction: Direction; cost?: number; dataEndMs: number },
): FillOutcome {
  const endMs = o.firedMs + o.horizonMs;
  if (o.dataEndMs < endMs) return { status: 'pending' };
  const startMs = o.firedMs + o.latencyMs;
  const i = series.findIndex((p) => p.t >= startMs);
  if (i < 0 || series[i]!.t > endMs) return { status: 'no_fill' };
  let j = i;
  let minPx = series[i]!.px;
  for (let k = i + 1; k < series.length && series[k]!.t <= endMs; k++) {
    j = k;
    minPx = Math.min(minPx, series[k]!.px);
  }
  const entry = series[i]!;
  const exit = series[j]!;
  const ratio = exit.px / entry.px;
  const gross = o.direction === 'long' ? ratio - 1 : 1 - ratio;
  const net = o.cost === undefined ? undefined : Math.max(-1, gross - o.cost);
  return {
    status: 'filled',
    fill: {
      entryMs: entry.t,
      entryPx: entry.px,
      exitMs: exit.t,
      exitPx: exit.px,
      gross,
      cost: o.cost,
      net,
      drawdownAvoided: o.direction === 'avoid' ? Math.max(0, 1 - minPx / entry.px) : undefined,
    },
  };
}

export interface ReturnStats {
  n: number;
  hitRate?: number;
  mean?: number;
  median?: number;
}

/** hit = net > 0 (strictly: a flat trade after costs is a miss). */
export function returnStats(xs: number[]): ReturnStats {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const mid = v.length >> 1;
  return {
    n: v.length,
    hitRate: v.filter((x) => x > 0).length / v.length,
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    median: v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2,
  };
}

export const PROMOTION_RULE = { windowDays: 7, minN: 30, minHitRate: 0.55, minMeanNetExclusive: 0 } as const;

export type PromotionVerdict = 'eligible' | 'fail' | 'insufficient';

/**
 * A signal type may earn a ping only if, over the last 7 days: n (net-priced fills) >= 30, net hit rate >= 55%,
 * mean net return > 0. NOT wired to the gate — reported by `report:scorecard` for the operator to act on.
 */
export function promotionVerdict(s: ReturnStats, rule = PROMOTION_RULE): { verdict: PromotionVerdict; reasons: string[] } {
  if (s.n < rule.minN) return { verdict: 'insufficient', reasons: [`n=${s.n} < ${rule.minN}`] };
  const reasons: string[] = [];
  if ((s.hitRate ?? 0) < rule.minHitRate) reasons.push(`hit ${((s.hitRate ?? 0) * 100).toFixed(1)}% < ${(rule.minHitRate * 100).toFixed(0)}%`);
  if (!((s.mean ?? 0) > rule.minMeanNetExclusive)) reasons.push(`mean net ${((s.mean ?? 0) * 100).toFixed(2)}% <= 0`);
  return reasons.length ? { verdict: 'fail', reasons } : { verdict: 'eligible', reasons: [] };
}
