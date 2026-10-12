/**
 * npm run report:scorecard [-- --days 7 --db data/radar-mainnet.sqlite --horizons 60,300,900,3600 --gate-horizon 900
 *                              --latency-ms 3000 --size-usd 500 --chain-id 5042]
 * Paper edge scorecard over signal_fires (see src/jobs/scorecard.ts). Read-only apart from an index on events.
 * Point --db at a COPY when the bot is running.
 */
import '../config/load-env.js'; // must stay first
import path from 'node:path';
import { loadConfig } from '../config/env.js';
import { buildScorecard, dataEndMs, formatScorecard, pickChain } from '../jobs/scorecard.js';
import { Store } from '../store/sqlite.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const cfg = loadConfig(process.env);
const days = Number(arg('days') ?? 7);
const store = new Store(arg('db') ? path.resolve(arg('db')!) : cfg.dbPath);
const picked = arg('chain-id') ? { chainId: Number(arg('chain-id')) } : pickChain(store.db, cfg.network.chainId);
if ('note' in picked && picked.note) console.log(`note: ${picked.note}`);
const end = Math.max(dataEndMs(store.db, picked.chainId) ?? 0, 0) || Date.now();
const opts = {
  chainId: picked.chainId,
  sinceMs: end - days * 86_400_000,
  dataEndMs: end,
  latencyMs: Number(arg('latency-ms') ?? cfg.paper.latencyMs),
  sizeUsd: Number(arg('size-usd') ?? cfg.paper.sizeUsd),
  horizonsSec: (arg('horizons') ?? '60,300,900,3600').split(',').map(Number),
  gateHorizonSec: Number(arg('gate-horizon') ?? 900),
};
console.log(formatScorecard(buildScorecard(store, opts), opts));
store.close();
