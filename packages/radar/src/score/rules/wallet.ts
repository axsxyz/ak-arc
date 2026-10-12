/** WATCHLIST_WALLET_FAST: labeled wallet buys within ALERT_WALLET_AGE_SEC of pool creation with size >= ALERT_WALLET_BUY_USD. */
export function isWalletFast(args: { isBuy: boolean; usd: number; poolAgeMs: number | undefined; maxAgeSec: number; minUsd: number }): boolean {
  return args.isBuy && args.poolAgeMs !== undefined && args.poolAgeMs >= 0 && args.poolAgeMs <= args.maxAgeSec * 1000 && args.usd >= args.minUsd;
}
