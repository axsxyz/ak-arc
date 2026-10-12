/**
 * npm run harness — the Definition-of-Done gate. Runs every step, prints a summary, exits ≠0 on any failure.
 * On ARC_NETWORK=testnet the chain probe runs with ALLOW_EMPTY_CHAIN=1 (majors are mainnet assets) and says so.
 */
import '../config/load-env.js'; // must stay first
import { spawnSync } from 'node:child_process';

const network = process.env.ARC_NETWORK ?? 'testnet';
const probeEnv: Record<string, string> = network === 'testnet' && process.env.ALLOW_EMPTY_CHAIN !== '0' ? { ALLOW_EMPTY_CHAIN: '1' } : {};
const steps: { name: string; cmd: string; env?: Record<string, string> }[] = [
  { name: 'typecheck', cmd: 'npm run -s typecheck' },
  { name: 'test:unit', cmd: 'npm run -s test:unit' },
  { name: 'test:fixtures', cmd: 'npm run -s test:fixtures', env: { CI: '1' } }, // CI=1: never silently rewrite snapshots
  { name: 'test:alerts', cmd: 'npm run -s test:alerts' },
  { name: 'test:chain-probe', cmd: 'npm run -s test:chain-probe', env: probeEnv },
  { name: 'test:webhooks:dry', cmd: 'npm run -s test:webhooks:dry', env: { ALLOW_LIVE_WEBHOOKS: '0' } },
];

const results: { name: string; ok: boolean; ms: number }[] = [];
for (const s of steps) {
  console.log(`\n━━━ ${s.name}${s.env && Object.keys(s.env).length ? ` (${Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(' ')})` : ''} ━━━`);
  const t = Date.now();
  const r = spawnSync(s.cmd, { shell: true, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning', ...s.env } });
  results.push({ name: s.name, ok: r.status === 0, ms: Date.now() - t });
}
console.log('\n━━━ harness summary ━━━');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(20)} ${(r.ms / 1000).toFixed(1)}s`);
if (probeEnv.ALLOW_EMPTY_CHAIN) console.log(`note: chain probe ran with ALLOW_EMPTY_CHAIN=1 on ${network} — plumbing only, not live market data.`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
