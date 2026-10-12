/**
 * backtest-24h — ONE-SHOT, THROWAWAY. Not part of the harness, not imported
 * by anything else. Delete it whenever.
 *
 *   npx tsx src/tools/backtest-24h.ts [--db PATH] [--hours 24] [--limit N] [--rps 4] [--no-rpc] [--json OUT]
 *
 * For every pad-launched token in the last `--hours` (anchored at the DB's
 * own newest event, same convention as calibrate.ts/scorecard.ts so a copy
 * works): price + pool-depth trajectory at t0/+5m/+15m/+1h/+6h/max, unique
 * buyers and buy/sell $ ratio (cumulative to each checkpoint), holder count
 * + top10% concentration (ex LP/burn/venues), time to first BRIDGE_DEPLOY,
 * and which signals fired. Everything is reconstructed from the stored
 * `events` table (swap/mint/burn/transfer/pad_trade) — no historical RPC
 * reads. The only RPC call is one `erc20Meta` per token (decimals +
 * totalSupply), skippable with --no-rpc (assumes 18 decimals, no top10%).
 *
 * Then: a runners(>=2x)-vs-duds distribution comparison per feature (no
 * fitted model — just the numbers side by side), and an LP_SURGE threshold
 * replay (reusing the real evaluateLp rule via calibrate.ts's RollingEvents
 * path) against the SAME token population, showing catch/leak counts per
 * candidate threshold.
 *
 * Read-only. Point --db at a COPY if the bot is running (same rule as
 * calibrate.ts).
 */
import '../config/load-env.js';
import { loadConfig } from '../config/env.js';
import { NETWORKS } from '../config/networks.js';
import { loadWatchlists, type Watchlists } from '../config/watchlists.js';
import type { Dex } from '../decode/types.js';
import { HolderTracker } from '../features/holders.js';
import { RollingEvents } from '../features/volume.js';
import { v3TokenPriceUsd, reservesPriceUsd } from '../math/price.js';
import { toNumber, USDC_ERC20_DECIMALS } from '../math/units.js';
import { curvePriceRaw, swapPriceRaw } from '../score/paper.js';
import { evaluateLp } from '../score/rules/lp.js';
import { RpcChainReader } from '../rpc/clients.js';
import type { ChainReader } from '../rpc/reader.js';
import { dataEndMs, pickChain } from '../jobs/scorecard.js';
import { ammFactories, launchers, loadEvents, type StoredEvent } from '../jobs/calibrate.js';
import { Store } from '../store/sqlite.js';
import fs from 'node:fs';

// ── cli ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);

const cfg = loadConfig(process.env);
const store = new Store(arg('db') ? arg('db')! : cfg.dbPath);
const picked = arg('chain-id') ? { chainId: Number(arg('chain-id')) } : pickChain(store.db, cfg.network.chainId);
if ('note' in picked && picked.note) console.log(`note: ${picked.note}`);
const chainId = picked.chainId;
const net = Object.values(NETWORKS).find((n) => n.chainId === chainId);
if (!net) {
  console.error(`unknown chain ${chainId}`);
  process.exit(2);
}
const w = loadWatchlists(cfg.watchlistDir, net.name);
const usdc = net.usdcMirror.toLowerCase();
const _end = dataEndMs(store.db, chainId);
if (_end === undefined) {
  console.log(`no events for chain ${chainId} in the DB`);
  process.exit(0);
}
// A plain `number` (not a narrowed union) so closures defined below see the narrowing too.
const end: number = _end;
const hours = Number(arg('hours') ?? 24);
const start = end - hours * 3600_000;
const limit = arg('limit') ? Number(arg('limit')) : undefined;
const noRpc = flag('no-rpc');
const jsonOut = arg('json');

// checkpoint offsets from a token's t0 (pool/curve birth)
const CHECKPOINTS = [
  { key: 't0', ms: 0 },
  { key: '+5m', ms: 5 * 60_000 },
  { key: '+15m', ms: 15 * 60_000 },
  { key: '+1h', ms: 60 * 60_000 },
  { key: '+6h', ms: 6 * 3600_000 },
] as const;
type CpKey = (typeof CHECKPOINTS)[number]['key'] | 'max';

const DEAD = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
function venueContracts(w: Watchlists): Set<string> {
  const out = new Set<string>();
  for (const v of [...w.pads, ...w.dex]) {
    for (const f of v.factories) out.add(f.address.toLowerCase());
    for (const r of v.routers) out.add(r.toLowerCase());
    for (const a of Object.values(v.aux)) out.add((a as string).toLowerCase());
  }
  return out;
}
const VENUE = venueContracts(w);

// ── token universe: every pad_token_created in the window ─────────────────
interface Launch {
  token: string;
  symbol: string;
  adapter: string;
  creator: string;
  t0: number;
  block: number;
  pool?: string; // AMM-launched (Lift/Tolly/RadarDEX)
  curve?: string; // bonding-curve launched (Warp)
  venueAddr: string; // pool ?? curve — what emits trades
  authorized: boolean; // would NEW_LAUNCH have recognized this launcher
  initialBuyUsd?: number;
}

const launchRows = store.db
  .prepare(`SELECT id, t_ms, block, emitter, json FROM events WHERE chain_id = ? AND kind = 'pad_token_created' AND t_ms >= ? AND t_ms <= ? ORDER BY t_ms`)
  .all(chainId, start, end) as { id: string; t_ms: number; block: number; emitter: string; json: string }[];

const ls = launchers(w);
let launches: Launch[] = launchRows.map((r) => {
  const j = JSON.parse(r.json) as { adapter: string; token: string; creator: string; pool?: string; curve?: string; symbol: string; initialBuyQuoteRaw?: string; quote?: string };
  const l = ls.get(r.emitter.toLowerCase());
  const venueAddr = (j.pool ?? j.curve ?? '').toLowerCase();
  return {
    token: j.token.toLowerCase(),
    symbol: j.symbol || '?',
    adapter: j.adapter,
    creator: j.creator.toLowerCase(),
    t0: r.t_ms,
    block: r.block,
    pool: j.pool?.toLowerCase(),
    curve: j.curve?.toLowerCase(),
    venueAddr,
    authorized: Boolean(l && l.kind === j.adapter),
    initialBuyUsd: j.initialBuyQuoteRaw !== undefined ? toNumber(BigInt(j.initialBuyQuoteRaw), j.quote?.toLowerCase() === usdc ? 6 : 18) : undefined,
  };
});
// de-dupe by token (a token should only launch once; keep the first)
{
  const seen = new Set<string>();
  launches = launches.filter((l) => (seen.has(l.token) ? false : (seen.add(l.token), true)));
}
if (limit) launches = launches.slice(0, limit);

console.log(`backtest-24h — chain ${chainId}, window ${new Date(start).toISOString()} -> ${new Date(end).toISOString()} (${hours}h, anchored at newest stored event)`);
console.log(`${launches.length} pad-launched token(s) (${launches.filter((l) => l.authorized).length} from an allowlisted launcher, i.e. would-fire NEW_LAUNCH)`);
if (!launches.length) {
  store.close();
  process.exit(0);
}

// ── pull every event this analysis needs, once, for the whole universe ────
const venueAddrs = new Set(launches.map((l) => l.venueAddr).filter(Boolean));
const tokenAddrs = new Set(launches.map((l) => l.token));
const poolLikeKinds = ['swap', 'mint', 'burn', 'sync', 'pad_trade'];
const tradeEvents = loadEvents(store, chainId, poolLikeKinds, start, end + 6 * 3600_000).filter((e) => venueAddrs.has(e.emitter));
const transferEvents = loadEvents(store, chainId, ['transfer'], start, end + 6 * 3600_000).filter((e) => tokenAddrs.has(e.emitter));
console.log(`loaded ${tradeEvents.length} trade-side event(s), ${transferEvents.length} transfer event(s) for this universe`);

const tradeByVenue = new Map<string, StoredEvent[]>();
for (const e of tradeEvents) {
  const a = tradeByVenue.get(e.emitter) ?? [];
  a.push(e);
  tradeByVenue.set(e.emitter, a);
}
const transferByToken = new Map<string, StoredEvent[]>();
for (const e of transferEvents) {
  const a = transferByToken.get(e.emitter) ?? [];
  a.push(e);
  transferByToken.set(e.emitter, a);
}

// signal_fires per token, in-window or shortly after (bridge-deploy / anomaly can land later than the launch itself)
const fireRows = store.db
  .prepare(`SELECT type, token, pool, fired_ms FROM signal_fires WHERE chain_id = ? AND fired_ms >= ? AND fired_ms <= ? AND token IS NOT NULL`)
  .all(chainId, start, end + 6 * 3600_000) as { type: string; token: string; pool: string | null; fired_ms: number }[];
const firesByToken = new Map<string, { type: string; fired_ms: number }[]>();
for (const r of fireRows) {
  const a = firesByToken.get(r.token.toLowerCase()) ?? [];
  a.push({ type: r.type, fired_ms: r.fired_ms });
  firesByToken.set(r.token.toLowerCase(), a);
}

// ── usdc side, deterministically (factory token0/token1 sort order) ───────
function usdcSideOf(token: string): 0 | 1 {
  return usdc < token ? 0 : 1;
}

// ── RPC: one erc20Meta call per token (decimals + totalSupply), batched ───
const decimalsOf = new Map<string, number>();
const totalSupplyOf = new Map<string, bigint>();
async function resolveErc20Meta() {
  if (noRpc) {
    console.log('--no-rpc: assuming 18 decimals for every token; top10% will be n/a');
    return;
  }
  const rpcUrl = arg('rpc') ?? (net!.name === 'mainnet' ? process.env.ARC_MAINNET_HTTP_URL : process.env.ARC_TESTNET_HTTP_URL) ?? cfg.httpUrl;
  if (!rpcUrl) {
    console.log('no RPC URL configured; assuming 18 decimals, top10% will be n/a');
    return;
  }
  const reader: ChainReader = new RpcChainReader(rpcUrl, Number(arg('rps') ?? 4), { attempts: 5, baseMs: 500 });
  const id = await reader.chainId();
  if (id !== chainId) {
    console.error(`RPC ${new URL(rpcUrl).host} is chain ${id}, DB is chain ${chainId} — refusing to mix chains`);
    process.exit(2);
  }
  const tokens = [...tokenAddrs];
  const BATCH = 16;
  let done = 0;
  for (let i = 0; i < tokens.length; i += BATCH) {
    await Promise.all(
      tokens.slice(i, i + BATCH).map(async (t) => {
        const m = await reader.erc20Meta(t as `0x${string}`);
        if (m.decimals !== undefined) decimalsOf.set(t, m.decimals);
        if (m.totalSupply !== undefined) totalSupplyOf.set(t, m.totalSupply);
      }),
    );
    done = Math.min(i + BATCH, tokens.length);
    if (done % 80 === 0 || done === tokens.length) console.log(`  erc20Meta via ${new URL(rpcUrl).host}: ${done}/${tokens.length}`);
  }
}

// ── price + depth trajectory, event-sourced (no RPC) ───────────────────────
interface PricePt {
  t: number;
  px: number; // $ per token
}
interface TradeSide {
  t: number;
  usdcDelta: number; // signed, pool's perspective — depth accumulator
  isBuy: boolean; // trader's perspective
  usd: number; // trade size, unsigned
  trader: string;
}

function buildSeries(l: Launch): { prices: PricePt[]; sides: TradeSide[] } {
  const events = (tradeByVenue.get(l.venueAddr) ?? []).slice().sort((a, b) => a.t - b.t || a.block - b.block || a.li - b.li);
  const dec = decimalsOf.get(l.token) ?? 18;
  const side = usdcSideOf(l.token);
  const prices: PricePt[] = [];
  const sides: TradeSide[] = [];
  for (const e of events) {
    if (l.pool) {
      if (e.kind === 'swap') {
        const a0 = BigInt(e.j.amount0 as string);
        const a1 = BigInt(e.j.amount1 as string);
        const sqrtP = e.j.sqrtPriceX96 ? BigInt(e.j.sqrtPriceX96 as string) : undefined;
        const [d0, d1] = side === 0 ? [USDC_ERC20_DECIMALS, dec] : [dec, USDC_ERC20_DECIMALS];
        const px = sqrtP ? v3TokenPriceUsd(sqrtP, d0, d1, side === 0) : undefined;
        const raw = swapPriceRaw({ amount0: a0, amount1: a1, sqrtPriceX96: sqrtP }, side);
        const px2 = px ?? (raw !== undefined ? (side === 0 ? raw / 10 ** (USDC_ERC20_DECIMALS - dec) : raw / 10 ** (dec - USDC_ERC20_DECIMALS)) : undefined);
        if (px2 !== undefined && Number.isFinite(px2) && px2 > 0) prices.push({ t: e.t, px: px2 });
        const usdcRaw = side === 0 ? a0 : a1;
        const usdcDelta = toNumber(usdcRaw, USDC_ERC20_DECIMALS);
        sides.push({ t: e.t, usdcDelta, isBuy: usdcRaw > 0n, usd: Math.abs(usdcDelta), trader: (e.j.recipient as string) ?? (e.j.sender as string) ?? '?' });
      } else if (e.kind === 'sync') {
        const r0 = BigInt(e.j.reserve0 as string);
        const r1 = BigInt(e.j.reserve1 as string);
        const [usdcR, tokR] = side === 0 ? [r0, r1] : [r1, r0];
        const px = reservesPriceUsd(tokR, dec, usdcR, USDC_ERC20_DECIMALS);
        if (px !== undefined && px > 0) prices.push({ t: e.t, px });
      } else if (e.kind === 'mint' || e.kind === 'burn') {
        const a0 = BigInt(e.j.amount0 as string);
        const a1 = BigInt(e.j.amount1 as string);
        const usdcRaw = side === 0 ? a0 : a1; // always >= 0 per LiquidityEv
        const usdc = toNumber(usdcRaw, USDC_ERC20_DECIMALS);
        sides.push({ t: e.t, usdcDelta: e.kind === 'mint' ? usdc : -usdc, isBuy: e.kind === 'mint', usd: usdc, trader: (e.j.owner as string) ?? '?' });
      }
    } else if (l.curve) {
      if (e.kind === 'pad_trade') {
        const quoteRaw = BigInt(e.j.quoteRaw as string);
        const tokenRaw = BigInt(e.j.tokenRaw as string);
        const raw = curvePriceRaw({ quoteRaw, tokenRaw }); // quote/token, quote is native 18-dec USDC
        if (raw !== undefined) {
          const px = raw / 10 ** (18 - dec);
          if (px > 0 && Number.isFinite(px)) prices.push({ t: e.t, px });
        }
        const isBuy = Boolean(e.j.isBuy);
        const usd = toNumber(quoteRaw, 18);
        sides.push({ t: e.t, usdcDelta: isBuy ? usd : -usd, isBuy, usd, trader: (e.j.trader as string) ?? '?' });
      }
    }
  }
  return { prices, sides };
}

/** Last value at/before `t`, or undefined. */
function lastAtOrBefore<T extends { t: number }>(series: T[], t: number): T | undefined {
  let best: T | undefined;
  for (const p of series) {
    if (p.t > t) break;
    best = p;
  }
  return best;
}

// ── holders trajectory ──────────────────────────────────────────────────
function holderTrackerFor(l: Launch): HolderTracker {
  const tr = new HolderTracker();
  tr.beginBackfill(BigInt(l.block), BigInt(l.block));
  return tr;
}

function holdersAt(l: Launch, t: number, cache: { tr: HolderTracker; applied: number }): { count?: number; top10?: number } {
  const events = (transferByToken.get(l.token) ?? []).slice().sort((a, b) => a.block - b.block || a.li - b.li);
  let i = cache.applied;
  const toBlock: { block: number }[] = [];
  while (i < events.length && events[i]!.t <= t) {
    toBlock.push(events[i]!);
    i += 1;
  }
  if (toBlock.length) {
    cache.tr.applyRange(
      toBlock.map((e) => ({ id: `${(e as StoredEvent).kind}`, block: BigInt((e as StoredEvent).block), from: (e as StoredEvent).j.from as `0x${string}`, to: (e as StoredEvent).j.to as `0x${string}`, value: BigInt((e as StoredEvent).j.value as string) })),
      BigInt((events[i - 1] as StoredEvent | undefined)?.block ?? l.block),
    );
  }
  cache.applied = i;
  const supply = totalSupplyOf.get(l.token);
  cache.tr.markSinceBirth(supply);
  if (!cache.tr.sinceBirth) return {};
  const exclude = new Set<string>([...DEAD, l.token, ...(l.pool ? [l.pool] : []), ...(l.curve ? [l.curve] : []), ...VENUE]);
  return { count: cache.tr.holderCount(), top10: cache.tr.top10Share(supply, exclude) };
}

// ── per-token row ────────────────────────────────────────────────────────
interface Row {
  l: Launch;
  price: Partial<Record<CpKey, number>>;
  depth: Partial<Record<CpKey, number>>;
  buyers: Partial<Record<CpKey, number>>;
  buySellRatio: Partial<Record<CpKey, number>>;
  holders: Partial<Record<CpKey, number>>;
  top10: Partial<Record<CpKey, number>>;
  maxReturn?: number;
  bridgeDeployMinAfterT0?: number;
  fires: { type: string; minAfterT0: number }[];
}

function buildRow(l: Launch): Row {
  const { prices, sides } = buildSeries(l);
  prices.sort((a, b) => a.t - b.t);
  const price: Row['price'] = {};
  const depth: Row['depth'] = {};
  const buyers: Row['buyers'] = {};
  const buySellRatio: Row['buySellRatio'] = {};

  let runningDepth = 0;
  const depthSeries: PricePt[] = [];
  for (const s of sides) {
    runningDepth += s.usdcDelta;
    depthSeries.push({ t: s.t, px: runningDepth });
  }

  let maxPx: number | undefined;
  for (const cp of CHECKPOINTS) {
    const t = l.t0 + cp.ms;
    if (t > end) continue; // pending: data doesn't reach this checkpoint yet
    const p = lastAtOrBefore(prices, t);
    if (p) price[cp.key] = p.px;
    const d = lastAtOrBefore(depthSeries, t);
    if (d) depth[cp.key] = Math.max(0, d.px);

    const uniq = new Set<string>();
    let buyUsd = 0;
    let sellUsd = 0;
    for (const s of sides) {
      if (s.t > t) break;
      uniq.add(s.trader.toLowerCase());
      if (s.isBuy) buyUsd += s.usd;
      else sellUsd += s.usd;
    }
    buyers[cp.key] = uniq.size;
    buySellRatio[cp.key] = sellUsd > 0 ? buyUsd / sellUsd : buyUsd > 0 ? Infinity : NaN;
  }
  for (const p of prices) if (maxPx === undefined || p.px > maxPx) maxPx = p.px;
  if (maxPx !== undefined) price.max = maxPx;
  const maxDepth = depthSeries.reduce((a, p) => Math.max(a, p.px), 0);
  if (depthSeries.length) depth.max = maxDepth;
  {
    const uniq = new Set(sides.map((s) => s.trader.toLowerCase()));
    buyers.max = uniq.size;
    const buyUsd = sides.filter((s) => s.isBuy).reduce((a, s) => a + s.usd, 0);
    const sellUsd = sides.filter((s) => !s.isBuy).reduce((a, s) => a + s.usd, 0);
    buySellRatio.max = sellUsd > 0 ? buyUsd / sellUsd : buyUsd > 0 ? Infinity : NaN;
  }

  const entry = prices[0]?.px;
  const maxReturn = entry !== undefined && entry > 0 && maxPx !== undefined ? maxPx / entry : undefined;

  const fires = (firesByToken.get(l.token) ?? []).sort((a, b) => a.fired_ms - b.fired_ms);
  const bd = fires.find((f) => f.type === 'BRIDGE_DEPLOY');

  const holders: Row['holders'] = {};
  const top10: Row['top10'] = {};
  const cache = { tr: holderTrackerFor(l), applied: 0 };
  for (const cp of CHECKPOINTS) {
    const t = l.t0 + cp.ms;
    if (t > end) continue;
    const h = holdersAt(l, t, cache);
    if (h.count !== undefined) holders[cp.key] = h.count;
    if (h.top10 !== undefined) top10[cp.key] = h.top10;
  }
  {
    const h = holdersAt(l, end, cache);
    if (h.count !== undefined) holders.max = h.count;
    if (h.top10 !== undefined) top10.max = h.top10;
  }

  return {
    l,
    price,
    depth,
    buyers,
    buySellRatio,
    holders,
    top10,
    maxReturn,
    bridgeDeployMinAfterT0: bd ? (bd.fired_ms - l.t0) / 60_000 : undefined,
    fires: fires.map((f) => ({ type: f.type, minAfterT0: (f.fired_ms - l.t0) / 60_000 })),
  };
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  await resolveErc20Meta();
  const rows = launches.map(buildRow);
  rows.sort((a, b) => (b.maxReturn ?? -1) - (a.maxReturn ?? -1));

  // ── part 1: the table ──
  const fmtPx = (v?: number) => (v === undefined ? '·' : v < 0.000001 ? v.toExponential(2) : v.toPrecision(4));
  const fmtUsd = (v?: number) => (v === undefined ? '·' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0));
  const fmtPct = (v?: number) => (v === undefined ? '·' : `${(v * 100).toFixed(1)}%`);
  const fmtRatio = (v?: number) => (v === undefined || Number.isNaN(v) ? '·' : v === Infinity ? '∞' : v.toFixed(1));

  console.log(`\n${'='.repeat(200)}`);
  console.log('PART 1 — every pad-launched token in the window, sorted by max return');
  console.log('='.repeat(200));
  const header = ['symbol', 'adapter', 'auth', 'maxX', ...CHECKPOINTS.map((c) => `px${c.key}`), 'pxMax', ...CHECKPOINTS.map((c) => `depth${c.key}`), 'depthMax', ...CHECKPOINTS.map((c) => `buy${c.key}`), ...CHECKPOINTS.map((c) => `b/s${c.key}`), ...CHECKPOINTS.map((c) => `hold${c.key}`), 'holdMax', ...CHECKPOINTS.map((c) => `top10${c.key}`), 'top10Max', 'bridgeDeployMin', 'fires'];
  console.log(header.join('\t'));
  for (const r of rows) {
    const line = [
      r.l.symbol.slice(0, 12),
      r.l.adapter,
      r.l.authorized ? 'Y' : 'n',
      r.maxReturn !== undefined ? `${r.maxReturn.toFixed(2)}x` : '·',
      ...CHECKPOINTS.map((c) => fmtPx(r.price[c.key])),
      fmtPx(r.price.max),
      ...CHECKPOINTS.map((c) => fmtUsd(r.depth[c.key])),
      fmtUsd(r.depth.max),
      ...CHECKPOINTS.map((c) => r.buyers[c.key] ?? '·'),
      ...CHECKPOINTS.map((c) => fmtRatio(r.buySellRatio[c.key])),
      ...CHECKPOINTS.map((c) => r.holders[c.key] ?? '·'),
      r.holders.max ?? '·',
      ...CHECKPOINTS.map((c) => fmtPct(r.top10[c.key])),
      fmtPct(r.top10.max),
      r.bridgeDeployMinAfterT0 !== undefined ? r.bridgeDeployMinAfterT0.toFixed(1) : '·',
      r.fires.map((f) => `${f.type}@${f.minAfterT0.toFixed(1)}m`).join(';') || '·',
    ];
    console.log(line.join('\t'));
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }

  // ── part 2: runners (>=2x) vs duds — distributions, no fitted model ──
  console.log(`\n${'='.repeat(200)}`);
  console.log('PART 2 — runners (max return >= 2x) vs duds: distributions side by side');
  console.log('='.repeat(200));
  const withReturn = rows.filter((r) => r.maxReturn !== undefined);
  const runners = withReturn.filter((r) => r.maxReturn! >= 2);
  const duds = withReturn.filter((r) => r.maxReturn! < 2);
  console.log(`${withReturn.length} tokens with a computable return (had at least one trade): ${runners.length} runners (>=2x), ${duds.length} duds (<2x)`);

  function dist(xs: (number | undefined)[]): { n: number; p25?: number; p50?: number; p75?: number; mean?: number } {
    const v = xs.filter((x): x is number => x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return { n: 0 };
    const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))]!;
    return { n: v.length, p25: q(0.25), p50: q(0.5), p75: q(0.75), mean: v.reduce((a, b) => a + b, 0) / v.length };
  }
  function printFeature(name: string, fmt: (v: number) => string, get: (r: Row) => number | undefined) {
    const dr = dist(runners.map(get));
    const dd = dist(duds.map(get));
    const f = (d: ReturnType<typeof dist>) => (d.n ? `n=${d.n} p25=${fmt(d.p25!)} p50=${fmt(d.p50!)} p75=${fmt(d.p75!)} mean=${fmt(d.mean!)}` : 'n=0');
    console.log(`${name.padEnd(28)} runners: ${f(dr)}`);
    console.log(`${' '.repeat(28)} duds:    ${f(dd)}`);
  }
  const id = (v: number) => v.toFixed(3);
  const usdF = (v: number) => `$${v.toFixed(0)}`;
  const pctF = (v: number) => `${(v * 100).toFixed(1)}%`;

  console.log('\n-- t0 (available the instant the pool exists) --');
  printFeature('initialBuyUsd', usdF, (r) => r.l.initialBuyUsd);

  console.log('\n-- +5m --');
  printFeature('depth+5m ($)', usdF, (r) => r.depth['+5m']);
  printFeature('buyers+5m (n)', id, (r) => r.buyers['+5m']);
  printFeature('buy/sell$+5m', id, (r) => (Number.isFinite(r.buySellRatio['+5m'] ?? NaN) ? r.buySellRatio['+5m'] : undefined));
  printFeature('holders+5m (n)', id, (r) => r.holders['+5m']);
  printFeature('top10%+5m', pctF, (r) => r.top10['+5m']);

  console.log('\n-- +15m --');
  printFeature('depth+15m ($)', usdF, (r) => r.depth['+15m']);
  printFeature('buyers+15m (n)', id, (r) => r.buyers['+15m']);
  printFeature('buy/sell$+15m', id, (r) => (Number.isFinite(r.buySellRatio['+15m'] ?? NaN) ? r.buySellRatio['+15m'] : undefined));
  printFeature('holders+15m (n)', id, (r) => r.holders['+15m']);
  printFeature('top10%+15m', pctF, (r) => r.top10['+15m']);

  console.log('\n-- +1h --');
  printFeature('depth+1h ($)', usdF, (r) => r.depth['+1h']);
  printFeature('buyers+1h (n)', id, (r) => r.buyers['+1h']);
  printFeature('buy/sell$+1h', id, (r) => (Number.isFinite(r.buySellRatio['+1h'] ?? NaN) ? r.buySellRatio['+1h'] : undefined));
  printFeature('holders+1h (n)', id, (r) => r.holders['+1h']);
  printFeature('top10%+1h', pctF, (r) => r.top10['+1h']);

  console.log('\n-- +6h --');
  printFeature('depth+6h ($)', usdF, (r) => r.depth['+6h']);
  printFeature('buyers+6h (n)', id, (r) => r.buyers['+6h']);
  printFeature('top10%+6h', pctF, (r) => r.top10['+6h']);

  console.log(`\nbridge-deploy fires in this window: ${rows.filter((r) => r.bridgeDeployMinAfterT0 !== undefined).length} of ${rows.length} tokens`);
  const sigCounts = new Map<string, number>();
  for (const r of rows) for (const f of r.fires) sigCounts.set(f.type, (sigCounts.get(f.type) ?? 0) + 1);
  console.log(`signal fires across this population: ${[...sigCounts].map(([t, n]) => `${t}=${n}`).join(', ') || 'none'}`);

  // ── part 3: LP_SURGE threshold replay against this population's mint/burn events ──
  console.log(`\n${'='.repeat(200)}`);
  console.log('PART 3 — LP_SURGE threshold replay (real evaluateLp rule) against this population');
  console.log('='.repeat(200));
  const lpGrid = (arg('lp-grid') ?? '2500,5000,10000,25000,50000').split(',').map(Number);
  const windowSec = cfg.thresholds.lpWindowSec;
  const byToken = new Map<string, Launch>(launches.filter((l) => l.pool).map((l) => [l.pool!, l]));
  for (const lp of lpGrid) {
    const th = { ...cfg.thresholds, lpUsd: lp, lpWatchUsd: Math.min(cfg.thresholds.lpWatchUsd, lp) };
    const hitPools = new Set<string>();
    for (const [pool, l] of byToken) {
      const events = (tradeByVenue.get(pool) ?? []).filter((e) => e.kind === 'mint' || e.kind === 'burn').slice().sort((a, b) => a.t - b.t);
      const side = usdcSideOf(l.token);
      const roll = new RollingEvents(Math.max(windowSec, 600) * 1000);
      let lastSurgeFireMs = -Infinity;
      for (const e of events) {
        const usdcRaw = BigInt((side === 0 ? e.j.amount0 : e.j.amount1) as string);
        const usd = toNumber(usdcRaw, USDC_ERC20_DECIMALS);
        const delta = e.kind === 'mint' ? usd : -usd;
        roll.push(e.t, delta);
        const v = evaluateLp(roll, lastSurgeFireMs, e.t, delta, th);
        if (v?.kind === 'surge') {
          hitPools.add(pool);
          lastSurgeFireMs = e.t;
          break; // first-fire only, matching "how many tokens would this have flagged at all"
        }
      }
    }
    const hitRunners = [...hitPools].filter((p) => byToken.get(p) && runners.some((r) => r.l.token === byToken.get(p)!.token)).length;
    const hitDuds = [...hitPools].filter((p) => byToken.get(p) && duds.some((r) => r.l.token === byToken.get(p)!.token)).length;
    console.log(`ALERT_LP_USD=${lp} (window ${windowSec}s): would fire on ${hitPools.size}/${byToken.size} AMM-launched tokens — catches ${hitRunners}/${runners.filter((r) => r.l.pool).length} runners, lets through ${hitDuds}/${duds.filter((r) => r.l.pool).length} duds`);
  }
  console.log(`(current ALERT_LP_USD=${cfg.thresholds.lpUsd}, ALERT_LP_WINDOW_SEC=${windowSec})`);

  store.close();
}

main().catch((e) => {
  console.error(String((e as Error).stack ?? e));
  process.exit(1);
});
