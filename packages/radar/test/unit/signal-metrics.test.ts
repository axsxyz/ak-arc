import { describe, expect, it } from 'vitest';
import { signalLp, signalMcap, signalVelocity } from '../../src/features/signal-metrics.js';

const SUPPLY = 10n ** 9n * 10n ** 18n;

describe('signalMcap (undefined cases)', () => {
  it('price × supply with explicit decimals', () => expect(signalMcap(0.00005, SUPPLY, 18)).toBeCloseTo(50_000, 6));
  it('price unknown (no USDC swap/reserves/slot0, or non-USDC pair)', () => expect(signalMcap(undefined, SUPPLY, 18)).toBeUndefined());
  it('price zero/negative/NaN', () => {
    expect(signalMcap(0, SUPPLY, 18)).toBeUndefined();
    expect(signalMcap(-1, SUPPLY, 18)).toBeUndefined();
    expect(signalMcap(NaN, SUPPLY, 18)).toBeUndefined();
  });
  it('totalSupply unreadable', () => expect(signalMcap(1, undefined, 18)).toBeUndefined());
  it('decimals unknown', () => expect(signalMcap(1, SUPPLY, undefined)).toBeUndefined());
});

describe('signalLp (undefined cases)', () => {
  it('USDC balance of a USDC pool', () => expect(signalLp(12_000_000_000n, 6, true)).toBe(12_000));
  it('pool without USDC side → never priced', () => expect(signalLp(12_000_000_000n, 6, false)).toBeUndefined());
  it('balanceOf failed', () => expect(signalLp(undefined, 6, true)).toBeUndefined());
});

describe('signalVelocity (undefined cases)', () => {
  it('usd / minutes since start', () => expect(signalVelocity(8000, 0, 120_000)).toBe(4000));
  it('same block → elapsed floored at 1s (finite)', () => expect(signalVelocity(10, 5000, 5000)).toBe(600));
  it('start unknown (pool/curve born before we watched)', () => expect(signalVelocity(8000, undefined, 1)).toBeUndefined());
  it('usd unknown', () => expect(signalVelocity(undefined, 0, 1)).toBeUndefined());
  it('clock before start (bad data)', () => expect(signalVelocity(1, 10, 5)).toBeUndefined());
});
