import type { Clock } from '../clock.js';
import type { Config } from '../config/env.js';
import { watchedContracts } from '../config/watchlists.js';
import { addrLink } from '../discord/embeds.js';
import type { Logger } from '../log.js';
import type { Pipeline } from '../pipeline.js';
import { probeContracts, type ProbeRow } from '../rpc/probe.js';
import type { ChainReader } from '../rpc/reader.js';
import type { Store } from '../store/sqlite.js';

/**
 * Boot probe: getCode every watchlist CA. Missing → excluded from loops + ONE aggregated #alerts embed (no ping)
 * for CAs not previously reported on this chain (persisted in SQLite, so restarts don't repost).
 */
export async function runBootProbe(deps: {
  cfg: Config;
  reader: ChainReader;
  pipeline: Pipeline;
  store: Store;
  clock: Clock;
  log: Logger;
}): Promise<ProbeRow[]> {
  const { cfg, reader, pipeline, store, clock, log } = deps;
  const rows = await probeContracts(reader, cfg.network.chainId, watchedContracts(pipeline.watchlists, cfg.usdcMirror));
  pipeline.missing.clear();
  for (const r of rows) {
    if (r.status === 'OK') store.clearMissing(cfg.network.chainId, r.address);
    else pipeline.missing.add(r.address);
  }
  const missing = rows.filter((r) => r.status === 'MISSING_ON_CHAIN');
  log.info({ total: rows.length, ok: rows.length - missing.length, missing: missing.length, chainId: cfg.network.chainId }, 'boot probe');
  const fresh = store.claimMissing(cfg.network.chainId, missing, clock.now());
  if (!fresh.length) return rows;

  const byAddr = new Map<string, ProbeRow>(missing.map((m) => [m.address, m]));
  const lines = fresh.map((f) => {
    const r = byAddr.get(f.address)!;
    return `• **${r.symbol}** (${r.kind}${r.priority === 'critical' ? ', critical' : ''}) ${addrLink(cfg.network, r.address)}`;
  });
  // Discord field limit 1024 chars: chunk.
  const chunks: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur.length + l.length + 1 > 1000) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) chunks.push(cur);
  const now = clock.now();
  await pipeline.publish({
    type: 'MISSING_ON_CHAIN',
    channel: 'alerts',
    severity: 'watch',
    dedupeKey: `MISSING|${cfg.network.chainId}|${now}`,
    eventTimeMs: now,
    evidence: { usdCertain: false, trusted: true },
    compact: true,
    title: `MISSING_ON_CHAIN · ${fresh.length} watchlist CA${fresh.length > 1 ? 's' : ''}`,
    description:
      `eth_getCode returned empty on chain ${cfg.network.chainId} (${cfg.network.label}). These are skipped — no metrics, no prices.` +
      (cfg.network.name === 'testnet' ? ' Ecosystem tokens and launchpads are likely mainnet (5042) assets: attach a mainnet RPC.' : ''),
    extraFields: chunks.slice(0, 20).map((c, i) => ({ name: i === 0 ? 'contracts' : '…', value: c, inline: false })),
  });
  return rows;
}
