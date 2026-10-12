import { describe, expect, it } from 'vitest';
import { FIELD_POLICY } from '../../src/discord/embeds.js';
import {
  curvePriceRaw,
  directionOf,
  paperFill,
  promotionVerdict,
  returnStats,
  roundTripCost,
  SIGNAL_DIRECTION,
  swapPriceRaw,
} from '../../src/score/paper.js';

const Q96 = 2n ** 96n;

describe('paper cost model (golden vectors)', () => {
  it('2 × fee tier + size / (2 × USDC depth)', () => {
    expect(roundTripCost({ feePpm: 3000, sizeUsd: 500, depthUsd: 50_000 })).toBeCloseTo(0.011, 12);
    expect(roundTripCost({ feePpm: 10_000, sizeUsd: 500, depthUsd: 1_000 })).toBeCloseTo(0.27, 12);
  });
  it('univ2 without a fee tier assumes 0.30%; unknown univ3 fee or depth → unpriced (undefined), never free', () => {
    expect(roundTripCost({ dex: 'univ2', sizeUsd: 500, depthUsd: 50_000 })).toBeCloseTo(0.011, 12);
    expect(roundTripCost({ dex: 'univ3', sizeUsd: 500, depthUsd: 50_000 })).toBeUndefined();
    expect(roundTripCost({ feePpm: 3000, sizeUsd: 500 })).toBeUndefined();
    expect(roundTripCost({ feePpm: 3000, sizeUsd: 500, depthUsd: 0 })).toBeUndefined();
  });
  it('caps at 100% of stake (dust pools)', () => {
    expect(roundTripCost({ feePpm: 3000, sizeUsd: 500, depthUsd: 100 })).toBe(1);
  });
});

describe('raw prices (decimals cancel in returns)', () => {
  it('V3 sqrtPriceX96: USDC side decides inversion', () => {
    expect(swapPriceRaw({ amount0: 1n, amount1: -1n, sqrtPriceX96: Q96 }, 1)).toBe(1);
    expect(swapPriceRaw({ amount0: 1n, amount1: -1n, sqrtPriceX96: 2n * Q96 }, 1)).toBe(4); // token1 (USDC) per token0
    expect(swapPriceRaw({ amount0: 1n, amount1: -1n, sqrtPriceX96: 2n * Q96 }, 0)).toBe(0.25);
  });
  it('V2 (no sqrtPrice): execution price |usdc| / |token|', () => {
    expect(swapPriceRaw({ amount0: 1_000_000n, amount1: -2_000_000_000_000_000_000n }, 0)).toBeCloseTo(5e-13, 25);
    expect(swapPriceRaw({ amount0: 0n, amount1: 5n }, 0)).toBeUndefined();
  });
  it('bonding curve: quote / token', () => {
    expect(curvePriceRaw({ quoteRaw: 10n ** 18n, tokenRaw: 2n * 10n ** 18n })).toBe(0.5);
    expect(curvePriceRaw({ quoteRaw: 1n, tokenRaw: 0n })).toBeUndefined();
  });
});

describe('paper fill', () => {
  const series = [
    { t: 1000, px: 1 },
    { t: 4000, px: 1.1 },
    { t: 10_000, px: 1.2 },
    { t: 61_000, px: 2 },
  ];
  it('entry = first print ≥ fire + latency, exit = last print ≤ fire + horizon, net = gross − cost', () => {
    const r = paperFill(series, { firedMs: 1000, latencyMs: 3000, horizonMs: 60_000, direction: 'long', cost: 0.011, dataEndMs: 61_000 });
    expect(r.status).toBe('filled');
    if (r.status !== 'filled') return;
    expect(r.fill).toMatchObject({ entryMs: 4000, entryPx: 1.1, exitMs: 61_000, exitPx: 2 });
    expect(r.fill.gross).toBeCloseTo(2 / 1.1 - 1, 12);
    expect(r.fill.net).toBeCloseTo(2 / 1.1 - 1 - 0.011, 12);
  });
  it('pending until the horizon is inside the data; no_fill when nothing prints in [entry, horizon]', () => {
    expect(paperFill(series, { firedMs: 1000, latencyMs: 3000, horizonMs: 60_000, direction: 'long', dataEndMs: 60_999 }).status).toBe('pending');
    expect(paperFill(series, { firedMs: 62_000, latencyMs: 3000, horizonMs: 60_000, direction: 'long', dataEndMs: 200_000 }).status).toBe('no_fill');
    expect(paperFill([{ t: 90_000, px: 1 }], { firedMs: 0, latencyMs: 3000, horizonMs: 60_000, direction: 'long', dataEndMs: 200_000 }).status).toBe('no_fill');
  });
  it('unknown cost → net undefined (gross still reported)', () => {
    const r = paperFill(series, { firedMs: 1000, latencyMs: 0, horizonMs: 5000, direction: 'long', dataEndMs: 100_000 });
    expect(r.status === 'filled' && r.fill.net).toBeUndefined();
  });
  it('avoid: score = price drop avoided; drawdown avoided = worst dip after entry', () => {
    const s = [
      { t: 0, px: 1 },
      { t: 1000, px: 0.5 },
      { t: 2000, px: 0.8 },
    ];
    const r = paperFill(s, { firedMs: 0, latencyMs: 0, horizonMs: 2000, direction: 'avoid', cost: 0.01, dataEndMs: 2000 });
    expect(r.status).toBe('filled');
    if (r.status !== 'filled') return;
    expect(r.fill.gross).toBeCloseTo(0.2, 12);
    expect(r.fill.net).toBeCloseTo(0.19, 12);
    expect(r.fill.drawdownAvoided).toBeCloseTo(0.5, 12);
  });
  it('net return is floored at −100%', () => {
    const r = paperFill([{ t: 0, px: 1 }, { t: 1, px: 0.01 }], { firedMs: 0, latencyMs: 0, horizonMs: 10, direction: 'long', cost: 0.5, dataEndMs: 10 });
    expect(r.status === 'filled' && r.fill.net).toBe(-1);
  });
});

describe('direction table', () => {
  it('is exhaustive over signal types; LP_REMOVE = avoid; meta signals are never scored; everything else long', () => {
    expect(Object.keys(SIGNAL_DIRECTION).sort()).toEqual(Object.keys(FIELD_POLICY).sort());
    expect(directionOf('LP_REMOVE')).toBe('avoid');
    for (const t of ['MAJOR_DIGEST', 'PAD_LEADERBOARD', 'MISSING_ON_CHAIN'] as const) expect(directionOf(t)).toBeNull();
    for (const t of ['LP_SURGE', 'PAD_MIGRATE_HOT', 'WATCHLIST_WALLET_FAST', 'MAJOR_ANOMALY', 'NEW_LAUNCH', 'LP_WATCH', 'EARLY_BUYER_DENSITY', 'BRIDGE_FLOW'] as const) {
      expect(directionOf(t)).toBe('long');
    }
  });
});

describe('return stats + promotion rule (7d n>=30, net hit>=55%, mean net>0)', () => {
  it('hit = net > 0 strictly; median of even n averages the middle pair', () => {
    expect(returnStats([0.1, -0.2, 0.3, 0])).toEqual({ n: 4, hitRate: 0.5, mean: expect.closeTo(0.05, 12), median: expect.closeTo(0.05, 12) });
    expect(returnStats([])).toEqual({ n: 0 });
  });
  it('verdicts', () => {
    expect(promotionVerdict({ n: 29, hitRate: 1, mean: 1 }).verdict).toBe('insufficient');
    expect(promotionVerdict({ n: 30, hitRate: 0.55, mean: 0.0001 })).toEqual({ verdict: 'eligible', reasons: [] });
    expect(promotionVerdict({ n: 30, hitRate: 0.5499, mean: 0.1 }).verdict).toBe('fail');
    const flat = promotionVerdict({ n: 100, hitRate: 0.9, mean: 0 });
    expect(flat.verdict).toBe('fail');
    expect(flat.reasons[0]).toMatch(/mean net/);
  });
});
