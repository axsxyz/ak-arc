/**
 * npm run calibrate -- --rule MAJOR_ANOMALY|LP_SURGE|NEW_LAUNCH [--grid z=3,4,5 --grid pct=50,100] [--db PATH] [--days N]
 *                      [--rpc URL] [--rps 4] [--no-rpc] [--latency-ms 3000] [--size-usd 500] [--chain-id 5042]
 * Replays stored events through the real rule functions over a threshold grid and prints paper precision@5m/15m
 * net of costs. Writes only the pool_meta cache (and an events index). Point --db at a COPY when the bot is running.
 * Grid defaults to the thresholds from env/profile (e.g. ARC_PROFILE=mainnet-poll).
 */
import '../config/load-env.js'; // must stay first
import path from 'node:path';
import { loadConfig } from '../config/env.js';
import { NETWORKS } from '../config/networks.js';
import { loadWatchlists } from '../config/watchlists.js';
import type { Dex } from '../decode/types.js';
import {
  anomalyParams,
  fillDepths,
  GRID_KEYS,
  loadEvents,
  loadMetaMap,
  lpThresholds,
  majorSourcePools,
  parseGrid,
  priceSeriesByPool,
  replayLpSurge,
  replayMajorAnomaly,
  replayNewLaunch,
  resolveMissingMeta,
  scoreReplayFires,
  seedMetaFromEvents,
  type CalibRule,
  type GridResult,
  type ReplayFire,
} from '../jobs/calibrate.js';
import { dataEndMs, pickChain } from '../jobs/scorecard.js';
import { RpcChainReader } from '../rpc/clients.js';
import { Store } from '../store/sqlite.js';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const args = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));
const flag = (name: string) => argv.includes(`--${name}`);

const rule = (arg('rule') ?? '').toUpperCase() as CalibRule;
if (!(rule in GRID_KEYS)) {
  console.error(`--rule must be one of ${Object.keys(GRID_KEYS).join(', ')}`);
  process.exit(2);
}

const cfg = loadConfig(process.env);
const store = new Store(arg('db') ? path.resolve(arg('db')!) : cfg.dbPath);
store.ensureScorecardIndexes();
const picked = arg('chain-id') ? { chainId: Number(arg('chain-id')) } : pickChain(store.db, cfg.network.chainId);
if ('note' in picked && picked.note) console.log(`note: ${picked.note}`);
const chainId = picked.chainId;
const found = Object.values(NETWORKS).find((n) => n.chainId === chainId);
if (!found) {
  console.error(`unknown chain ${chainId}`);
  process.exit(2);
}
const net = found;
const w = loadWatchlists(cfg.watchlistDir, net.name);
const lastEventMs = dataEndMs(store.db, chainId);
if (lastEventMs === undefined) {
  console.log(`no events for chain ${chainId} in the DB`);
  process.exit(0);
}
const end: number = lastEventMs;
const days = arg('days') ? Number(arg('days')) : undefined;
const fromMs = days ? end - days * 86_400_000 : 0;
const grid = parseGrid(rule, args('grid'));
const latencyMs = Number(arg('latency-ms') ?? cfg.paper.latencyMs);
const sizeUsd = Number(arg('size-usd') ?? cfg.paper.sizeUsd);
const horizonsSec = [300, 900];
const usdc = net.usdcMirror;

async function main() {
  const t0 = Date.now();
  const seeded = seedMetaFromEvents(store, chainId, w, usdc, Date.now());
  const kinds = rule === 'LP_SURGE' ? ['mint', 'burn', 'swap', 'pad_trade'] : rule === 'NEW_LAUNCH' ? ['pad_token_created', 'swap', 'pad_trade'] : ['swap', 'pad_trade'];
  const events = loadEvents(store, chainId, kinds, fromMs, end);
  const span = events.length ? `${new Date(events[0]!.t).toISOString().slice(0, 16)} → ${new Date(end).toISOString().slice(0, 16)} UTC` : 'empty';
  console.log(`calibrate ${rule} — chain ${chainId}, ${events.length} events (${span}), pool_meta seeded from ${seeded} PoolCreated logs`);

  // Pools whose metadata the rule needs (all pools with swaps/liquidity; launch pools for NEW_LAUNCH).
  const need = new Map<string, Dex>();
  for (const e of events) if (e.kind === 'swap' || e.kind === 'mint' || e.kind === 'burn') need.set(e.emitter, (e.j.dex as Dex) ?? 'univ3');
  const rpcUrl = arg('rpc') ?? (net.name === 'mainnet' ? process.env.ARC_MAINNET_HTTP_URL : process.env.ARC_TESTNET_HTTP_URL) ?? cfg.httpUrl;
  let reader: RpcChainReader | undefined;
  if (!flag('no-rpc') && rpcUrl) {
    reader = new RpcChainReader(rpcUrl, Number(arg('rps') ?? 4), { attempts: 7, baseMs: 1000 });
    const id = await reader.chainId();
    if (id !== chainId) {
      console.error(`RPC ${new URL(rpcUrl).host} is chain ${id}, DB is chain ${chainId} — refusing to mix chains`);
      process.exit(2);
    }
    const pools = [...need].map(([pool, dex]) => ({ pool, dex }));
    let last = 0;
    const r = await resolveMissingMeta(store, chainId, reader, pools, w, usdc, (done, total) => {
      if (done - last >= 80 || done === total) {
        last = done;
        console.log(`  pool_meta via ${new URL(rpcUrl).host}: ${done}/${total}`);
      }
    });
    if (r.resolved || r.failed) console.log(`  resolved ${r.resolved} pools${r.failed ? `, ${r.failed} failed (not cached; re-run resumes)` : ''}`);
  } else {
    console.log('  --no-rpc: using cached pool_meta only (unresolved pools are skipped)');
  }

  let meta = loadMetaMap(store, chainId);
  const majors = new Map(w.majors.map((m) => [m.address.toLowerCase(), m.symbol]));
  if (rule === 'MAJOR_ANOMALY' && reader) {
    const majorPools = [...meta.values()].filter((m) => m.usdc_side !== null && m.trusted && majors.has((m.usdc_side === 0 ? m.token1 : m.token0) ?? '')).map((m) => m.pool);
    await fillDepths(store, chainId, reader, majorPools, usdc);
    meta = loadMetaMap(store, chainId);
  }
  const series = priceSeriesByPool(events, meta);
  const sources = majorSourcePools(meta, majors, cfg.majorPriceMinLpUsd);

  const runs: { params: Record<string, number>; fires: ReplayFire[] }[] = grid.map((g) => ({
    params: g,
    fires:
      rule === 'MAJOR_ANOMALY'
        ? replayMajorAnomaly(events, meta, majors, sources, anomalyParams(cfg.thresholds, g))
        : rule === 'LP_SURGE'
          ? replayLpSurge(events, meta, lpThresholds(cfg.thresholds, g))
          : replayNewLaunch(events, w, meta),
  }));
  if (reader) {
    await fillDepths(store, chainId, reader, runs.flatMap((r) => r.fires.map((f) => f.pool)), usdc);
    meta = loadMetaMap(store, chainId);
  }
  const results: GridResult[] = runs.map((r) =>
    scoreReplayFires(r.fires, series, meta, { latencyMs, sizeUsd, horizonsSec, dataEndMs: end, gateHorizonSec: 900 }, r.params),
  );

  const pct = (v: number | undefined, d = 1) => (v === undefined ? 'n/a' : `${(v * 100).toFixed(d)}%`);
  console.log(`paper: entry = first print ≥ fire(block time)+${latencyMs}ms · cost = 2×fee + $${sizeUsd}/(2×USDC depth now) · long`);
  if (rule === 'MAJOR_ANOMALY') {
    const th = cfg.thresholds;
    console.log(`defaults: z=${th.anomalyZ} pct=${th.anomalyPct} minvol=${th.anomalyMinVolUsd} samples=${th.anomalyMinSamples} cooldown=${th.anomalyCooldownSec}s · source pools: ${[...sources].map(([t, p]) => `${majors.get(t)}=${p.slice(0, 10)}`).join(' ') || 'none'}`);
  } else if (rule === 'LP_SURGE') {
    console.log(`defaults: lp=${cfg.thresholds.lpUsd} watch=${cfg.thresholds.lpWatchUsd} window=${cfg.thresholds.lpWindowSec}s dedupe=${cfg.thresholds.dedupeSec}s`);
  }
  console.log(`${'params'.padEnd(34)} ${'fires'.padStart(5)} ${'trust'.padStart(5)} | ${'@5m n'.padStart(6)} ${'hit'.padStart(6)} ${'mean'.padStart(8)} | ${'@15m n'.padStart(6)} ${'hit'.padStart(6)} ${'mean'.padStart(8)} ${'median'.padStart(8)} ${'gross'.padStart(8)} | gate@15m`);
  for (const r of results) {
    const [h5, h15] = [r.byHorizon.find((b) => b.horizonSec === 300)!, r.byHorizon.find((b) => b.horizonSec === 900)!];
    const p = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ') || '(env defaults)';
    console.log(
      `${p.padEnd(34)} ${String(r.fires).padStart(5)} ${String(r.trustedFires).padStart(5)} | ${String(h5.netN).padStart(6)} ${pct(h5.hitRate).padStart(6)} ${pct(h5.mean, 2).padStart(8)} | ${String(h15.netN).padStart(6)} ${pct(h15.hitRate).padStart(6)} ${pct(h15.mean, 2).padStart(8)} ${pct(h15.median, 2).padStart(8)} ${pct(h15.meanGross, 2).padStart(8)} | ${r.verdict.toUpperCase()}${r.verdictReasons.length ? ` (${r.verdictReasons.join('; ')})` : ''}`,
    );
  }
  const spanDays = events.length ? (end - events[0]!.t) / 86_400_000 : 0;
  if (spanDays < 7) console.log(`note: data spans ${spanDays.toFixed(1)}d (< 7d promotion window) — verdicts are indicative only.`);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  store.close();
}

main().catch((e) => {
  console.error(String((e as Error).stack ?? e));
  process.exit(1);
});
