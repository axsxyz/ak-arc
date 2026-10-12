import type { Address } from 'viem';

export interface MigrateWatch {
  pad: string;
  token: Address;
  pool: Address;
  startMs: number;
  volUsd: number;
  fired: boolean;
}

/** PAD_MIGRATE_HOT: after Graduated, cumulative post-migrate USDC vol within the window >= threshold, once. */
export function evaluateMigrate(w: MigrateWatch, t: number, usd: number, windowMs: number, thresholdUsd: number): boolean {
  if (w.fired || t < w.startMs || t - w.startMs > windowMs) return false;
  w.volUsd += usd;
  if (w.volUsd >= thresholdUsd) {
    w.fired = true;
    return true;
  }
  return false;
}
