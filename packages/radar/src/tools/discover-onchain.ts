/**
 * npm run discover:onchain [-- --blocks 600]
 * Bounded scan of recent blocks (5-block getLogs chunks) listing emitters of pool/pair/token-creation topics,
 * plus the most active V2/V3 pool emitters. Use it to find factories/pads on the active network.
 */
import '../config/load-env.js'; // must stay first
import type { Address } from 'viem';
import { loadConfig } from '../config/env.js';
import { decodeLog, DEX_TOPICS, TOPICS } from '../decode/index.js';
import { RpcChainReader } from '../rpc/clients.js';

async function main() {
  const i = process.argv.indexOf('--blocks');
  const blocks = BigInt(i > 0 ? Number(process.argv[i + 1]) : 600);
  const cfg = loadConfig(process.env, { requireRpc: true });
  const reader = new RpcChainReader(cfg.httpUrl!, cfg.rpc.maxRps);
  const head = await reader.blockNumber();
  const from = head - blocks + 1n;
  const step = BigInt(cfg.rpc.getLogsMaxRange);
  const creators = new Map<string, { kind: string; count: number; sample: string }>();
  const pools = new Map<string, { dex: string; swaps: number; mints: number }>();
  let logs = 0;
  const allowed = new Map<string, string>(Object.entries(TOPICS).map(([k, v]) => [v, k]));
  console.log(`scanning ${blocks} blocks [${from}, ${head}] on chain ${cfg.network.chainId} in ${step}-block chunks…`);
  for (let b = from; b <= head; b += step) {
    const to = b + step - 1n > head ? head : b + step - 1n;
    const batch = await reader.getLogs({ fromBlock: b, toBlock: to, topics: [DEX_TOPICS] });
    logs += batch.length;
    for (const l of batch) {
      const ev = decodeLog(l);
      const kind = allowed.get(l.topics[0]!) ?? '?';
      if (!ev) continue;
      if (ev.kind === 'pool_created' || ev.kind === 'pad_token_created' || ev.kind === 'pad_graduated') {
        const c = creators.get(ev.emitter) ?? { kind, count: 0, sample: l.transactionHash };
        c.count++;
        creators.set(ev.emitter, c);
      } else if (ev.kind === 'swap' || ev.kind === 'mint') {
        const p = pools.get(ev.emitter) ?? { dex: ev.dex, swaps: 0, mints: 0 };
        if (ev.kind === 'swap') p.swaps++;
        else p.mints++;
        pools.set(ev.emitter, p);
      }
    }
  }
  console.log(`\n${logs} DEX/pad logs.\nCreation-event emitters (factory/pad candidates):`);
  for (const [a, c] of [...creators].sort((x, y) => y[1].count - x[1].count)) console.log(`  ${a}  ${c.kind} ×${c.count}  e.g. ${cfg.network.explorer}/tx/${c.sample}`);
  if (!creators.size) console.log('  (none in window — widen --blocks)');
  console.log('\nMost active pools (resolve factory() to find the DEX):');
  const top = [...pools].sort((x, y) => y[1].swaps - x[1].swaps).slice(0, 15);
  for (const [a, p] of top) {
    const on = await reader.poolOnchain(a as Address, p.dex as 'univ2' | 'univ3');
    console.log(`  ${a}  ${p.dex} swaps=${p.swaps} mints=${p.mints} factory=${on.factory ?? 'n/a'} tokens=${on.token0 ?? '?'}/${on.token1 ?? '?'}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
