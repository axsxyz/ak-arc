import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { impactBps, realisedLegBps } from '../../src/impact.js';
import { chooseDeepest, type Tier } from '../../src/pool.js';

const F = '0xf0db7b58379503491d857db50ac9ece64c653918' as Address;
const tier = (fee: number, usdcDepth: number | undefined, extra: Partial<Tier> = {}): Tier => ({
  fee,
  pool: `0x${fee.toString(16).padStart(40, '0')}` as Address,
  factory: F,
  trusted: true,
  usdcSide: 0,
  usdcDepth,
  liquidity: 1n,
  ...extra,
});

// Pool layout observed on mainnet 2026-09-15 for one token: 1% tier $114,163; dust at 100/500/3000 with ~$0.
const DEMO_TIERS = [tier(100, 0.000934), tier(500, 0.000007), tier(3000, 0.000002), tier(10000, 114163.13)];
const GUARDS = { minDepthUsd: 50_000, dominanceRatio: 20 };

describe('impact: paper.ts round-trip model at the real size', () => {
  it('1% tier, $1,000 into $114k: 2×fee 200 bps + size term 44 bps = 244 bps', () => {
    expect(impactBps({ feePpm: 10_000, sizeUsd: 1000, depthUsd: 114_163 })).toEqual({ roundTripBps: 244, feeLegsBps: 200, sizeTermBps: 44 });
  });
  it('$5,000 -> 419 bps; $25,000 -> 1295 bps (informational, never blocks)', () => {
    expect(impactBps({ feePpm: 10_000, sizeUsd: 5000, depthUsd: 114_163 }).roundTripBps).toBe(419);
    expect(impactBps({ feePpm: 10_000, sizeUsd: 25_000, depthUsd: 114_163 }).roundTripBps).toBe(1295);
  });
  it('dust pool: $1,000 into $0.0009 caps at 10,000 bps (100%)', () => {
    expect(impactBps({ feePpm: 100, sizeUsd: 1000, depthUsd: 0.000934 }).roundTripBps).toBe(10_000);
  });
  it('matches radar roundTripCost exactly (no second model)', async () => {
    const { roundTripCost } = await import('../../../radar/src/score/paper.js');
    const bps = impactBps({ feePpm: 3000, sizeUsd: 500, depthUsd: 20_000 }).roundTripBps;
    expect(bps).toBe(Math.round(roundTripCost({ feePpm: 3000, sizeUsd: 500, depthUsd: 20_000 })! * 10_000));
  });
  it('realised leg bps: buy that receives 0.985× spot value reads 150 bps; sell symmetric', () => {
    expect(realisedLegBps({ usdc: 1000, tokens: 985, spotUsd: 1, side: 'buy' })).toBe(150);
    expect(realisedLegBps({ usdc: 985, tokens: 1000, spotUsd: 1, side: 'sell' })).toBe(150);
    expect(realisedLegBps({ usdc: 0, tokens: 1, spotUsd: 1, side: 'buy' })).toBeUndefined();
  });
});

describe('pool guard: deepest trusted tier, dust pools never chosen', () => {
  it('DEMO: picks the 1% tier, dominance is astronomical', () => {
    const r = chooseDeepest(DEMO_TIERS, { ...GUARDS, expectedFeeTier: 10000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.chosen.fee).toBe(10000);
      expect(r.runnerUp?.fee).toBe(100);
      expect(r.dominance).toBeGreaterThan(1e7);
    }
  });
  it('dust-only token must ABORT on the depth floor (no deep pool exists)', () => {
    const r = chooseDeepest(DEMO_TIERS.filter((t) => t.fee !== 10000), { minDepthUsd: 2000, dominanceRatio: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/below the floor/);
  });
  it('a fresh launch above the default floor is tradeable without a per-token entry', () => {
    const r = chooseDeepest([tier(10000, 2500)], { minDepthUsd: 2000, dominanceRatio: 20 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dominance).toBe(Infinity);
  });
  it('split liquidity (10k vs 8k) aborts: two comparable pools need an explicit choice', () => {
    const r = chooseDeepest([tier(3000, 10_000), tier(10000, 8_000)], { minDepthUsd: 2000, dominanceRatio: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/liquidity is split/);
  });
  it('expectedFeeTier mismatch aborts (liquidity moved)', () => {
    const r = chooseDeepest(DEMO_TIERS, { ...GUARDS, expectedFeeTier: 3000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expects 3000/);
  });
  it('an unreadable depth is never a zero: abort, never rank', () => {
    const r = chooseDeepest([tier(10000, 114163), tier(3000, undefined, { readError: 'balanceOf failed' })], GUARDS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unreadable/);
  });
  it('a pool that fails the factory round-trip aborts', () => {
    const r = chooseDeepest([tier(10000, 114163, { trusted: false })], GUARDS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/round-trip/);
  });
  it('no pool at all aborts', () => {
    expect(chooseDeepest([], GUARDS).ok).toBe(false);
  });
});

describe('cached pool: every mismatch aborts, nothing falls back', () => {
  const POOL = '0x2222222222222222222222222222222222222222' as Address;
  const DEMO = '0x1111111111111111111111111111111111111111' as Address;
  const USDC = '0x3600000000000000000000000000000000000000' as Address;
  const good = { factory: F, token0: USDC, token1: DEMO, fee: 10000, usdcDepth: 114_000, roundTrip: POOL };
  const exp = { pool: POOL, token: DEMO, factories: [F], expectedFeeTier: 10000, minDepthUsd: 50_000 };
  it('the verified DEMO pool passes with USDC as token0', async () => {
    const { checkCachedPool } = await import('../../src/pool.js');
    expect(checkCachedPool(good, exp)).toEqual({ ok: true, usdcSide: 0 });
  });
  it('wrong factory, wrong pair, wrong fee, foreign round-trip, shallow depth, missing expectedFeeTier: all rejected', async () => {
    const { checkCachedPool } = await import('../../src/pool.js');
    const bad = (o: Partial<typeof good>, e: Partial<typeof exp> = {}) => checkCachedPool({ ...good, ...o }, { ...exp, ...e });
    expect(bad({ factory: '0x942bd5bf00000000000000000000000000000000' as Address })).toMatchObject({ ok: false, reason: expect.stringMatching(/not allowlisted/) });
    expect(bad({ token1: '0x0000000000000000000000000000000000000abc' as Address })).toMatchObject({ ok: false, reason: expect.stringMatching(/not .*\/USDC/) });
    expect(bad({ fee: 3000 })).toMatchObject({ ok: false, reason: expect.stringMatching(/fee\(\) 3000 != expectedFeeTier 10000/) });
    expect(bad({ roundTrip: '0x77bc3fef80a92ed482ea24dd4827dd412df9a959' as Address })).toMatchObject({ ok: false, reason: expect.stringMatching(/getPool returns/) });
    expect(bad({ usdcDepth: 0.000934 })).toMatchObject({ ok: false, reason: expect.stringMatching(/below the floor/) });
    expect(bad({}, { expectedFeeTier: undefined })).toMatchObject({ ok: false, reason: expect.stringMatching(/requires/) });
  });
});

describe('cached pool verification: an RPC failure is never "not a pool"', () => {
  const POOL = '0x2222222222222222222222222222222222222222' as Address;
  const DEMO = '0x1111111111111111111111111111111111111111' as Address;
  const USDC = '0x3600000000000000000000000000000000000000' as Address;
  const quotaErr = () => Object.assign(new Error('HTTP request failed. Status: 429 Details: daily request count exceeded, request rate limited'), { status: 429, name: 'HttpRequestError' });
  const answers: Record<string, unknown> = { factory: F, token0: USDC, token1: DEMO, fee: 10000, decimals: 18, symbol: 'DEMO', getPool: POOL, balanceOf: 114_000_000_000n, slot0: [1514248487155043650879134987835077965n, 335333, 0, 0, 0, 0, true], liquidity: 2280298132493471030n };
  const client = (behave: (fn: string) => unknown) => ({ getChainId: async () => 5042, readContract: async ({ functionName }: { functionName: string }) => behave(functionName) }) as never;
  it('a quota-refusing first endpoint is dropped; the second answers; the pool is accepted', async () => {
    const { RpcPool } = await import('../../src/rpc-pool.js');
    const { _setActivePoolForTests } = await import('../../src/chain.js');
    const { resolveCachedPool } = await import('../../src/pool.js');
    const { loadConfig } = await import('../../src/config.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cfg = loadConfig({ argv: [], env: { PRIVATE_KEY: 'ab'.repeat(32) }, dotenvText: null, jsonText: fs.readFileSync(path.resolve(import.meta.dirname, '../../config/executor.json'), 'utf8') });
    const logs: string[] = [];
    const clients = new Map<string, unknown>([
      ['http://infura', client(() => { throw quotaErr(); })],
      ['http://ok', client((fn) => answers[fn])],
    ]);
    const pool = new RpcPool({ urls: ['http://infura', 'http://ok'], chainId: 5042, rotateAfter: 3, readerRps: 5, readerRetryBaseMs: 1, chain: { id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['http://x'] } } } as never, makeClient: (u) => clients.get(u) as never, logFn: (m) => logs.push(m.replace(/\x1b\[[0-9;]*m/g, '')) });
    _setActivePoolForTests(pool);
    const rp = await resolveCachedPool({ reader: pool.reader, get client() { return pool.client; } }, cfg, DEMO, POOL);
    _setActivePoolForTests(undefined);
    expect(rp.chosen.fee).toBe(10000);
    expect(rp.chosen.usdcDepth).toBe(114_000);
    expect(rp.symbol).toBe('DEMO');
    expect(logs.some((l) => /RPC DROPPED infura: quota\/auth/.test(l))).toBe(true);
  });
});
