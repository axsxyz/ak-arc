import type { Config } from '../config/env.js';
import type { Router } from '../discord/router.js';
import type { Logger } from '../log.js';
import type { Pipeline } from '../pipeline.js';
import type { ChainReader } from '../rpc/reader.js';
import type { Store } from '../store/sqlite.js';
import { toNumber } from '../math/units.js';
import { directionOf, SIGNAL_HORIZONS_SEC } from '../score/paper.js';

export const PRECISION_HORIZONS_SEC = [300, 900, 3600];

/** Paper precision harness: record every #alerts fire, then sample price/LP at T+5m/15m/1h. */
export function attachPrecision(router: Router, pipeline: Pipeline, store: Store, cfg: Config, now: () => number) {
  router.onFire((s, d) => {
    if (d.channel !== 'alerts' || !s.hardRule) return;
    const pool = s.extraFields?.find((f) => f.name === 'pool')?.value.match(/0x[0-9a-fA-F]{40}/)?.[0]?.toLowerCase();
    const price = s.token ? pipeline.majors.get(s.token.address)?.lastPriceUsd ?? (pool ? pipeline.pools.get(pool)?.priceUsd : undefined) : undefined;
    store.recordFire({
      chainId: cfg.network.chainId,
      type: s.type,
      channel: d.channel,
      ping: d.ping_everyone,
      token: s.token?.address,
      pool,
      usd: s.usd,
      price,
      lp: s.lp,
      eventMs: s.eventTimeMs,
      firedMs: now(),
      horizonsSec: PRECISION_HORIZONS_SEC,
    });
  });
}

export async function samplePrecision(pipeline: Pipeline, reader: ChainReader, store: Store, cfg: Config, nowMs: number, log: Logger) {
  const due = store.dueSamples(nowMs);
  for (const s of due) {
    const poolState = s.pool ? pipeline.pools.get(s.pool) : undefined;
    const price = (s.token ? pipeline.majors.get(s.token)?.lastPriceUsd : undefined) ?? poolState?.priceUsd;
    let lp: number | undefined;
    if (s.pool) {
      const bal = await reader.balanceOf(cfg.usdcMirror, s.pool as `0x${string}`);
      if (bal !== undefined) lp = toNumber(bal, poolState?.usdcDecimals ?? 6);
    }
    store.fillSample(s.fire_id, s.horizon_sec, price, lp, nowMs);
  }
  if (due.length) log.debug({ n: due.length }, 'precision samples filled');
}

type OnFire = Parameters<Router['onFire']>[0];

/** Pool of a signal: the structured field, else the `pool` embed field (older signal builders). */
export function signalPool(s: Parameters<OnFire>[0]): string | undefined {
  return (s.pool ?? s.extraFields?.find((f) => f.name === 'pool')?.value.match(/0x[0-9a-fA-F]{40}/)?.[0])?.toLowerCase();
}

/** Best in-memory price for a token/pool: the major's source pool, else the pool's last price. Raw-free (USD). */
function livePrice(pipeline: Pipeline, token: string | undefined, pool: string | undefined): { price?: number; source?: string } {
  const major = token ? pipeline.majors.get(token) : undefined;
  if (major?.lastPriceUsd !== undefined && major.sourcePool && (!pool || pool === major.sourcePool)) return { price: major.lastPriceUsd, source: 'major_source_pool' };
  const p = pool ? pipeline.pools.get(pool)?.priceUsd : undefined;
  return p !== undefined ? { price: p, source: 'pool_last' } : {};
}

/**
 * Edge scorecard recorder: every ROUTED signal with a scoring direction (all channels) → signal_fires + samples at
 * SIGNAL_HORIZONS_SEC. The write is deferred (setImmediate) so the router never waits on SQLite.
 */
export function attachSignalScoring(router: Router, pipeline: Pipeline, store: Store, cfg: Config, now: () => number, log?: Logger) {
  router.onFire((s, d) => {
    const direction = directionOf(s.type);
    if (!direction) return;
    const pool = signalPool(s);
    const ps = pool ? pipeline.pools.get(pool) : undefined;
    const { price, source } = livePrice(pipeline, s.token?.address, pool);
    const depth = s.lp ?? ps?.usdcDepth;
    const firedMs = now();
    const row = {
      chainId: cfg.network.chainId,
      type: s.type,
      channel: d.channel,
      ping: d.ping_everyone,
      token: s.token?.address,
      symbol: s.token?.symbol,
      venue: s.venue,
      pool,
      direction,
      usd: s.usd,
      priceAtFire: price,
      priceSource: source,
      poolFee: ps?.fee,
      poolUsdcDepth: depth,
      eventMs: s.eventTimeMs,
      firedMs,
    };
    setImmediate(() => {
      try {
        store.recordSignalFire(row, SIGNAL_HORIZONS_SEC);
        if (pool && depth !== undefined) store.setPoolDepth(cfg.network.chainId, pool, depth, firedMs);
      } catch (e) {
        log?.warn({ err: String(e) }, 'signal_fires write failed');
      }
    });
  });
}

/** Fill due signal samples from in-memory state only (no RPC: must not compete with the alert path's rate limit). */
export function sampleSignals(pipeline: Pipeline, store: Store, nowMs: number, log?: Logger) {
  const due = store.dueSignalSamples(nowMs);
  for (const s of due) {
    const pool = s.pool ?? undefined;
    const { price } = livePrice(pipeline, s.token ?? undefined, pool);
    store.fillSignalSample(s.fire_id, s.horizon_sec, price, pool ? pipeline.pools.get(pool)?.usdcDepth : undefined, nowMs);
  }
  if (due.length) log?.debug({ n: due.length }, 'signal samples filled');
}
