import type { Address } from 'viem';
import type { Thresholds } from '../config/env.js';
import type { Watchlists } from '../config/watchlists.js';
import type { Dex } from '../decode/types.js';
import { MajorState, type AnomalyParams } from '../features/majors.js';
import { RollingEvents } from '../features/volume.js';
import { abs, USDC_ERC20_DECIMALS, toNumber } from '../math/units.js';
import type { ChainReader } from '../rpc/reader.js';
import { curvePriceRaw, paperFill, promotionVerdict, returnStats, roundTripCost, swapPriceRaw, type PricePoint, type PromotionVerdict } from '../score/paper.js';
import { evaluateLp, type LpVerdict } from '../score/rules/lp.js';
import type { PoolMetaRow, Store } from '../store/sqlite.js';

/**
 * Offline threshold calibration: replay the stored `events` table through the REAL rule functions
 * (MajorState.evaluate, evaluateLp; NEW_LAUNCH = the pipeline's launcher-authorization check) and paper-score each fire.
 * Approximations (printed by the CLI): fire time = block time (PAPER_LATENCY_MS models detection + execution),
 * USDC depth = depth observed when calibrate ran (not at the fire), major price source = deepest trusted pool now.
 */

export type CalibRule = 'MAJOR_ANOMALY' | 'LP_SURGE' | 'NEW_LAUNCH';
export const GRID_KEYS: Record<CalibRule, string[]> = {
  MAJOR_ANOMALY: ['z', 'pct', 'minvol', 'samples', 'cooldown'],
  LP_SURGE: ['lp', 'watch', 'window'],
  NEW_LAUNCH: [],
};

const lc = (a: string) => a.toLowerCase();
const logIndexOf = (id: string) => Number(id.slice(id.lastIndexOf(':') + 1));

interface EvRow {
  id: string;
  t_ms: number;
  block: number;
  kind: string;
  emitter: string;
  json: string;
}

export interface StoredEvent {
  t: number;
  block: number;
  li: number;
  kind: string;
  emitter: string;
  j: Record<string, unknown>;
}

/** All events of the given kinds in [fromMs, toMs], in chain order. */
export function loadEvents(store: Store, chainId: number, kinds: string[], fromMs: number, toMs: number): StoredEvent[] {
  const rows = store.db
    .prepare(`SELECT id, t_ms, block, kind, emitter, json FROM events WHERE chain_id = ? AND t_ms >= ? AND t_ms <= ? AND kind IN (${kinds.map(() => '?').join(',')})`)
    .all(chainId, fromMs, toMs, ...kinds) as unknown as EvRow[];
  const out = rows.map((r) => ({ t: r.t_ms, block: r.block, li: logIndexOf(r.id), kind: r.kind, emitter: r.emitter, j: JSON.parse(r.json) as Record<string, unknown> }));
  out.sort((a, b) => a.t - b.t || a.block - b.block || a.li - b.li);
  return out;
}

export function ammFactories(w: Watchlists): Map<string, { kind: Dex; role: string; name: string }> {
  const m = new Map<string, { kind: Dex; role: string; name: string }>();
  for (const v of [...w.pads, ...w.dex]) for (const f of v.factories) if (f.kind === 'univ2' || f.kind === 'univ3') m.set(lc(f.address), { kind: f.kind, role: f.role, name: v.name });
  return m;
}

export function launchers(w: Watchlists): Map<string, { pad: string; kind: string }> {
  const m = new Map<string, { pad: string; kind: string }>();
  for (const v of [...w.pads, ...w.dex]) for (const f of v.factories) if (f.kind !== 'univ2' && f.kind !== 'univ3' && f.kind !== 'todo') m.set(lc(f.address), { pad: v.name, kind: f.kind });
  return m;
}

const usdcSideOf = (usdc: string, t0?: string | null, t1?: string | null): 0 | 1 | undefined => (t0 === lc(usdc) ? 0 : t1 === lc(usdc) ? 1 : undefined);

/** pool_meta from stored PoolCreated logs (trusted iff the emitting factory is allowlisted — same proof as the pipeline). */
export function seedMetaFromEvents(store: Store, chainId: number, w: Watchlists, usdc: string, nowMs: number): number {
  const facs = ammFactories(w);
  const rows = store.db.prepare(`SELECT emitter, json FROM events WHERE chain_id = ? AND kind = 'pool_created'`).all(chainId) as { emitter: string; json: string }[];
  for (const r of rows) {
    const j = JSON.parse(r.json) as { pool: string; dex: Dex; token0: string; token1: string; fee?: number; factory: string };
    store.upsertPoolMeta(chainId, { pool: j.pool, dex: j.dex, token0: j.token0, token1: j.token1, fee: j.fee, factory: j.factory, trusted: facs.has(lc(r.emitter)), usdcSide: usdcSideOf(usdc, j.token0, j.token1) }, nowMs);
  }
  return rows.length;
}

/**
 * Resolve metadata for pools seen only via Swap/Mint/Burn over the (rate-limited) RPC reader and cache it in pool_meta.
 * Transient failures are not cached (re-run resumes). Trust = factory() allowlisted AND factory.getPool/getPair round trip.
 */
export async function resolveMissingMeta(
  store: Store,
  chainId: number,
  reader: ChainReader,
  pools: { pool: string; dex: Dex }[],
  w: Watchlists,
  usdc: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ resolved: number; failed: number }> {
  const facs = ammFactories(w);
  const todo = pools.filter((p) => !store.getPoolMeta(chainId, p.pool)?.token0);
  let resolved = 0;
  let failed = 0;
  const BATCH = 16;
  for (let i = 0; i < todo.length; i += BATCH) {
    await Promise.all(
      todo.slice(i, i + BATCH).map(async ({ pool, dex }) => {
        const on = await reader.poolOnchain(pool as Address, dex);
        if (!on.token0 || !on.token1 || on.incomplete) {
          failed++;
          return;
        }
        let trusted = false;
        const f = on.factory ? facs.get(lc(on.factory)) : undefined;
        if (f) trusted = (await reader.factoryLookup(on.factory!, dex, on.token0, on.token1, on.fee)) === lc(pool);
        store.upsertPoolMeta(chainId, { pool, dex, token0: on.token0, token1: on.token1, fee: on.fee, factory: on.factory, trusted, usdcSide: usdcSideOf(usdc, on.token0, on.token1) }, Date.now());
        resolved++;
      }),
    );
    onProgress?.(Math.min(i + BATCH, todo.length), todo.length);
  }
  return { resolved, failed };
}

/** USDC depth (current balanceOf) for pools lacking one. */
export async function fillDepths(store: Store, chainId: number, reader: ChainReader, pools: string[], usdc: string) {
  let n = 0;
  await Promise.all(
    [...new Set(pools)].map(async (pool) => {
      const m = store.getPoolMeta(chainId, pool);
      if (!m || m.usdc_side === null || m.usdc_depth !== null) return;
      const bal = await reader.balanceOf(usdc as Address, pool as Address);
      if (bal === undefined) return;
      store.setPoolDepth(chainId, pool, toNumber(bal, USDC_ERC20_DECIMALS), Date.now());
      n++;
    }),
  );
  return n;
}

export interface ReplayFire {
  t: number;
  pool: string;
  token?: string;
  symbol?: string;
  trusted: boolean;
  detail?: string;
}

/** Per-pool raw price series from swaps (USDC pools) and bonding-curve trades. */
export function priceSeriesByPool(events: StoredEvent[], meta: Map<string, PoolMetaRow>): Map<string, PricePoint[]> {
  const out = new Map<string, PricePoint[]>();
  for (const e of events) {
    let px: number | undefined;
    if (e.kind === 'swap') {
      const m = meta.get(e.emitter);
      if (m?.usdc_side !== 0 && m?.usdc_side !== 1) continue;
      px = swapPriceRaw({ amount0: BigInt(e.j.amount0 as string), amount1: BigInt(e.j.amount1 as string), sqrtPriceX96: e.j.sqrtPriceX96 ? BigInt(e.j.sqrtPriceX96 as string) : undefined }, m.usdc_side);
    } else if (e.kind === 'pad_trade') {
      px = curvePriceRaw({ quoteRaw: BigInt(e.j.quoteRaw as string), tokenRaw: BigInt(e.j.tokenRaw as string) });
    }
    if (px === undefined) continue;
    const s = out.get(e.emitter) ?? [];
    s.push({ t: e.t, px });
    out.set(e.emitter, s);
  }
  return out;
}

/** Source pool per major = deepest trusted USDC pool with >= minLpUsd (as refreshMajorDepths does live). */
export function majorSourcePools(meta: Map<string, PoolMetaRow>, majors: { has(token: string): boolean }, minLpUsd: number): Map<string, string> {
  const best = new Map<string, PoolMetaRow>();
  for (const m of meta.values()) {
    if (m.usdc_side === null || !m.trusted || m.usdc_depth === null || m.usdc_depth < minLpUsd) continue;
    const token = m.usdc_side === 0 ? m.token1 : m.token0;
    if (!token || !majors.has(token)) continue;
    const cur = best.get(token);
    if (!cur || (cur.usdc_depth ?? 0) < m.usdc_depth) best.set(token, m);
  }
  return new Map([...best].map(([t, m]) => [t, m.pool]));
}

/** MAJOR_ANOMALY replay: same call order as Pipeline.onSwap (onSwap → evaluate → lastAnomalyMs). */
export function replayMajorAnomaly(
  swaps: StoredEvent[],
  meta: Map<string, PoolMetaRow>,
  majors: Map<string, string>, // address -> symbol
  sources: Map<string, string>,
  params: AnomalyParams,
): ReplayFire[] {
  const states = new Map<string, MajorState>();
  const fires: ReplayFire[] = [];
  for (const e of swaps) {
    if (e.kind !== 'swap') continue;
    const m = meta.get(e.emitter);
    if (!m || m.usdc_side === null) continue;
    const token = m.usdc_side === 0 ? m.token1 : m.token0;
    if (!token || !majors.has(token)) continue;
    let st = states.get(token);
    if (!st) {
      st = new MajorState(token as Address, majors.get(token)!);
      st.setSource(sources.get(token) as Address | undefined);
      states.set(token, st);
    }
    const a0 = BigInt(e.j.amount0 as string);
    const a1 = BigInt(e.j.amount1 as string);
    const usdcRaw = m.usdc_side === 0 ? a0 : a1;
    const usd = toNumber(usdcRaw < 0n ? -usdcRaw : usdcRaw, USDC_ERC20_DECIMALS);
    const px = swapPriceRaw({ amount0: a0, amount1: a1, sqrtPriceX96: e.j.sqrtPriceX96 ? BigInt(e.j.sqrtPriceX96 as string) : undefined }, m.usdc_side);
    st.onSwap(e.t, usd, usdcRaw > 0n, px, e.emitter as Address);
    const r = st.evaluate(e.t, params);
    if (!r) continue;
    st.lastAnomalyMs = e.t;
    const pool = st.sourcePool ?? e.emitter;
    fires.push({ t: e.t, pool, token, symbol: st.symbol, trusted: Boolean(meta.get(pool)?.trusted), detail: r.kind });
  }
  return fires;
}

interface LpReplayPoolState {
  lp: RollingEvents;
  /** Swap-flow deltas, for pools whose Mint events never touch the USDC side — see pipeline.ts onLiquidity/onSwap. */
  lpFromSwaps: RollingEvents;
  lastSurgeFireMs: number;
  lastPostedMs: number;
  singleSidedSeed?: boolean;
}

/**
 * LP_SURGE replay: mirrors pipeline.ts's dual mechanism (onLiquidity for two-sided seeds, onSwap's swap-flow
 * path for single-sided ones — Lift/Tolly/RadarDEX seed only the non-USDC side, so `lp`'s USDC delta is always
 * 0 there and can never surge) + router dedupe window. `events` should include mint/burn/swap.
 */
export function replayLpSurge(events: StoredEvent[], meta: Map<string, PoolMetaRow>, th: Thresholds): ReplayFire[] {
  const pools = new Map<string, LpReplayPoolState>();
  const fires: ReplayFire[] = [];
  const poolFor = (emitter: string): LpReplayPoolState => {
    let p = pools.get(emitter);
    if (!p) {
      const horizonMs = Math.max(th.lpWindowSec, 600) * 1000;
      p = { lp: new RollingEvents(horizonMs), lpFromSwaps: new RollingEvents(horizonMs), lastSurgeFireMs: -Infinity, lastPostedMs: -Infinity };
      pools.set(emitter, p);
    }
    return p;
  };
  const tryFire = (emitter: string, p: LpReplayPoolState, m: PoolMetaRow, t: number, v: LpVerdict) => {
    if (v?.kind !== 'surge') return;
    p.lastSurgeFireMs = t;
    // Router dedupe: same LP|pool key and rank within DEDUPE_SEC of the last POSTED surge is suppressed (window not extended).
    if (t - p.lastPostedMs < th.dedupeSec * 1000) return;
    p.lastPostedMs = t;
    const token = m.usdc_side === 0 ? m.token1 : m.token0;
    fires.push({ t, pool: emitter, token: token ?? undefined, trusted: Boolean(m.trusted), detail: `net $${v.netUsd.toFixed(0)}` });
  };
  for (const e of events) {
    const m = meta.get(e.emitter);
    if (!m || m.usdc_side === null) continue;
    const p = poolFor(e.emitter);
    if (e.kind === 'mint' || e.kind === 'burn') {
      const usd = toNumber(BigInt((m.usdc_side === 0 ? e.j.amount0 : e.j.amount1) as string), USDC_ERC20_DECIMALS);
      const delta = e.kind === 'mint' ? usd : -usd;
      p.lp.push(e.t, delta);
      if (e.kind === 'mint' && p.singleSidedSeed === undefined) p.singleSidedSeed = usd === 0;
      if (p.singleSidedSeed) continue;
      tryFire(e.emitter, p, m, e.t, evaluateLp(p.lp, p.lastSurgeFireMs, e.t, delta, th));
    } else if (e.kind === 'swap') {
      const usdcRaw = BigInt((m.usdc_side === 0 ? e.j.amount0 : e.j.amount1) as string);
      const isBuy = usdcRaw > 0n;
      const usd = toNumber(abs(usdcRaw), USDC_ERC20_DECIMALS); // unsigned: isBuy carries the sign below, same as pipeline.ts onSwap
      p.lpFromSwaps.push(e.t, isBuy ? usd : -usd);
      if (p.singleSidedSeed && isBuy) tryFire(e.emitter, p, m, e.t, evaluateLp(p.lpFromSwaps, p.lastSurgeFireMs, e.t, usd, th));
    }
  }
  return fires;
}

/** NEW_LAUNCH replay: launcher events from the allowlisted emitter of the matching adapter (Pipeline.onPadTokenCreated). */
export function replayNewLaunch(launches: StoredEvent[], w: Watchlists, meta: Map<string, PoolMetaRow>): ReplayFire[] {
  const ls = launchers(w);
  const seen = new Set<string>();
  const fires: ReplayFire[] = [];
  for (const e of launches) {
    if (e.kind !== 'pad_token_created') continue;
    const l = ls.get(e.emitter);
    if (!l || l.kind !== e.j.adapter) continue;
    const token = e.j.token as string;
    if (seen.has(token)) continue;
    seen.add(token);
    const pool = (e.j.pool ?? e.j.curve) as string | undefined;
    if (!pool) continue;
    fires.push({ t: e.t, pool, token, symbol: e.j.symbol as string | undefined, trusted: e.j.curve ? true : Boolean(meta.get(pool)?.trusted), detail: l.pad });
  }
  return fires;
}

export interface GridResult {
  params: Record<string, number>;
  fires: number;
  trustedFires: number;
  byHorizon: { horizonSec: number; filled: number; pending: number; netN: number; hitRate?: number; mean?: number; median?: number; meanGross?: number }[];
  verdict: PromotionVerdict;
  verdictReasons: string[];
}

export function scoreReplayFires(
  fires: ReplayFire[],
  series: Map<string, PricePoint[]>,
  meta: Map<string, PoolMetaRow>,
  o: { latencyMs: number; sizeUsd: number; horizonsSec: number[]; dataEndMs: number; gateHorizonSec: number },
  params: Record<string, number>,
): GridResult {
  const byHorizon = o.horizonsSec.map((h) => {
    let filled = 0;
    let pending = 0;
    const nets: number[] = [];
    const grosses: number[] = [];
    for (const f of fires) {
      const m = meta.get(f.pool);
      const cost = roundTripCost({ feePpm: m?.fee ?? undefined, dex: m?.dex, sizeUsd: o.sizeUsd, depthUsd: m?.usdc_depth ?? undefined });
      const r = paperFill(series.get(f.pool) ?? [], { firedMs: f.t, latencyMs: o.latencyMs, horizonMs: h * 1000, direction: 'long', cost, dataEndMs: o.dataEndMs });
      if (r.status === 'pending') pending++;
      if (r.status !== 'filled') continue;
      filled++;
      grosses.push(r.fill.gross);
      if (r.fill.net !== undefined) nets.push(r.fill.net);
    }
    const st = returnStats(nets);
    return { horizonSec: h, filled, pending, netN: st.n, hitRate: st.hitRate, mean: st.mean, median: st.median, meanGross: returnStats(grosses).mean };
  });
  const gate = byHorizon.find((b) => b.horizonSec === o.gateHorizonSec) ?? byHorizon[byHorizon.length - 1]!;
  const v = promotionVerdict({ n: gate.netN, hitRate: gate.hitRate, mean: gate.mean });
  return { params, fires: fires.length, trustedFires: fires.filter((f) => f.trusted).length, byHorizon, verdict: v.verdict, verdictReasons: v.reasons };
}

/** `--grid z=3,4,5 --grid pct=50,100` (or `z=3,4;pct=50`) → cartesian product. Unknown keys throw. */
export function parseGrid(rule: CalibRule, specs: string[]): Record<string, number>[] {
  const axes: [string, number[]][] = [];
  for (const part of specs.flatMap((s) => s.split(/[;\s]+/)).filter(Boolean)) {
    const [k, vs] = part.split('=');
    if (!k || !vs || !GRID_KEYS[rule].includes(k)) throw new Error(`grid key "${k}" not valid for ${rule} (allowed: ${GRID_KEYS[rule].join(', ') || 'none'})`);
    const values = vs.split(',').map(Number);
    if (values.some((x) => !Number.isFinite(x))) throw new Error(`grid values for ${k} must be numbers: ${vs}`);
    axes.push([k, values]);
  }
  let combos: Record<string, number>[] = [{}];
  for (const [k, values] of axes) combos = combos.flatMap((c) => values.map((v) => ({ ...c, [k]: v })));
  return combos;
}

export function anomalyParams(th: Thresholds, g: Record<string, number>): AnomalyParams {
  return {
    z: g.z ?? th.anomalyZ,
    pct: g.pct ?? th.anomalyPct,
    minSamples: g.samples ?? th.anomalyMinSamples,
    minVolUsd: g.minvol ?? th.anomalyMinVolUsd,
    cooldownMs: (g.cooldown ?? th.anomalyCooldownSec) * 1000,
  };
}

export function lpThresholds(th: Thresholds, g: Record<string, number>): Thresholds {
  return { ...th, lpUsd: g.lp ?? th.lpUsd, lpWatchUsd: g.watch ?? th.lpWatchUsd, lpWindowSec: g.window ?? th.lpWindowSec };
}

export function loadMetaMap(store: Store, chainId: number): Map<string, PoolMetaRow> {
  const rows = store.db.prepare('SELECT * FROM pool_meta WHERE chain_id = ?').all(chainId) as unknown as PoolMetaRow[];
  return new Map(rows.map((r) => [r.pool, r]));
}
