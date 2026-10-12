/**
 * npm run discover:factories [-- --write]
 * Best-effort scraper: for each pad/dex URL, fetch HTML + same-origin JS bundles, extract 0x addresses,
 * getCode them on the ACTIVE network, and classify by bytecode topics (V2 factory / V3 factory / pad-like).
 * Output: config/watchlists/launchpads.scraped.yaml (raw). launchpads.discovered.yaml is the operator-curated evidence file
 * and is never overwritten. --write merges an unambiguous AMM factory into launchpads.yaml networks.<active>.factories.
 * Pads whose factory cannot be resolved stay factory: null and are reported as TODO.
 */
import '../config/load-env.js'; // must stay first
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import type { Address, Hex } from 'viem';
import { loadConfig } from '../config/env.js';
import { loadWatchlists } from '../config/watchlists.js';
import { TOPICS } from '../decode/index.js';
import { RpcChainReader } from '../rpc/clients.js';

const MAX_BUNDLES = 25;
const MAX_BYTES = 8_000_000;

export type Classification = 'univ3-factory' | 'univ2-factory' | 'pad-like' | 'erc20-like' | 'contract' | 'no-code';

/** Classify by event topics / selectors embedded in runtime bytecode. */
export function classifyBytecode(code: Hex): Classification {
  if (!code || code === '0x') return 'no-code';
  const c = code.toLowerCase();
  const has = (t: string) => c.includes(t.slice(2));
  if (has(TOPICS.v3PoolCreated)) return 'univ3-factory';
  if (has(TOPICS.v2PairCreated)) return 'univ2-factory';
  if (has(TOPICS.padTokenCreated) || has(TOPICS.padGraduated)) return 'pad-like';
  if (has(TOPICS.transfer) && c.includes('18160ddd') && c.includes('70a08231')) return 'erc20-like';
  return 'contract';
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'arc-radar-discovery/1.0' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    const buf = await res.arrayBuffer();
    return buf.byteLength > MAX_BYTES ? undefined : new TextDecoder().decode(buf);
  } catch {
    return undefined;
  }
}

async function scrape(siteUrl: string): Promise<{ addresses: Map<string, string[]>; fetched: number }> {
  const addresses = new Map<string, string[]>();
  const origin = new URL(siteUrl).origin;
  const html = await fetchText(siteUrl);
  if (!html) return { addresses, fetched: 0 };
  const sources: [string, string][] = [[siteUrl, html]];
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => new URL(m[1]!, siteUrl).toString());
  const preloads = [...html.matchAll(/<link[^>]+href=["']([^"']+\.js)["']/g)].map((m) => new URL(m[1]!, siteUrl).toString());
  for (const s of [...new Set([...scripts, ...preloads])].filter((u) => u.startsWith(origin)).slice(0, MAX_BUNDLES)) {
    const t = await fetchText(s);
    if (t) sources.push([s, t]);
  }
  for (const [src, text] of sources) {
    for (const m of text.matchAll(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g)) {
      const a = m[0].toLowerCase();
      const ctx = text.slice(Math.max(0, m.index! - 40), m.index!).replace(/\s+/g, ' ');
      const list = addresses.get(a) ?? [];
      if (list.length < 3) list.push(`${path.basename(new URL(src).pathname) || '/'}: …${ctx}`);
      addresses.set(a, list);
    }
  }
  return { addresses, fetched: sources.length };
}

async function main() {
  const write = process.argv.includes('--write');
  const cfg = loadConfig(process.env, { requireRpc: true });
  const reader = new RpcChainReader(cfg.httpUrl!, cfg.rpc.maxRps);
  const w = loadWatchlists(cfg.watchlistDir, cfg.network.name);
  const venues = [...w.pads.map((p) => ({ ...p, role: 'pad' as const })), ...w.dex.map((d) => ({ ...d, role: 'dex' as const, pad_token: null }))];
  const report: Record<string, unknown>[] = [];
  const todo: string[] = [];

  for (const v of venues) {
    if (!v.url) continue;
    process.stdout.write(`${v.name} (${v.url}) … `);
    const { addresses, fetched } = await scrape(v.url);
    const candidates: { address: string; class: Classification; code_bytes: number; context: string[] }[] = [];
    for (const [a, ctx] of addresses) {
      if (a === '0x0000000000000000000000000000000000000000') continue;
      const code = await reader.getCode(a as Address).catch(() => '0x' as Hex);
      candidates.push({ address: a, class: classifyBytecode(code), code_bytes: code === '0x' ? 0 : (code.length - 2) / 2, context: ctx });
    }
    const factories = candidates.filter((c) => c.class === 'univ3-factory' || c.class === 'univ2-factory' || c.class === 'pad-like');
    console.log(`pages=${fetched} addrs=${addresses.size} with_code=${candidates.filter((c) => c.code_bytes > 0).length} factory_like=${factories.length}`);
    report.push({ name: v.name, role: v.role, url: v.url, chain_id: cfg.network.chainId, current_factories: v.factories, factory_candidates: factories, other_addresses: candidates.filter((c) => !factories.includes(c)) });
    if (!v.factories.length && factories.length !== 1) todo.push(`${v.name}: ${factories.length === 0 ? 'no factory-like contract found on this chain (JS-rendered config or other network?)' : `${factories.length} candidates — pick manually`}`);
    if (write && !v.factories.length && factories.length === 1 && factories[0]!.class !== 'pad-like') {
      const file = path.join(cfg.watchlistDir, 'launchpads.yaml');
      const doc = parseDocument(fs.readFileSync(file, 'utf8'));
      const seq = doc.get(v.role === 'pad' ? 'pads' : 'dex') as { items: { get(k: string): unknown; setIn(p: unknown[], v: unknown): void }[] };
      const node = seq.items.find((n) => n.get('name') === v.name);
      node?.setIn(['networks', cfg.network.name, 'factories'], [
        { address: factories[0]!.address, kind: factories[0]!.class === 'univ3-factory' ? 'univ3' : 'univ2', label: 'scraped' },
      ]);
      fs.writeFileSync(file, doc.toString());
      console.log(`  → wrote networks.${cfg.network.name}.factories for ${v.name}`);
    }
  }
  const out = path.join(cfg.watchlistDir, 'launchpads.scraped.yaml');
  fs.writeFileSync(out, `# generated by discover:factories on ${new Date().toISOString()} (network=${cfg.network.name}, chain ${cfg.network.chainId})\n` + stringify({ venues: report, todo }));
  console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
  if (todo.length) console.log('TODO:\n' + todo.map((t) => `  - ${t}`).join('\n'));
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
