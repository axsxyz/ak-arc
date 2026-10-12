import type { Thresholds } from '../../config/env.js';
import type { RollingEvents } from '../../features/volume.js';

export type LpVerdict =
  | { kind: 'surge'; netUsd: number; windowStartMs: number }
  | { kind: 'watch'; netUsd: number; windowStartMs: number }
  | { kind: 'remove'; usd: number }
  | undefined;

/**
 * LP_SURGE: net USDC liquidity added within ALERT_LP_WINDOW_SEC >= ALERT_LP_USD.
 * Only counts events after the last surge fire, so one surge can't re-fire on the same deposits.
 *
 * `window` is the rolling signed-USDC-delta series to evaluate — the caller picks which one: a pool's
 * Mint/Burn deltas (`PoolState.lp`) for a normal two-sided seed, or its swap-flow deltas
 * (`PoolState.lpFromSwaps`) for a pool that seeds single-sided, where Mint/Burn never touch the USDC side
 * at all (see `PoolState.singleSidedSeed`). The threshold comparison itself never changes — same numbers,
 * different source of "how much USDC actually arrived."
 */
export function evaluateLp(window: RollingEvents, lastSurgeFireMs: number, t: number, deltaUsd: number, th: Thresholds): LpVerdict {
  if (deltaUsd < 0) return -deltaUsd >= th.lpWatchUsd ? { kind: 'remove', usd: -deltaUsd } : undefined;
  const windowStart = Math.max(t - th.lpWindowSec * 1000, lastSurgeFireMs);
  const net = window.sum(windowStart, t);
  if (net >= th.lpUsd) return { kind: 'surge', netUsd: net, windowStartMs: windowStart };
  if (net >= th.lpWatchUsd) return { kind: 'watch', netUsd: net, windowStartMs: windowStart };
  return undefined;
}
