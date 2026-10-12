/** npm run report:precision [-- --days 7] — hit-rate of #alerts fires from the paper precision harness. */
import '../config/load-env.js'; // must stay first
import { loadConfig } from '../config/env.js';
import { Store } from '../store/sqlite.js';

const i = process.argv.indexOf('--days');
const days = i > 0 ? Number(process.argv[i + 1]) : 7;
const cfg = loadConfig(process.env);
const store = new Store(cfg.dbPath);
const since = Date.now() - days * 86_400_000;
const rows = store.db
  .prepare(
    `SELECT f.type, s.horizon_sec, COUNT(*) n,
            SUM(CASE WHEN s.price IS NOT NULL AND f.price_at_fire IS NOT NULL AND s.price > f.price_at_fire THEN 1 ELSE 0 END) up,
            SUM(CASE WHEN s.price IS NOT NULL AND f.price_at_fire IS NOT NULL THEN 1 ELSE 0 END) priced,
            AVG(CASE WHEN s.price IS NOT NULL AND f.price_at_fire > 0 THEN (s.price - f.price_at_fire) / f.price_at_fire END) avg_ret
     FROM alert_fires f JOIN precision_samples s ON s.fire_id = f.id
     WHERE f.chain_id = ? AND f.fired_ms >= ? AND s.sampled_ms IS NOT NULL
     GROUP BY f.type, s.horizon_sec ORDER BY f.type, s.horizon_sec`,
  )
  .all(cfg.network.chainId, since) as { type: string; horizon_sec: number; n: number; up: number; priced: number; avg_ret: number | null }[];
const fires = store.db.prepare('SELECT COUNT(*) c FROM alert_fires WHERE chain_id = ? AND fired_ms >= ?').get(cfg.network.chainId, since) as { c: number };
console.log(`precision report — ${cfg.network.label}, last ${days}d, ${fires.c} alert fires`);
if (!rows.length) console.log('no sampled fires yet.');
for (const r of rows) {
  const hit = r.priced ? ((r.up / r.priced) * 100).toFixed(1) + '%' : 'n/a';
  const ret = r.avg_ret === null ? 'n/a' : (r.avg_ret * 100).toFixed(2) + '%';
  console.log(`${r.type.padEnd(22)} T+${String(r.horizon_sec / 60).padStart(2)}m  n=${String(r.n).padStart(4)}  priced=${String(r.priced).padStart(4)}  hit(up)=${hit.padStart(6)}  avg_ret=${ret}`);
}
store.close();
