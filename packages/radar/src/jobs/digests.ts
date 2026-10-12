import type { Address } from 'viem';
import type { Config } from '../config/env.js';
import { fmtPct, fmtPrice, fmtUsd, NA, tokenLink } from '../discord/embeds.js';
import type { PoolState } from '../features/pools.js';
import { signalMcap } from '../features/signal-metrics.js';
import { v3TokenPriceUsd } from '../math/price.js';
import { toNumber } from '../math/units.js';
import type { Pipeline } from '../pipeline.js';
import type { ChainReader } from '../rpc/reader.js';
import type { Field } from '../score/types.js';
import type { HoldersBackfill } from './holders-backfill.js';

const V3_FEES = [100, 500, 3000, 10000];
const PRICE_FRESH_MS = 15 * 60_000;
const DEAD = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);

/** Trusted + untrusted USDC pools for a token: registry + allowlisted factory lookups (getPool/getPair, cached). */
export async function majorPools(pipeline: Pipeline, reader: ChainReader, token: Address, usdc: Address): Promise<PoolState[]> {
  const found = new Map<string, PoolState>();
  for (const p of pipeline.pools.all()) if (p.token === token) found.set(p.pool, p);
  const [t0, t1] = usdc.toLowerCase() < token ? [usdc.toLowerCase() as Address, token] : [token, usdc.toLowerCase() as Address];
  for (const f of pipeline.ammFactories()) {
    const lookups = f.kind === 'univ3' ? V3_FEES.map((fee) => reader.factoryLookup(f.address, 'univ3', t0, t1, fee)) : [reader.factoryLookup(f.address, 'univ2', t0, t1)];
    for (const pool of await Promise.all(lookups)) {
      if (!pool || found.has(pool)) continue;
      found.set(pool, await pipeline.pools.ensure(pool, f.kind));
    }
  }
  return [...found.values()].filter((p) => p.usdcSide !== undefined);
}

/**
 * Refresh USDC depth of each on-chain major's trusted pools and pick its price source (deepest pool holding
 * >= MAJOR_PRICE_MIN_LP_USD). A failed balanceOf keeps the previous depth (throttling must not zero a pool).
 */
export async function refreshMajorDepths(pipeline: Pipeline, reader: ChainReader, cfg: Config, nowMs: number) {
  const staleMs = cfg.majorDepthRefreshSec * 3000;
  for (const m of pipeline.watchlists.majors) {
    if (pipeline.missing.has(m.address)) continue;
    const st = pipeline.majors.get(m.address);
    if (!st) continue;
    const trusted = (await majorPools(pipeline, reader, m.address, cfg.usdcMirror)).filter((p) => p.trusted);
    for (const p of trusted) {
      const bal = await reader.balanceOf(cfg.usdcMirror, p.pool);
      if (bal === undefined) continue;
      p.usdcDepth = toNumber(bal, p.usdcDecimals);
      p.depthUpdatedMs = nowMs;
    }
    const known = trusted.filter((p) => p.usdcDepth !== undefined && nowMs - (p.depthUpdatedMs ?? 0) <= staleMs);
    const deepest = known.reduce<PoolState | undefined>((a, p) => (!a || p.usdcDepth! > a.usdcDepth! ? p : a), undefined);
    st.setSource(deepest && deepest.usdcDepth! >= cfg.majorPriceMinLpUsd ? deepest.pool : undefined);
  }
}

const poolLike = new Map<string, boolean>();
/** Is `holder` an AMM pool/pair containing `token`? (cached; used to exclude LP from top10%) */
async function isPoolFor(reader: ChainReader, holder: Address, token: Address): Promise<boolean> {
  const k = `${holder}:${token}`;
  const hit = poolLike.get(k);
  if (hit !== undefined) return hit;
  let res = false;
  if ((await reader.getCode(holder).catch(() => '0x')) !== '0x') {
    const on = await reader.poolOnchain(holder, 'univ3');
    res = on.token0 === token || on.token1 === token;
  }
  poolLike.set(k, res);
  return res;
}

function holdersDataText(h: ReturnType<HoldersBackfill['statusOf']> | undefined, negatives: number): string {
  if (!h) return 'not tracked';
  const warn = negatives > 0 ? ` · ⚠ ${negatives} negative balances (non-standard token?)` : '';
  switch (h.phase) {
    case 'disabled':
      return 'backfill disabled (HOLDERS_BACKFILL=0)';
    case 'pending':
      return 'backfill queued';
    case 'birth-search':
      return 'finding token creation block…';
    case 'backfilling':
      return `backfilling ${h.pct !== undefined ? `${h.pct.toFixed(1)}%` : ''}${h.syncedTo !== undefined ? ` (block ${h.syncedTo})` : ''}${h.capped ? ' · capped: partial history' : ''}${warn}`;
    case 'mismatch':
      return `⚠ Σbalances ≠ totalSupply (${h.mismatchPct !== undefined ? `${h.mismatchPct > 0 ? '+' : ''}${h.mismatchPct.toFixed(4)}%` : '?'}) — history incomplete or non-standard token${warn}`;
    case 'synced':
      return `full history since block ${h.birthBlock ?? '?'} · synced to ${h.syncedTo ?? '?'}${warn}`;
    case 'error':
      return `retrying after RPC error: ${h.error ?? 'unknown'}`;
  }
}

/**
 * #major-coins periodic digest: only majors with code on this chain. MAJOR_DIGEST is the one embed that renders every
 * metric as a value or explicit "n/a" (so a missing number is visible, never silently dropped):
 *  - price: ONLY from the source pool (deepest trusted USDC pool holding >= MAJOR_PRICE_MIN_LP_USD): its last swap if
 *    < 15 min old, else its spot (slot0 / reserves); n/a if no such pool (dust pools never price a major)
 *  - lp: USDC across trusted pools, n/a unless every pool's depth read is fresh (never a partial sum)
 *  - mcap: price × fresh totalSupply; n/a if price or supply unknown
 *  - vol 1m/5m/1h, ΔLP 1h, buy/sell 1h: n/a until the radar's in-memory coverage spans the window
 *  - lp: USDC held by trusted pools; n/a if none found/readable
 *  - holders≈ / top10%: n/a until the Transfer backfill from token birth has synced (see "holders data")
 */
export async function majorDigest(
  pipeline: Pipeline,
  reader: ChainReader,
  cfg: Config,
  nowMs: number,
  log?: { info: (o: object, m: string) => void },
  holdersJob?: HoldersBackfill,
) {
  const live = pipeline.watchlists.majors.filter((m) => !pipeline.missing.has(m.address));
  if (!live.length) {
    log?.info({ chainId: cfg.network.chainId }, 'major digest: 0 majors on chain, nothing posted');
    return [];
  }
  const coveredMin = (nowMs - pipeline.coverageFromMs) / 60_000;
  const covered = (minutes: number) => coveredMin >= minutes;
  const venue = pipeline.venueContracts();
  const out = [];
  for (const m of live) {
    const st = pipeline.majors.get(m.address);
    const meta = await reader.erc20Meta(m.address);
    const decimals = meta.decimals ?? m.decimals;
    const supply = (await reader.totalSupply(m.address)) ?? meta.totalSupply;
    const pools = await majorPools(pipeline, reader, m.address, cfg.usdcMirror);
    const trusted = pools.filter((p) => p.trusted);

    // lp: only when every trusted pool's depth is known and fresh (a partial sum under throttling is a wrong number)
    await refreshMajorDepths(pipeline, reader, cfg, nowMs);
    const staleMs = cfg.majorDepthRefreshSec * 3000;
    const fresh = (p: PoolState) => p.usdcDepth !== undefined && nowMs - (p.depthUpdatedMs ?? 0) <= staleMs;
    const lp = trusted.length && trusted.every(fresh) ? trusted.reduce((a, p) => a + p.usdcDepth!, 0) : undefined;

    // price: only from the source pool (deepest trusted pool with >= MAJOR_PRICE_MIN_LP_USD USDC)
    let price: number | undefined;
    let priceSrc = '';
    const source = st?.sourcePool ? pipeline.pools.get(st.sourcePool) : undefined;
    if (source && st?.lastPriceUsd !== undefined && st.lastPriceMs !== undefined && nowMs - st.lastPriceMs <= PRICE_FRESH_MS) {
      price = st.lastPriceUsd;
      priceSrc = 'last swap';
    } else if (source && decimals !== undefined) {
      if (source.dex === 'univ3') {
        const sp = await reader.v3SqrtPrice(source.pool);
        if (sp) {
          const [d0, d1] = source.usdcSide === 0 ? [source.usdcDecimals, decimals] : [decimals, source.usdcDecimals];
          price = v3TokenPriceUsd(sp, d0, d1, source.usdcSide === 0);
          priceSrc = 'pool spot';
        }
      } else if (source.priceUsd !== undefined) {
        price = source.priceUsd;
        priceSrc = 'pool reserves';
      }
    }
    if (price !== undefined && source?.usdcDepth !== undefined) priceSrc += ` · ${fmtUsd(source.usdcDepth)} pool`;
    const mc = signalMcap(price, supply, decimals);

    // windows
    const volField = (min: number) => (covered(min) ? fmtUsd(st ? st.vol.sumWindow(nowMs, min) : 0) : NA);
    const dLp = covered(60) ? fmtUsd(trusted.reduce((a, p) => a + p.lp.sum(nowMs - 3600_000, nowMs), 0)) : NA;
    let buySell = NA;
    if (covered(60)) {
      const buys = st?.buyUsd.sumWindow(nowMs, 60) ?? 0;
      const sells = st?.sellUsd.sumWindow(nowMs, 60) ?? 0;
      buySell = sells > 0 ? (buys / sells).toFixed(2) : buys > 0 ? 'buys only' : 'no trades';
    }

    // holders
    const holders = pipeline.holders.get(m.address);
    let holdersVal = NA;
    let top10 = NA;
    if (holders?.sinceBirth) {
      holdersVal = String(holders.holderCount());
      const exclude = new Set<string>([...DEAD, m.address, ...venue, ...pools.map((p) => p.pool)]);
      // Drop pool-like holders (AMM pools on non-allowlisted venues) from the ranking, then take the top 10.
      for (const [addr] of holders.topHolders(25, exclude)) if (await isPoolFor(reader, addr, m.address)) exclude.add(addr);
      const share = holders.top10Share(supply, exclude);
      top10 = share !== undefined ? fmtPct(share) : NA;
    }

    const fields: Field[] = [
      { name: 'token', value: tokenLink(cfg.network, m.address, m.symbol), inline: true },
      { name: 'price', value: price !== undefined ? `${fmtPrice(price)} · ${priceSrc}` : NA, inline: true },
      { name: 'mcap', value: fmtUsd(mc), inline: true },
      { name: 'vol 1m', value: volField(1), inline: true },
      { name: 'vol 5m', value: volField(5), inline: true },
      { name: 'vol 1h', value: volField(60), inline: true },
      { name: 'lp (USDC)', value: fmtUsd(lp), inline: true },
      { name: 'ΔLP 1h', value: dLp, inline: true },
      { name: 'buy/sell 1h', value: buySell, inline: true },
      { name: 'holders≈', value: holdersVal, inline: true },
      { name: 'top10% (ex LP/burn/venues)', value: top10, inline: true },
      { name: 'pools (trusted/all)', value: pools.length ? `${trusted.length}/${pools.length}` : NA, inline: true },
      { name: 'holders data', value: holdersDataText(holdersJob?.statusOf(m.address), holders?.historyComplete ? holders.negatives : 0), inline: false },
    ];
    out.push(
      await pipeline.publish({
        type: 'MAJOR_DIGEST',
        channel: 'major-coins',
        severity: 'info',
        dedupeKey: `DIGEST|${m.address}|${Math.floor(nowMs / (cfg.majorDigestSec * 1000))}`,
        eventTimeMs: nowMs,
        evidence: { usdCertain: true, trusted: true },
        compact: true,
        title: `MAJOR_DIGEST · ${m.symbol}`,
        extraFields: fields,
      }),
    );
  }
  return out;
}

/**
 * #smart-flow periodic bridge net-flow digest: rolling 5m/1h inflow, outflow and net (in - out). Skipped entirely
 * when both windows are flat, so a quiet corridor doesn't spam the channel every BRIDGE_DIGEST_SEC.
 */
export async function bridgeFlowDigest(pipeline: Pipeline, cfg: Config, nowMs: number) {
  const in5 = pipeline.bridgeInflowWindow(nowMs, 5);
  const in60 = pipeline.bridgeInflowWindow(nowMs, 60);
  const out5 = pipeline.bridgeOutflowWindow(nowMs, 5);
  const out60 = pipeline.bridgeOutflowWindow(nowMs, 60);
  if (in5 === 0 && in60 === 0 && out5 === 0 && out60 === 0) return undefined;
  const fields: Field[] = [
    { name: 'inflow 5m', value: fmtUsd(in5), inline: true },
    { name: 'outflow 5m', value: fmtUsd(out5), inline: true },
    { name: 'net 5m', value: fmtUsd(in5 - out5), inline: true },
    { name: 'inflow 1h', value: fmtUsd(in60), inline: true },
    { name: 'outflow 1h', value: fmtUsd(out60), inline: true },
    { name: 'net 1h', value: fmtUsd(in60 - out60), inline: true },
  ];
  return pipeline.publish({
    type: 'BRIDGE_NET_FLOW',
    channel: 'smart-flow',
    severity: 'info',
    dedupeKey: `BRIDGENET|${Math.floor(nowMs / (cfg.bridgeDigestSec * 1000))}`,
    eventTimeMs: nowMs,
    evidence: { usdCertain: true, trusted: true },
    compact: true,
    title: `BRIDGE_NET_FLOW · net 1h ${fmtUsd(in60 - out60)}`,
    extraFields: fields,
  });
}

/** #launchpads hourly leaderboard: 1h/24h launches, graduated %, vol, share of pad vol; "winning pad" = top 1h vol. Unknown parts are omitted. */
export async function padLeaderboard(pipeline: Pipeline, cfg: Config, nowMs: number) {
  const rows = [...pipeline.pads.values()].map((p) => ({ name: p.name, h1: p.window(nowMs, 3600_000), h24: p.window(nowMs, 24 * 3600_000) }));
  const totalH1 = rows.reduce((a, r) => a + r.h1.volUsd, 0);
  // Ecosystem USDC vol across every tracked USDC pool (pads + dex + unverified), for share-of-ecosystem-vol.
  const ecosystemH1 = pipeline.pools.all().reduce((a, p) => a + (p.usdcSide !== undefined ? p.vol.sumWindow(nowMs, 60) : 0), 0);
  rows.sort((a, b) => b.h1.volUsd - a.h1.volUsd || b.h24.launched - a.h24.launched);
  const winner = rows[0] && rows[0].h1.volUsd > 0 ? rows[0] : undefined;
  const grad = (w: { graduated: number; migrateRatio?: number }) => (w.migrateRatio !== undefined ? `${w.graduated} grad (${fmtPct(w.migrateRatio)})` : `${w.graduated} grad`);
  const fields: Field[] = rows
    .filter((r) => r.h24.launched > 0 || r.h24.volUsd > 0)
    .slice(0, 12)
    .map((r) => {
      const tail = [
        ecosystemH1 > 0 ? `share 1h: ${fmtPct(r.h1.volUsd / ecosystemH1)}` : undefined,
        r.h24.medianTimeToXMs !== undefined ? `median t→$${Math.round(cfg.thresholds.padTimeToUsd / 1000)}k: ${Math.round(r.h24.medianTimeToXMs / 60_000)}m` : undefined,
      ].filter(Boolean);
      return {
        name: r.name,
        value: [
          `1h: ${r.h1.launched} launched · ${grad(r.h1)} · vol ${fmtUsd(r.h1.volUsd)}`,
          `24h: ${r.h24.launched} launched · ${grad(r.h24)} · vol ${fmtUsd(r.h24.volUsd)}`,
          ...(tail.length ? [tail.join(' · ')] : []),
        ].join('\n'),
        inline: false,
      };
    });
  return pipeline.publish({
    type: 'PAD_LEADERBOARD',
    channel: 'launchpads',
    severity: 'info',
    dedupeKey: `PADLB|${Math.floor(nowMs / 3600_000)}`,
    eventTimeMs: nowMs,
    evidence: { usdCertain: true, trusted: true },
    compact: true,
    title: winner ? `PAD_LEADERBOARD · winning pad: ${winner.name}` : 'PAD_LEADERBOARD · no pad volume in the last hour',
    description: `Pad USDC vol 1h ${fmtUsd(totalH1)} of tracked ecosystem ${fmtUsd(ecosystemH1)}.`,
    extraFields: fields.length ? fields : [{ name: 'pads', value: 'no launches or volume in the last 24h' }],
  });
}
