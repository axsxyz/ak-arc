/**
 * impact — the radar's paper cost model, called with the real trade size.
 *
 * paper.ts prices a ROUND TRIP: 2 × fee tier + size / (2 × USDC depth).
 * The fee term counts both legs, so on a 1% tier it is 200 bps before any
 * size effect. Label it "round-trip cost estimate", never "entry slippage".
 *
 * Impact is INFORMATIONAL. It is computed and reported in trade.preflight,
 * trade.fill and trade.sell (realised vs predicted) and never blocks a buy.
 * The operator owns price decisions; the on-chain guard is minOut from
 * slippageBps. Do not add a second cost model here.
 */

import { roundTripCost } from '../../radar/src/score/paper.js';

export interface ImpactInput {
  feePpm: number;
  sizeUsd: number;
  depthUsd: number;
}

export interface ImpactBreakdown {
  /** paper.ts model, bps: 2 × fee + size / (2 × depth), capped at 10 000. */
  roundTripBps: number;
  /** 2 × fee, bps. */
  feeLegsBps: number;
  /** size / (2 × depth), bps. */
  sizeTermBps: number;
}

export function impactBps(a: ImpactInput): ImpactBreakdown {
  const cost = roundTripCost({ feePpm: a.feePpm, sizeUsd: a.sizeUsd, depthUsd: a.depthUsd });
  if (cost === undefined) throw new Error(`impact undefined: depth ${a.depthUsd}, fee ${a.feePpm}`);
  return {
    roundTripBps: Math.round(cost * 10_000),
    feeLegsBps: Math.round(((2 * a.feePpm) / 1e6) * 10_000),
    sizeTermBps: Math.round((a.sizeUsd / (2 * a.depthUsd)) * 10_000),
  };
}

/**
 * Realised execution cost of ONE leg versus the pre-trade spot, bps.
 * buy:  1 − (tokensOut × spot) / usdcIn
 * sell: 1 − usdcOut / (tokensIn × spot)
 * Fee-inclusive, so on a 1% tier a perfectly quoted fill still reads ≥ 100 bps.
 */
export function realisedLegBps(o: { usdc: number; tokens: number; spotUsd: number; side: 'buy' | 'sell' }): number | undefined {
  if (!(o.usdc > 0) || !(o.tokens > 0) || !(o.spotUsd > 0)) return undefined;
  const ratio = o.side === 'buy' ? (o.tokens * o.spotUsd) / o.usdc : o.usdc / (o.tokens * o.spotUsd);
  return Math.round((1 - ratio) * 10_000);
}
