import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { HolderTracker } from '../../src/features/holders.js';
import { MajorState } from '../../src/features/majors.js';
import { meanStd, MinuteBuckets, RollingEvents } from '../../src/features/volume.js';
import { clusterByFunder } from '../../src/features/wallets.js';
import { planBackfill } from '../../src/ingest/backfill.js';
import { evaluateMigrate } from '../../src/score/rules/migrate.js';
import { isWalletFast } from '../../src/score/rules/wallet.js';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

describe('rolling windows', () => {
  it('RollingEvents sum is (from, to]', () => {
    const r = new RollingEvents(600_000);
    r.push(1000, 5);
    r.push(2000, -2);
    r.push(3000, 10);
    expect(r.sum(1000, 3000)).toBe(8);
    expect(r.sum(0, 3000)).toBe(13);
  });
  it('MinuteBuckets windows', () => {
    const b = new MinuteBuckets();
    b.add(0, 1);
    b.add(59_999, 2);
    b.add(60_000, 4);
    expect(b.sumWindow(60_000, 1)).toBe(4);
    expect(b.sumWindow(60_000, 2)).toBe(7);
    expect(b.series(0, 2)).toEqual([3, 4, 0]);
  });
  it('meanStd', () => {
    expect(meanStd([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({ mean: 5, std: 2 });
  });
});

describe('MAJOR_ANOMALY math', () => {
  const params = { z: 5, pct: 100, minSamples: 30, minVolUsd: 1000, cooldownMs: 900_000 };
  it('needs min samples', () => {
    const m = new MajorState(a(1), 'X');
    for (let i = 0; i < 10; i++) m.onSwap(i * 60_000, 100, true, 1, a(2));
    m.onSwap(11 * 60_000, 50_000, true, 1, a(2));
    expect(m.evaluate(11 * 60_000, params)).toBeUndefined();
  });
  it('fires on 5σ spike after 60 min flat baseline; not on normal flow', () => {
    const m = new MajorState(a(1), 'X');
    m.setSource(a(2));
    for (let i = 0; i < 60; i++) {
      m.onSwap(i * 60_000, 100, true, 1, a(2));
      expect(m.evaluate(i * 60_000, params)).toBeUndefined();
    }
    m.onSwap(61 * 60_000, 5000, true, 1, a(2));
    const r = m.evaluate(61 * 60_000, params);
    expect(r?.kind).toBe('vol_z');
    expect(r!.z!).toBeGreaterThan(5);
  });
  it('dust pool swaps never move a major price (only the source pool does)', () => {
    const m = new MajorState(a(1), 'X');
    m.setSource(a(2));
    m.onSwap(0, 100, true, 0.0028, a(2));
    m.onSwap(1, 1, true, 0.03, a(3)); // dust pool 10x off
    expect(m.lastPriceUsd).toBe(0.0028);
    expect(m.vol.sumWindow(1, 1)).toBe(101); // volume still counts
    m.setSource(a(3));
    expect(m.lastPriceUsd).toBeUndefined(); // series reset on source change
  });

  it('price Δ vs 60 min ago', () => {
    const m = new MajorState(a(1), 'X');
    m.setSource(a(2));
    for (let i = 0; i <= 60; i++) m.onSwap(i * 60_000, 300, true, 1, a(2));
    m.onSwap(61 * 60_000, 1000, true, 2.5, a(2));
    expect(m.evaluate(61 * 60_000, { ...params, z: 1e9 })?.kind).toBe('price_pct');
  });
});

describe('rules', () => {
  it('migrate: once, within window only', () => {
    const w = { pad: 'P', token: a(1), pool: a(2), startMs: 0, volUsd: 0, fired: false };
    expect(evaluateMigrate(w, 1000, 6000, 300_000, 10_000)).toBe(false);
    expect(evaluateMigrate(w, 2000, 6000, 300_000, 10_000)).toBe(true);
    expect(evaluateMigrate(w, 3000, 6000, 300_000, 10_000)).toBe(false);
    const late = { ...w, volUsd: 0, fired: false };
    expect(evaluateMigrate(late, 400_000, 50_000, 300_000, 10_000)).toBe(false);
  });
  it('wallet fast', () => {
    const base = { isBuy: true, usd: 600, poolAgeMs: 30_000, maxAgeSec: 120, minUsd: 500 };
    expect(isWalletFast(base)).toBe(true);
    expect(isWalletFast({ ...base, isBuy: false })).toBe(false);
    expect(isWalletFast({ ...base, usd: 499 })).toBe(false);
    expect(isWalletFast({ ...base, poolAgeMs: 121_000 })).toBe(false);
    expect(isWalletFast({ ...base, poolAgeMs: undefined })).toBe(false);
  });
});

describe('backfill planning', () => {
  it('re-fetches the last processed block through head', () => {
    expect(planBackfill(100n, 110n, 2400)).toEqual({ from: 100n, to: 110n, skipped: 0n });
  });
  it('bounds huge gaps to the tail', () => {
    expect(planBackfill(0n, 10_000n, 2400)).toEqual({ from: 7601n, to: 10_000n, skipped: 7601n });
  });
});

describe('holders + clusters', () => {
  it('holders≈ and top10 only when tracked since birth', () => {
    const z = '0x0000000000000000000000000000000000000000' as Address;
    const h = new HolderTracker(true);
    h.onTransfer(0, z, a(1), 600n);
    h.onTransfer(0, z, a(2), 400n);
    h.onTransfer(0, a(1), a(3), 100n);
    expect(h.approxHolders(1)).toBe(3);
    expect(h.top10Share(1000n)).toBe(1);
    expect(h.top10Share(1000n, new Set([a(1)]))).toBe(0.5);
    expect(new HolderTracker(false).top10Share(1000n)).toBeUndefined();
  });
  it('funder clusters', () => {
    const funders: Record<string, Address> = { [a(1)]: a(9), [a(2)]: a(9), [a(3)]: a(9), [a(4)]: a(8) };
    expect(clusterByFunder([a(1), a(2), a(3), a(4), a(5)], (x) => funders[x], 3)).toEqual([{ funder: a(9), members: [a(1), a(2), a(3)] }]);
  });
});
