import { describe, expect, it } from 'vitest';
import { mcap, migrateRatio, reservesPriceUsd, v3PriceToken0InToken1, v3TokenPriceUsd, velocity } from '../../src/math/price.js';
import { erc20ToNativeUsdc, fromNumber, nativeToErc20Usdc, toNumber, USDC_ERC20_DECIMALS, USDC_NATIVE_DECIMALS } from '../../src/math/units.js';

describe('USDC decimals: 6-dec ERC-20 mirror vs 18-dec native gas', () => {
  it('constants', () => {
    expect(USDC_ERC20_DECIMALS).toBe(6);
    expect(USDC_NATIVE_DECIMALS).toBe(18);
  });
  it('1 USDC', () => {
    expect(toNumber(1_000_000n, 6)).toBe(1);
    expect(toNumber(10n ** 18n, 18)).toBe(1);
    expect(nativeToErc20Usdc(10n ** 18n)).toBe(1_000_000n);
    expect(erc20ToNativeUsdc(1_000_000n)).toBe(10n ** 18n);
  });
  it('golden vectors', () => {
    expect(toNumber(123_456_789n, 6)).toBe(123.456789);
    expect(toNumber(123_456_789_000_000_000_000n, 18)).toBe(123.456789);
    expect(nativeToErc20Usdc(123_456_789_123_456_789_000n)).toBe(123_456_789n); // 123.456789123… USDC: sub-micro dust truncated
    expect(fromNumber('50000', 6)).toBe(50_000_000_000n);
    expect(fromNumber('0.000001', 6)).toBe(1n);
  });
  it('mistaking 18-dec native for 6-dec mirror is off by 1e12', () => {
    expect(toNumber(10n ** 18n, 6)).toBe(1e12);
  });
});

describe('prices', () => {
  it('V3 sqrtPriceX96 = 2^96 → price 1 at equal decimals', () => {
    expect(v3PriceToken0InToken1(2n ** 96n, 18, 18)).toBe(1);
  });
  it('V3 USDC(6)/TOKEN(18) pool, token $0.00005', () => {
    // token1 per token0 human = 20000 → raw ratio 2e16 → sqrtP = sqrt(2e16) * 2^96
    const sqrtP = isqrt(20_000_000_000_000_000n << 192n); // floor(sqrt(2e16 * 2^192))
    expect(v3PriceToken0InToken1(sqrtP, 6, 18)).toBeCloseTo(20000, 6);
    expect(v3TokenPriceUsd(sqrtP, 6, 18, true)).toBeCloseTo(0.00005, 12);
  });
  it('V3 TOKEN(18)/USDC(6) pool (USDC token1), token $2.5', () => {
    // price token0 in token1 human = 2.5 → raw = 2.5e-12 → sqrtP = sqrt(2.5e-12) * 2^96
    const sqrtP = BigInt(Math.floor(Math.sqrt(2.5e-12) * 2 ** 96));
    expect(v3TokenPriceUsd(sqrtP, 18, 6, false)).toBeCloseTo(2.5, 6);
  });
  it('V2 reserves price with explicit decimals', () => {
    expect(reservesPriceUsd(5_000_000n * 10n ** 18n, 18, 100_000n * 10n ** 6n, 6)).toBe(0.02);
    expect(reservesPriceUsd(0n, 18, 1n, 6)).toBeUndefined();
  });
});

describe('mcap = price * supply (explicit decimals)', () => {
  it('1e9 supply (18 dec) at $0.00005 = $50,000', () => {
    expect(mcap(0.00005, 10n ** 9n * 10n ** 18n, 18)).toBeCloseTo(50_000, 6);
  });
  it('fractional supply, 6 dec', () => {
    expect(mcap(2, 1_500_000n, 6)).toBe(3);
  });
  it('wrong decimals would be catastrophically off', () => {
    expect(mcap(0.00005, 10n ** 27n, 6)).toBeGreaterThan(1e15);
  });
});

describe('velocity = usd_in / minutes', () => {
  it('golden', () => {
    expect(velocity(8000, 2)).toBe(4000);
    expect(velocity(8000, 10 / 60)).toBeCloseTo(48_000, 6);
    expect(velocity(1, 0)).toBeUndefined();
  });
});

describe('migrate_ratio = graduated / launched', () => {
  it('golden', () => {
    expect(migrateRatio(3, 12)).toBe(0.25);
    expect(migrateRatio(0, 5)).toBe(0);
    expect(migrateRatio(1, 0)).toBeUndefined();
  });
});

function isqrt(n: bigint): bigint {
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
