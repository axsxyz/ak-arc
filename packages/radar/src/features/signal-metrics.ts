import { mcap, velocity } from '../math/price.js';
import { toNumber } from '../math/units.js';

/**
 * Signal-time metrics. Each returns `undefined` when the value cannot be known — embeds then OMIT the field
 * (only MAJOR_DIGEST renders explicit "n/a"). Never substitute a guess.
 */

/**
 * mcap = price × totalSupply. Undefined when:
 *  - price unknown (no USDC-side swap/reserves/slot0 yet, or non-USDC pair → USD uncertain), or price <= 0
 *  - totalSupply() unreadable (RPC failure / non-standard token)
 *  - token decimals unknown
 */
export function signalMcap(priceUsd: number | undefined, totalSupply: bigint | undefined, decimals: number | undefined): number | undefined {
  if (priceUsd === undefined || !(priceUsd > 0) || totalSupply === undefined || decimals === undefined) return undefined;
  const v = mcap(priceUsd, totalSupply, decimals);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * LP depth = USDC mirror balance held by the pool. Undefined when:
 *  - the pool has no USDC side (USD uncertain; we never price token/token liquidity)
 *  - balanceOf() failed
 */
export function signalLp(usdcBalanceRaw: bigint | undefined, usdcDecimals: number, poolHasUsdcSide: boolean): number | undefined {
  if (!poolHasUsdcSide || usdcBalanceRaw === undefined) return undefined;
  return toNumber(usdcBalanceRaw, usdcDecimals);
}

/**
 * velocity = usd_in / minutes since `sinceMs` (pool/curve birth or window start). Undefined when:
 *  - the start time is unknown (pool/curve born before we started watching and no window applies)
 *  - usd is unknown
 * Elapsed time is floored at 1 second so a same-block event yields a finite (large) rate instead of ∞.
 */
export function signalVelocity(usdIn: number | undefined, sinceMs: number | undefined, nowMs: number): number | undefined {
  if (usdIn === undefined || sinceMs === undefined || nowMs < sinceMs) return undefined;
  return velocity(usdIn, Math.max((nowMs - sinceMs) / 60_000, 1 / 60));
}
