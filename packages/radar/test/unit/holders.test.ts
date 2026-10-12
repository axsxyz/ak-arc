import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { HolderTracker, type TransferEntry } from '../../src/features/holders.js';

const Z = '0x0000000000000000000000000000000000000000' as Address;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const e = (id: string, block: bigint, from: Address, to: Address, value: bigint): TransferEntry => ({ id, block, from, to, value });

describe('HolderTracker: top10% only when sinceBirth', () => {
  it('not tracked from birth → top10 and holderCount undefined, fallback approxHolders works', () => {
    const h = new HolderTracker(false);
    h.onTransfer(1, Z, a(1), 100n, 'x:0', 10n);
    expect(h.top10Share(1000n)).toBeUndefined();
    expect(h.holderCount()).toBeUndefined();
    expect(h.approxHolders(2)).toBe(1);
  });

  it('after a simulated birth → now backfill, top10 is defined and exclusions apply', () => {
    const h = new HolderTracker(false);
    h.beginBackfill(100n, 100n);
    h.applyRange([e('t1:0', 100n, Z, a(1), 600n), e('t2:0', 150n, Z, a(2), 300n), e('t3:0', 190n, a(1), a(3), 100n)], 199n);
    expect(h.top10Share(1000n)).toBeUndefined(); // still backfilling
    expect(h.markSinceBirth()).toBe(true);
    expect(h.holderCount()).toBe(3);
    expect(h.top10Share(900n)).toBe(1);
    expect(h.top10Share(1000n)).toBe(0.9); // share of totalSupply
    expect(h.top10Share(1000n, new Set([a(1)]))).toBe(0.4); // e.g. a(1) is the LP pool
  });

  it('capped scan (did not start at birth) never becomes authoritative', () => {
    const h = new HolderTracker(false);
    h.beginBackfill(100n, 5000n);
    h.applyRange([], 6000n);
    expect(h.capped).toBe(true);
    expect(h.markSinceBirth()).toBe(false);
    expect(h.top10Share(1000n)).toBeUndefined();
  });
});

describe('HolderTracker: live + historical feeds never double count', () => {
  it('live event first, then a range covering it', () => {
    const h = new HolderTracker(false);
    h.beginBackfill(1n, 1n);
    h.onTransfer(0, Z, a(1), 50n, 'tx:1', 500n); // live, ahead of backfill
    h.applyRange([e('tx:0', 10n, Z, a(1), 100n), e('tx:1', 500n, Z, a(1), 50n)], 600n);
    expect(h.balanceOf(a(1))).toBe(150n);
    expect(h.snapshot().recentIds).toEqual([]); // pruned once covered
  });
  it('range first, then the same log live (block <= syncedTo) is skipped', () => {
    const h = new HolderTracker(false);
    h.beginBackfill(1n, 1n);
    h.applyRange([e('tx:0', 10n, Z, a(1), 100n)], 20n);
    h.onTransfer(0, Z, a(1), 100n, 'tx:0', 10n);
    expect(h.balanceOf(a(1))).toBe(100n);
  });
  it('not live yet → live events only update the 24h participant set', () => {
    const h = new HolderTracker(false);
    h.onTransfer(0, Z, a(1), 100n, 'tx:0', 10n);
    expect(h.balanceOf(a(1))).toBeUndefined();
  });
});

describe('HolderTracker: checkpoint round-trip', () => {
  it('snapshot + dirty balances restore the same state', () => {
    const h = new HolderTracker(false);
    h.beginBackfill(1n, 1n);
    h.applyRange([e('a:0', 5n, Z, a(1), 70n), e('b:0', 6n, Z, a(2), 30n)], 9n);
    h.markSinceBirth();
    h.onTransfer(0, a(1), a(2), 10n, 'c:0', 12n);
    const snap = h.snapshot();
    const r = new HolderTracker(false);
    r.restore(JSON.parse(JSON.stringify(snap)), [[a(1), 60n], [a(2), 40n]]);
    expect(r.sinceBirth).toBe(true);
    expect(r.syncedTo).toBe(9n);
    expect(r.top10Share(100n)).toBe(1);
    r.applyRange([e('c:0', 12n, a(1), a(2), 10n)], 20n); // already applied before checkpoint → skipped
    expect(r.balanceOf(a(2))).toBe(40n);
  });
});
