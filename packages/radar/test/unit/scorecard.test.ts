import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config/env.js';
import { MemorySink } from '../../src/discord/client.js';
import { Router } from '../../src/discord/router.js';
import { parseGrid, replayLpSurge, type StoredEvent } from '../../src/jobs/calibrate.js';
import { attachSignalScoring, sampleSignals } from '../../src/jobs/precision.js';
import { buildScorecard } from '../../src/jobs/scorecard.js';
import type { Pipeline } from '../../src/pipeline.js';
import { decide } from '../../src/score/gate.js';
import type { Signal } from '../../src/score/types.js';
import { Store, type PoolMetaRow } from '../../src/store/sqlite.js';
import { FIXTURE_ENV } from '../../src/testing/runner.js';

const CHAIN = 5042;
const USDC = '0x3600000000000000000000000000000000000000';
const P = '0x00000000000000000000000000000000000000a1';
const Q = '0x00000000000000000000000000000000000000b2';
const T = '0x00000000000000000000000000000000000000c3';
const Q96 = 2n ** 96n;
const sqrtFor: Record<number, bigint> = { 1: Q96, 2.25: 3n * 2n ** 95n, 4: 2n * Q96 }; // USDC=token1 → price = (sqrt/2^96)^2

let seq = 0;
function swap(store: Store, pool: string, t: number, px: 1 | 2.25 | 4) {
  const json = JSON.stringify({ emitter: pool, kind: 'swap', dex: 'univ3', pool, sender: T, recipient: T, amount0: '-1', amount1: '1', sqrtPriceX96: sqrtFor[px]!.toString() });
  store.insertEvent(CHAIN, `0x${(++seq).toString(16).padStart(64, '0')}:0`, 'swap', BigInt(Math.floor(t / 500)), t, pool, json);
}

function fire(store: Store, f: { type: string; pool?: string; direction: 'long' | 'avoid'; firedMs: number; lagMs: number; fee?: number; depth?: number; venue?: string; symbol?: string }) {
  return store.recordSignalFire(
    { chainId: CHAIN, type: f.type, channel: 'launchpads', ping: false, pool: f.pool, direction: f.direction, eventMs: f.firedMs - f.lagMs, firedMs: f.firedMs, poolFee: f.fee, poolUsdcDepth: f.depth, venue: f.venue, symbol: f.symbol },
    [60, 300],
  );
}

describe('pool_meta cache', () => {
  it('upsert keeps known fields, follows latest trust, records depth', () => {
    const s = new Store(':memory:');
    s.upsertPoolMeta(CHAIN, { pool: P.toUpperCase().replace('0X', '0x'), dex: 'univ3', token0: T, token1: USDC, fee: 3000, factory: '0xf0', trusted: false, usdcSide: 1 }, 1);
    s.upsertPoolMeta(CHAIN, { pool: P, dex: 'univ3', trusted: true }, 2);
    let m = s.getPoolMeta(CHAIN, P)!;
    expect(m).toMatchObject({ pool: P, token0: T, token1: USDC, fee: 3000, factory: '0xf0', trusted: 1, usdc_side: 1, usdc_depth: null, updated_ms: 2 });
    s.setPoolDepth(CHAIN, P, 12_345, 3);
    m = s.getPoolMeta(CHAIN, P)!;
    expect(m).toMatchObject({ usdc_depth: 12_345, depth_ms: 3 });
    s.setPoolDepth(CHAIN, Q, 1, 4); // unknown pool: no-op
    expect(s.getPoolMeta(CHAIN, Q)).toBeUndefined();
  });
});

describe('scorecard on a synthetic events DB (known answer)', () => {
  const store = new Store(':memory:');
  store.upsertPoolMeta(CHAIN, { pool: P, dex: 'univ3', token0: T, token1: USDC, fee: 3000, trusted: true, usdcSide: 1 }, 0);
  store.upsertPoolMeta(CHAIN, { pool: Q, dex: 'univ3', token0: T, token1: USDC, fee: 500, trusted: true, usdcSide: 1, usdcDepth: 10_000 }, 0);
  for (const [t, px] of [[5_000, 1], [13_000, 1], [100_000, 2.25], [400_000, 4]] as const) swap(store, P, t, px);
  for (const [t, px] of [[50_000, 4], [54_000, 4], [80_000, 1], [100_000, 2.25]] as const) swap(store, Q, t, px);
  fire(store, { type: 'NEW_LAUNCH', pool: P, direction: 'long', firedMs: 10_000, lagMs: 2000, fee: 3000, depth: 50_000, venue: 'Lift', symbol: 'AAA' });
  fire(store, { type: 'LP_REMOVE', pool: Q, direction: 'avoid', firedMs: 50_000, lagMs: 1000 }); // fee/depth from pool_meta
  fire(store, { type: 'MAJOR_ANOMALY', direction: 'long', firedMs: 20_000, lagMs: 3000 }); // no pool → unpriced
  fire(store, { type: 'EARLY_BUYER_DENSITY', pool: P, direction: 'long', firedMs: 390_000, lagMs: 500 }); // horizons beyond data → pending
  const sc = buildScorecard(store, { chainId: CHAIN, sinceMs: 0, dataEndMs: 400_000, latencyMs: 3000, sizeUsd: 500, horizonsSec: [60, 300], gateHorizonSec: 300 });
  const row = (type: string, h: number, group = 'type', key = type) => sc.rows.find((r) => r.group === group && r.type === type && r.key === key && r.horizonSec === h)!;

  it('long: T+1m flat pays costs; T+5m catches the 2.25× move', () => {
    expect(sc.fires).toBe(4);
    const cost = 0.006 + 500 / 100_000;
    expect(row('NEW_LAUNCH', 60)).toMatchObject({ fires: 1, filled: 1, netN: 1, hitRate: 0, avgDetectLagMs: 2000 });
    expect(row('NEW_LAUNCH', 60).meanNet).toBeCloseTo(-cost, 12);
    expect(row('NEW_LAUNCH', 300)).toMatchObject({ netN: 1, hitRate: 1 });
    expect(row('NEW_LAUNCH', 300).meanNet).toBeCloseTo(1.25 - cost, 12);
    expect(row('NEW_LAUNCH', 300, 'pad', 'Lift').meanNet).toBeCloseTo(1.25 - cost, 12);
    expect(row('NEW_LAUNCH', 300, 'token', 'AAA').netN).toBe(1);
  });

  it('avoid: drop avoided + drawdown avoided, costs from pool_meta', () => {
    const r = row('LP_REMOVE', 60);
    expect(r).toMatchObject({ filled: 1, netN: 1, hitRate: 1 });
    expect(r.meanGross).toBeCloseTo(1 - 2.25 / 4, 12);
    expect(r.meanNet).toBeCloseTo(1 - 2.25 / 4 - (0.001 + 500 / 20_000), 12);
    expect(r.avgDrawdownAvoided).toBeCloseTo(0.75, 12);
  });

  it('no pool → unpriced; horizon past data → pending; gate reports insufficient n', () => {
    expect(row('MAJOR_ANOMALY', 60)).toMatchObject({ fires: 1, filled: 0, pending: 0, netN: 0 });
    expect(row('EARLY_BUYER_DENSITY', 60)).toMatchObject({ fires: 1, filled: 0, pending: 1, netN: 0 });
    expect(sc.gate.map((g) => [g.type, g.verdict])).toEqual([
      ['EARLY_BUYER_DENSITY', 'insufficient'],
      ['LP_REMOVE', 'insufficient'],
      ['MAJOR_ANOMALY', 'insufficient'],
      ['NEW_LAUNCH', 'insufficient'],
    ]);
  });

  it('signal_samples were scheduled per horizon', () => {
    expect((store.db.prepare('SELECT COUNT(*) c FROM signal_samples').get() as { c: number }).c).toBe(8);
  });
});

describe('live recorder: every routed scorable signal, deferred write, gate untouched', () => {
  it('records specialty + alerts posts; skips meta signals, logs-only refusals and warm-start history', async () => {
    const cfg = loadConfig({ ...FIXTURE_ENV, ALERTS_PING_ENABLED: '1' } as NodeJS.ProcessEnv);
    const clock = new FakeClock(1_000_000);
    const sink = new MemorySink();
    const router = new Router(cfg, sink, clock, pino({ level: 'silent' }));
    const store = new Store(':memory:');
    const pool = { fee: 3000, usdcDepth: 7777, priceUsd: 0.5 };
    const pipeline = { pools: { get: (p: string) => (p === P ? pool : undefined) }, majors: new Map() } as unknown as Pipeline;
    attachSignalScoring(router, pipeline, store, cfg, () => clock.now());

    const base = { severity: 'watch', eventTimeMs: 999_000, evidence: { usdCertain: true, trusted: true } } as const;
    const signals: Signal[] = [
      { ...base, type: 'NEW_LAUNCH', channel: 'launchpads', dedupeKey: 'a', pool: P as `0x${string}`, token: { address: T as `0x${string}`, symbol: 'AAA' }, venue: 'Lift' },
      { ...base, type: 'LP_SURGE', hardRule: 'LP_SURGE', severity: 'alert', channel: 'alerts', dedupeKey: 'b', extraFields: [{ name: 'pool', value: `[x](https://e/address/${P})` }], lp: 60_000 },
      { ...base, type: 'MAJOR_DIGEST', channel: 'major-coins', dedupeKey: 'c', compact: true },
      { ...base, type: 'EARLY_BUYER_DENSITY', channel: 'alerts', dedupeKey: 'd' }, // not a hard rule, no fallback → logs only
    ];
    const decisions = [];
    for (const s of signals) decisions.push((await router.route(s)).decision);
    router.setLiveFrom(2_000_000);
    await router.route({ ...base, type: 'LP_WATCH', channel: 'launchpads', dedupeKey: 'e', pool: P as `0x${string}` }); // historic → muted
    expect(store.db.prepare('SELECT COUNT(*) c FROM signal_fires').get()).toEqual({ c: 0 }); // deferred, not written inline
    await new Promise((r) => setImmediate(r));

    expect(decisions).toEqual(signals.map((s) => decide(s, true))); // the recorder never changes gate decisions
    const rows = store.db.prepare('SELECT type, channel, ping, pool, direction, price_at_fire, price_source, pool_fee, pool_usdc_depth, detect_lag_ms, symbol, venue FROM signal_fires ORDER BY id').all();
    expect(rows).toEqual([
      { type: 'NEW_LAUNCH', channel: 'launchpads', ping: 0, pool: P, direction: 'long', price_at_fire: 0.5, price_source: 'pool_last', pool_fee: 3000, pool_usdc_depth: 7777, detect_lag_ms: 1000, symbol: 'AAA', venue: 'Lift' },
      { type: 'LP_SURGE', channel: 'alerts', ping: 1, pool: P, direction: 'long', price_at_fire: 0.5, price_source: 'pool_last', pool_fee: 3000, pool_usdc_depth: 60_000, detect_lag_ms: 1000, symbol: null, venue: null },
    ]);

    clock.set(1_000_000 + 60_000);
    sampleSignals(pipeline, store, clock.now());
    const filled = store.db.prepare('SELECT horizon_sec, price, lp FROM signal_samples WHERE sampled_ms IS NOT NULL ORDER BY fire_id').all();
    expect(filled).toEqual([
      { horizon_sec: 60, price: 0.5, lp: 7777 },
      { horizon_sec: 60, price: 0.5, lp: 7777 },
    ]);
  });
});

describe('calibrate helpers', () => {
  it('grid = cartesian product; unknown keys rejected', () => {
    expect(parseGrid('MAJOR_ANOMALY', ['z=3,4', 'pct=50'])).toEqual([{ z: 3, pct: 50 }, { z: 4, pct: 50 }]);
    expect(parseGrid('LP_SURGE', ['lp=1000;window=60,120'])).toEqual([{ lp: 1000, window: 60 }, { lp: 1000, window: 120 }]);
    expect(parseGrid('NEW_LAUNCH', [])).toEqual([{}]);
    expect(() => parseGrid('LP_SURGE', ['z=3'])).toThrow(/not valid/);
  });

  it('LP_SURGE replay uses evaluateLp: fires once per surge, respects the dedupe window', () => {
    const cfg = loadConfig({ ...FIXTURE_ENV } as NodeJS.ProcessEnv);
    const meta = new Map<string, PoolMetaRow>([[P, { chain_id: CHAIN, pool: P, dex: 'univ3', token0: T, token1: USDC, fee: 3000, factory: null, trusted: 1, usdc_side: 1, usdc_depth: null, depth_ms: null, updated_ms: 0 }]]);
    const mint = (t: number, usd: number): StoredEvent => ({ t, block: t, li: 0, kind: 'mint', emitter: P, j: { amount0: '0', amount1: String(usd * 1e6) } });
    const th = { ...cfg.thresholds, lpUsd: 5000, lpWatchUsd: 1000, lpWindowSec: 120, dedupeSec: 60 };
    // 3k + 3k → surge at t=10s; +6k at 30s re-surges inside dedupe (suppressed); +6k at 200s fires again.
    const fires = replayLpSurge([mint(0, 3000), mint(10_000, 3000), mint(30_000, 6000), mint(200_000, 6000)], meta, th);
    expect(fires.map((f) => f.t)).toEqual([10_000, 200_000]);
    expect(fires[0]).toMatchObject({ pool: P, token: T, trusted: true });
  });

  it('single-sided seed (Lift/Tolly/RadarDEX pattern): LP_SURGE reads swap flow, never Mint — whose USDC side is always 0 there, so it can never surge at any threshold', () => {
    const cfg = loadConfig({ ...FIXTURE_ENV } as NodeJS.ProcessEnv);
    const meta = new Map<string, PoolMetaRow>([[P, { chain_id: CHAIN, pool: P, dex: 'univ3', token0: T, token1: USDC, fee: 3000, factory: null, trusted: 1, usdc_side: 1, usdc_depth: null, depth_ms: null, updated_ms: 0 }]]);
    const th = { ...cfg.thresholds, lpUsd: 5000, lpWatchUsd: 1000, lpWindowSec: 120, dedupeSec: 60 };
    const singleSidedMint = (t: number): StoredEvent => ({ t, block: t, li: 0, kind: 'mint', emitter: P, j: { amount0: '999999999', amount1: '0' } }); // token side only
    const buy = (t: number, usd: number): StoredEvent => ({ t, block: t, li: 1, kind: 'swap', emitter: P, j: { amount0: '-1', amount1: String(usd * 1e6) } });
    const sell = (t: number, usd: number): StoredEvent => ({ t, block: t, li: 1, kind: 'swap', emitter: P, j: { amount0: '1', amount1: String(-usd * 1e6) } });

    // Mint alone never fires, no matter how it's replayed — the USDC-side amount is always 0 on this venue's launches.
    expect(replayLpSurge([singleSidedMint(0)], meta, th)).toEqual([]);

    // Two buys within the window cross the threshold via swap flow.
    const fires = replayLpSurge([singleSidedMint(0), buy(1_000, 2000), buy(2_000, 3000)], meta, th);
    expect(fires.map((f) => f.t)).toEqual([2_000]);
    expect(fires[0]).toMatchObject({ pool: P, token: T, trusted: true });

    // A sell nets against the window (it is NOT treated as an LP removal — selling doesn't pull a position) but
    // still lowers what's available to surge on: $3000 buy, $2000 sell, $3500 buy — gross buys are $6500 (over
    // the $5k threshold) but net is $3000-$2000+$3500=$4500, so it correctly does NOT fire.
    const netted = replayLpSurge([singleSidedMint(0), buy(0, 3000), sell(1_000, 2000), buy(2_000, 3500)], meta, th);
    expect(netted).toEqual([]);
  });
});
