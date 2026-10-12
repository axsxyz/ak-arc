import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { applyEnv } from '../../src/config/load-env.js';
import { loadWatchlists } from '../../src/config/watchlists.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return SKIP_DIRS.has(d.name) ? [] : walk(p);
    return [p];
  });
}
const rel = (p: string) => path.relative(ROOT, p).replaceAll('\\', '/');
const files = walk(ROOT);

describe('repo layout: runtime reads config/watchlists/ only', () => {
  it('default WATCHLIST_DIR is config/watchlists and it loads for both networks', () => {
    const cfg = loadConfig({}, { cwd: ROOT });
    expect(rel(cfg.watchlistDir)).toBe('config/watchlists');
    for (const net of ['testnet', 'mainnet'] as const) {
      const w = loadWatchlists(cfg.watchlistDir, net);
      expect(w.majors.length).toBeGreaterThan(0);
      expect(w.pads.length).toBeGreaterThan(0);
    }
  });

  it('no watchlist YAML outside config/watchlists/ (fixtures excepted); no legacy watchlists/ dir', () => {
    expect(fs.existsSync(path.join(ROOT, 'watchlists'))).toBe(false);
    const yamls = files.map(rel).filter((f) => /\.ya?ml$/.test(f));
    expect(yamls.filter((f) => !f.startsWith('config/watchlists/') && !/^fixtures\/watchlists(-[a-z]+)?\//.test(f))).toEqual([]);
  });
});

describe('repo layout: docs/ is never imported or read', () => {
  it('no source, test, or build file references docs/ or briefs', () => {
    const code = files.map(rel).filter((f) => /\.(ts|js|cjs|mjs|json)$/.test(f) || f === 'Dockerfile');
    const offenders = code.filter((f) => f !== 'test/unit/repo-layout.test.ts' && /docs\/|briefs|MASTER_PROMPT/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('runtime code never reads markdown', () => {
    const src = files.map(rel).filter((f) => f.startsWith('src/') && f.endsWith('.ts'));
    expect(src.filter((f) => /['"`][^'"`]*\.md['"`]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))).toEqual([]);
  });
});

describe('repo layout: secrets live in .env only', () => {
  const SECRET = [
    /quiknode\.pro\/[0-9a-f]{16,}/i, // QuickNode endpoint token
    /discord(?:app)?\.com\/api\/webhooks\/\d{10,}\/[A-Za-z0-9_-]{20,}/, // Discord webhook id/token
  ];
  it('no real RPC keys or webhook tokens in any file except .env', () => {
    const offenders = files
      .map(rel)
      .filter((f) => f !== '.env' && f !== 'package-lock.json')
      .filter((f) => {
        const buf = fs.readFileSync(path.join(ROOT, f));
        if (buf.includes(0)) return false; // binary
        const text = buf.toString('utf8');
        return SECRET.some((re) => re.test(text));
      });
    expect(offenders).toEqual([]);
  });
  it('env profiles (config/profiles/*.env) hold no secrets and never set kill-switches', () => {
    const profiles = files.map(rel).filter((f) => f.startsWith('config/profiles/'));
    expect(profiles.length).toBeGreaterThan(0);
    for (const f of profiles) {
      const keys = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[0]!);
      expect(keys.filter((k) => k.startsWith('DISCORD_WH_') || k === 'DISCORD_DRY_RUN' || k === 'ALERTS_PING_ENABLED'), f).toEqual([]);
    }
  });
  it('.env is gitignored and docker-ignored', () => {
    expect(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n')).toContain('.env');
    expect(fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n')).toContain('.env');
  });
});

describe('repo layout: the radar can never read packages/executor/.env (the repo\'s only signing key)', () => {
  it('no radar source, test, config or env file references the executor package or PRIVATE_KEY', () => {
    const code = files
      .map(rel)
      .filter((f) => /\.(ts|js|cjs|mjs|json|ya?ml|env)$/.test(f) || f === '.env' || f === 'Dockerfile')
      .filter((f) => f !== 'test/unit/repo-layout.test.ts' && f !== 'package-lock.json');
    const offenders = code.filter((f) => /packages\/executor|@ak-arc\/executor|\.\.\/executor\/|PRIVATE_KEY/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('env bootstrap only opens files under the radar package, never a sibling module\'s .env', () => {
    const opened: string[] = [];
    const env: NodeJS.ProcessEnv = { ARC_PROFILE: 'mainnet-poll' };
    applyEnv(env, ROOT, (p) => {
      opened.push(p);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
    });
    expect(opened.length).toBeGreaterThan(0);
    for (const p of opened) {
      expect(path.relative(ROOT, p).startsWith('..'), p).toBe(false);
      expect(p).not.toMatch(/[\\/]executor[\\/]/);
    }
    expect(env.PRIVATE_KEY).toBeUndefined();
  });
  it('radar config never carries a signing key even if one leaks into the process environment', () => {
    const leaked = 'deadbeef'.repeat(8);
    const cfg = loadConfig({ PRIVATE_KEY: leaked, ARC_NETWORK: 'testnet' }, { cwd: ROOT });
    expect(JSON.stringify(cfg)).not.toMatch(/PRIVATE_KEY|deadbeef/);
  });
});
