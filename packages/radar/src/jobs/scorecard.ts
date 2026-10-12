import type { DatabaseSync } from 'node:sqlite';
import {
  curvePriceRaw,
  paperFill,
  promotionVerdict,
  returnStats,
  roundTripCost,
  swapPriceRaw,
  type Direction,
  type PaperFill,
  type PricePoint,
  type PromotionVerdict,
} from '../score/paper.js';
import type { PoolMetaRow, Store } from '../store/sqlite.js';

/**
 * Edge scorecard (paper, offline). Reads signal_fires + events + pool_meta; never writes, never touches Discord.
 * Prices come from the chain events the radar stored, so a fill is only as good as ingest coverage.
 */

export interface ScorecardOpts {
  chainId: number;
  sinceMs: number;
  /** End of stored data (horizons beyond it are "pending"). */
  dataEndMs: number;
  latencyMs: number;
  sizeUsd: number;
  horizonsSec: number[];
  /** Horizon the promotion rule is evaluated on. */
  gateHorizonSec: number;
}

interface FireRow {
  id: number;
  type: string;
  venue: string | null;
  token: string | null;
  symbol: string | null;
  pool: string | null;
  direction: Direction;
  pool_fee: number | null;
  pool_usdc_depth: number | null;
  fired_ms: number;
  detect_lag_ms: number;
}

const logIndexOf = (id: string) => Number(id.slice(id.lastIndexOf(':') + 1));

/**
 * Price series of a pool (V2/V3 swaps, needs pool_meta.usdc_side) or a bonding curve (pad_trade), in chain order.
 * Raw units: only ratios are meaningful.
 */
export function loadPriceSeries(db: DatabaseSync, chainId: number, pool: string, meta: PoolMetaRow | undefined, fromMs: number, toMs: number): PricePoint[] {
  const rows = db
    .prepare(`SELECT id, t_ms, block, kind, json FROM events WHERE chain_id = ? AND emitter = ? AND t_ms >= ? AND t_ms <= ? AND kind IN ('swap', 'pad_trade')`)
    .all(chainId, pool.toLowerCase(), fromMs, toMs) as { id: string; t_ms: number; block: number; kind: string; json: string }[];
  rows.sort((a, b) => a.t_ms - b.t_ms || a.block - b.block || logIndexOf(a.id) - logIndexOf(b.id));
  const out: PricePoint[] = [];
  for (const r of rows) {
    const j = JSON.parse(r.json) as Record<string, string>;
    let px: number | undefined;
    if (r.kind === 'swap') {
      if (meta?.usdc_side !== 0 && meta?.usdc_side !== 1) continue;
      px = swapPriceRaw({ amount0: BigInt(j.amount0!), amount1: BigInt(j.amount1!), sqrtPriceX96: j.sqrtPriceX96 ? BigInt(j.sqrtPriceX96) : undefined }, meta.usdc_side);
    } else {
      px = curvePriceRaw({ quoteRaw: BigInt(j.quoteRaw!), tokenRaw: BigInt(j.tokenRaw!) });
    }
    if (px !== undefined) out.push({ t: r.t_ms, px });
  }
  return out;
}

export interface ScoredFire {
  fireId: number;
  type: string;
  venue?: string;
  token?: string;
  symbol?: string;
  direction: Direction;
  detectLagMs: number;
  horizonSec: number;
  status: 'filled' | 'pending' | 'no_fill' | 'no_price';
  fill?: PaperFill;
}

/** Score every fire in the window at every horizon. */
export function scoreFires(store: Store, o: ScorecardOpts): ScoredFire[] {
  const db = store.db;
  const fires = db
    .prepare(
      `SELECT id, type, venue, token, symbol, pool, direction, pool_fee, pool_usdc_depth, fired_ms, detect_lag_ms
       FROM signal_fires WHERE chain_id = ? AND fired_ms >= ? ORDER BY fired_ms`,
    )
    .all(o.chainId, o.sinceMs) as unknown as FireRow[];
  const maxH = Math.max(...o.horizonsSec) * 1000;
  const out: ScoredFire[] = [];
  for (const f of fires) {
    const meta = f.pool ? store.getPoolMeta(o.chainId, f.pool) : undefined;
    const series = f.pool ? loadPriceSeries(db, o.chainId, f.pool, meta, f.fired_ms, f.fired_ms + maxH) : [];
    const cost = roundTripCost({
      feePpm: f.pool_fee ?? meta?.fee ?? undefined,
      dex: meta?.dex,
      sizeUsd: o.sizeUsd,
      depthUsd: f.pool_usdc_depth ?? meta?.usdc_depth ?? undefined,
    });
    for (const h of o.horizonsSec) {
      const base = {
        fireId: f.id,
        type: f.type,
        venue: f.venue ?? undefined,
        token: f.token ?? undefined,
        symbol: f.symbol ?? undefined,
        direction: f.direction,
        detectLagMs: f.detect_lag_ms,
        horizonSec: h,
      };
      if (!f.pool) {
        out.push({ ...base, status: 'no_price' });
        continue;
      }
      const r = paperFill(series, { firedMs: f.fired_ms, latencyMs: o.latencyMs, horizonMs: h * 1000, direction: f.direction, cost, dataEndMs: o.dataEndMs });
      out.push(r.status === 'filled' ? { ...base, status: 'filled', fill: r.fill } : { ...base, status: r.status });
    }
  }
  return out;
}

export interface ScorecardRow {
  group: 'type' | 'pad' | 'token';
  type: string;
  key: string;
  horizonSec: number;
  fires: number;
  filled: number;
  pending: number;
  /** fills with a known cost (net return defined) */
  netN: number;
  hitRate?: number;
  meanNet?: number;
  medianNet?: number;
  meanGross?: number;
  avgDetectLagMs?: number;
  avgDrawdownAvoided?: number;
}

export interface GateRow {
  type: string;
  horizonSec: number;
  n: number;
  hitRate?: number;
  meanNet?: number;
  verdict: PromotionVerdict;
  reasons: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

export function aggregate(scored: ScoredFire[], gateHorizonSec: number): { rows: ScorecardRow[]; gate: GateRow[] } {
  const buckets = new Map<string, { group: ScorecardRow['group']; type: string; key: string; horizonSec: number; items: ScoredFire[] }>();
  const put = (group: ScorecardRow['group'], key: string, s: ScoredFire) => {
    const k = `${group}|${s.type}|${key}|${s.horizonSec}`;
    const b = buckets.get(k) ?? { group, type: s.type, key, horizonSec: s.horizonSec, items: [] };
    b.items.push(s);
    buckets.set(k, b);
  };
  for (const s of scored) {
    put('type', s.type, s);
    put('pad', s.venue ?? '(none)', s);
    put('token', s.symbol ?? s.token ?? '(none)', s);
  }
  const rows: ScorecardRow[] = [];
  for (const b of buckets.values()) {
    const filled = b.items.filter((i) => i.status === 'filled');
    const nets = filled.map((i) => i.fill!.net).filter((x): x is number => x !== undefined);
    const st = returnStats(nets);
    const dd = filled.map((i) => i.fill!.drawdownAvoided).filter((x): x is number => x !== undefined);
    rows.push({
      group: b.group,
      type: b.type,
      key: b.key,
      horizonSec: b.horizonSec,
      fires: b.items.length,
      filled: filled.length,
      pending: b.items.filter((i) => i.status === 'pending').length,
      netN: st.n,
      hitRate: st.hitRate,
      meanNet: st.mean,
      medianNet: st.median,
      meanGross: mean(filled.map((i) => i.fill!.gross)),
      avgDetectLagMs: mean(b.items.map((i) => i.detectLagMs)),
      avgDrawdownAvoided: mean(dd),
    });
  }
  const order = { type: 0, pad: 1, token: 2 } as const;
  rows.sort((a, b) => order[a.group] - order[b.group] || a.type.localeCompare(b.type) || a.key.localeCompare(b.key) || a.horizonSec - b.horizonSec);
  const gate = rows
    .filter((r) => r.group === 'type' && r.horizonSec === gateHorizonSec)
    .map((r) => {
      const v = promotionVerdict({ n: r.netN, hitRate: r.hitRate, mean: r.meanNet });
      return { type: r.type, horizonSec: r.horizonSec, n: r.netN, hitRate: r.hitRate, meanNet: r.meanNet, ...v };
    });
  return { rows, gate };
}

export function buildScorecard(store: Store, o: ScorecardOpts) {
  store.ensureScorecardIndexes();
  const scored = scoreFires(store, o);
  return { fires: new Set(scored.map((s) => s.fireId)).size, ...aggregate(scored, o.gateHorizonSec) };
}

/** Latest stored event time for a chain (anchors --days and horizon completeness on DB copies). */
export function dataEndMs(db: DatabaseSync, chainId: number): number | undefined {
  const r = db.prepare('SELECT MAX(t_ms) m FROM events WHERE chain_id = ?').get(chainId) as { m: number | null };
  return r.m ?? undefined;
}

/** Chain to report on: the configured one if it has data, else the only chain present in the DB. */
export function pickChain(db: DatabaseSync, configured: number): { chainId: number; note?: string } {
  const has = (db.prepare('SELECT 1 FROM events WHERE chain_id = ? LIMIT 1').get(configured) ?? db.prepare('SELECT 1 FROM signal_fires WHERE chain_id = ? LIMIT 1').get(configured)) !== undefined;
  if (has) return { chainId: configured };
  const chains = db.prepare('SELECT DISTINCT chain_id c FROM events').all() as { c: number }[];
  if (chains.length === 1) return { chainId: chains[0]!.c, note: `configured chain ${configured} has no data; using the only chain in the DB (${chains[0]!.c})` };
  return { chainId: configured };
}

const pct = (v: number | undefined, d = 1) => (v === undefined ? 'n/a' : `${(v * 100).toFixed(d)}%`);

export function formatScorecard(sc: ReturnType<typeof buildScorecard>, o: ScorecardOpts): string {
  const lines: string[] = [];
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  lines.push(`edge scorecard — chain ${o.chainId}, fires since ${iso(o.sinceMs)} UTC, data to ${iso(o.dataEndMs)} UTC`);
  lines.push(`paper: entry = first print ≥ fire+${o.latencyMs}ms · exit = last print ≤ fire+horizon · cost = 2×fee + $${o.sizeUsd}/(2×USDC depth)`);
  lines.push(`${sc.fires} scored fires`);
  if (!sc.fires) {
    lines.push('no signal_fires in window (the live bot records them from this build on).');
    return lines.join('\n');
  }
  const header = `${'group'.padEnd(6)} ${'type'.padEnd(22)} ${'key'.padEnd(24)} ${'h'.padStart(4)} ${'fires'.padStart(5)} ${'filled'.padStart(6)} ${'pend'.padStart(4)} ${'netN'.padStart(4)} ${'hit%'.padStart(6)} ${'meanNet'.padStart(8)} ${'medNet'.padStart(8)} ${'gross'.padStart(8)} ${'lag_s'.padStart(6)} ${'ddAvoid'.padStart(7)}`;
  lines.push(header);
  for (const r of sc.rows) {
    const h = r.horizonSec >= 3600 ? `${r.horizonSec / 3600}h` : `${r.horizonSec / 60}m`;
    lines.push(
      `${r.group.padEnd(6)} ${r.type.padEnd(22)} ${r.key.slice(0, 24).padEnd(24)} ${h.padStart(4)} ${String(r.fires).padStart(5)} ${String(r.filled).padStart(6)} ${String(r.pending).padStart(4)} ${String(r.netN).padStart(4)} ${pct(r.hitRate).padStart(6)} ${pct(r.meanNet, 2).padStart(8)} ${pct(r.medianNet, 2).padStart(8)} ${pct(r.meanGross, 2).padStart(8)} ${(r.avgDetectLagMs === undefined ? 'n/a' : (r.avgDetectLagMs / 1000).toFixed(1)).padStart(6)} ${pct(r.avgDrawdownAvoided).padStart(7)}`,
    );
  }
  lines.push('');
  lines.push(`promotion gate @${o.gateHorizonSec / 60}m (7d n>=30, net hit>=55%, mean net>0) — REPORT ONLY, not wired to pings:`);
  for (const g of sc.gate) lines.push(`  ${g.type.padEnd(22)} n=${String(g.n).padStart(4)} hit=${pct(g.hitRate).padStart(6)} mean=${pct(g.meanNet, 2).padStart(8)}  ${g.verdict.toUpperCase()}${g.reasons.length ? ` (${g.reasons.join('; ')})` : ''}`);
  return lines.join('\n');
}
