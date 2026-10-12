/**
 * npm run test:chain-probe — live eth_chainId + getCode report for every watchlist CA.
 * Exit ≠0 if all CRITICAL majors are missing and ALLOW_EMPTY_CHAIN≠1 (forces attaching a mainnet RPC).
 */
import '../config/load-env.js'; // must stay first
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig } from '../config/env.js';
import { loadWatchlists, watchedContracts } from '../config/watchlists.js';
import { RpcChainReader } from '../rpc/clients.js';
import { assertChain, ChainMismatchError, criticalMajorsAllMissing, probeContracts } from '../rpc/probe.js';

async function main() {
  const cfg = loadConfig(process.env, { requireRpc: true });
  const reader = new RpcChainReader(cfg.httpUrl!, cfg.rpc.maxRps);
  const rpcChainId = await reader.chainId();
  console.log(`network=${cfg.network.name} expected_chain_id=${cfg.network.chainId} rpc_chain_id=${rpcChainId} rpc=${redact(cfg.httpUrl!)}`);
  await assertChain(reader, cfg);
  const head = await reader.blockNumber();
  const usdc = await reader.erc20Meta(cfg.usdcMirror);
  console.log(`head=${head} usdc_mirror_decimals=${usdc.decimals ?? 'n/a'}`);

  const w = loadWatchlists(cfg.watchlistDir, cfg.network.name);
  const rows = await probeContracts(reader, rpcChainId, watchedContracts(w, cfg.usdcMirror));
  const header = ['address', 'symbol', 'kind', 'priority', 'code_bytes', 'chain_id', 'status'];
  const table = rows.map((r) => [r.address, r.symbol, r.kind, r.priority, String(r.codeBytes), String(r.chainId), r.status + (r.error ? ` (${r.error})` : '')]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((t) => t[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log('\n' + line(header));
  console.log(widths.map((n) => '-'.repeat(n)).join('  '));
  for (const t of table) console.log(line(t));

  const ok = rows.filter((r) => r.status === 'OK').length;
  const allCritMissing = criticalMajorsAllMissing(rows);
  console.log(`\nsummary: ${ok}/${rows.length} with code; critical majors all missing: ${allCritMissing}`);

  const report = { at: new Date().toISOString(), network: cfg.network.name, chainId: rpcChainId, head: head.toString(), rows };
  const out = path.resolve('data', `chain-probe-${cfg.network.name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`report: ${path.relative(process.cwd(), out)}`);

  if (allCritMissing) {
    if (cfg.allowEmptyChain) {
      console.log(
        `\nGATE: all critical majors MISSING_ON_CHAIN on ${cfg.network.label} — tolerated because ALLOW_EMPTY_CHAIN=1.` +
          (cfg.network.name === 'testnet' ? ' Testnet = plumbing only; no live market data until ARC_NETWORK=mainnet with a mainnet RPC.' : ''),
      );
      return;
    }
    console.error(`\nGATE FAILED: all critical majors missing on chain ${rpcChainId}. Attach a mainnet RPC (ARC_NETWORK=mainnet + ARC_MAINNET_HTTP_URL) or set ALLOW_EMPTY_CHAIN=1 for plumbing runs.`);
    process.exit(3);
  }
}

function redact(url: string) {
  return url.replace(/(\/\/[^/]+\/)[^/]+/, '$1***');
}

main().catch((e) => {
  console.error(e instanceof ConfigError || e instanceof ChainMismatchError ? `FATAL: ${e.message}` : e);
  process.exit(2);
});
