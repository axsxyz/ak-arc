const Q192 = 2n ** 192n;
const SCALE = 10n ** 18n;

/**
 * V3 spot price of token0 denominated in token1 (human units), from sqrtPriceX96.
 * price = (sqrtP / 2^96)^2 * 10^(dec0 - dec1). Computed in bigint with 1e18 fixed point.
 */
export function v3PriceToken0InToken1(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  let num = sqrtPriceX96 * sqrtPriceX96 * SCALE;
  let den = Q192;
  const d = dec0 - dec1;
  if (d >= 0) num *= 10n ** BigInt(d);
  else den *= 10n ** BigInt(-d);
  return fixedToNumber(num / den);
}

/** Price of `base` in USDC given which side of the pool USDC is on. Returns undefined if price is 0/undefined. */
export function v3TokenPriceUsd(sqrtPriceX96: bigint, dec0: number, dec1: number, usdcIsToken0: boolean): number | undefined {
  const p01 = v3PriceToken0InToken1(sqrtPriceX96, dec0, dec1);
  if (!(p01 > 0)) return undefined;
  return usdcIsToken0 ? 1 / p01 : p01;
}

/** V2 / constant-product spot: price of token in USDC from reserves (raw) and decimals. */
export function reservesPriceUsd(tokenReserve: bigint, tokenDec: number, usdcReserve: bigint, usdcDec: number): number | undefined {
  if (tokenReserve === 0n) return undefined;
  let num = usdcReserve * SCALE;
  let den = tokenReserve;
  const d = tokenDec - usdcDec;
  if (d >= 0) num *= 10n ** BigInt(d);
  else den *= 10n ** BigInt(-d);
  return fixedToNumber(num / den);
}

/** mcap = price * totalSupply (explicit decimals). */
export function mcap(priceUsd: number, totalSupplyRaw: bigint, decimals: number): number {
  const whole = totalSupplyRaw / 10n ** BigInt(decimals);
  const frac = totalSupplyRaw % 10n ** BigInt(decimals);
  const supply = Number(whole) + Number(frac) / 10 ** decimals;
  return priceUsd * supply;
}

/** velocity = usd_in / minutes. undefined when minutes <= 0. */
export function velocity(usdIn: number, minutes: number): number | undefined {
  if (!(minutes > 0)) return undefined;
  return usdIn / minutes;
}

/** migrate_ratio = graduated / launched. undefined when launched = 0. */
export function migrateRatio(graduated: number, launched: number): number | undefined {
  if (launched <= 0) return undefined;
  return graduated / launched;
}

function fixedToNumber(x: bigint): number {
  const whole = x / SCALE;
  const frac = x % SCALE;
  return Number(whole) + Number(frac) / 1e18;
}
