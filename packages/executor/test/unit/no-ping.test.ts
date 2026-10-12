import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '../../src');
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []));

describe('static: this module never pings', () => {
  const texts = files(SRC).map((f) => [path.relative(SRC, f), fs.readFileSync(f, 'utf8')] as const);
  it('no @everyone / @here / role mention / ping_everyone anywhere in src', () => {
    const bad = ['@everyone', '@here', 'ping_everyone', '<@&', 'allowed_mentions: { parse: [\'everyone\'] }'];
    const hits = texts.filter(([, t]) => bad.some((b) => t.includes(b))).map(([f]) => f);
    expect(hits).toEqual([]);
  });
  it('every allowed_mentions literal is the empty parse list', () => {
    for (const [f, t] of texts) {
      for (const m of t.matchAll(/allowed_mentions:\s*\{[^}]*}/g)) expect(m[0], f).toMatch(/parse:\s*\[\]/);
    }
  });
  it('only config.ts reads process.env', () => {
    const hits = texts.filter(([f, t]) => f !== 'config.ts' && /process\.env/.test(t)).map(([f]) => f);
    expect(hits).toEqual([]);
  });
  it('no eth_getTransactionCount outside NonceTracker.init (chain.ts)', () => {
    const hits = texts.filter(([f, t]) => f !== 'chain.ts' && /getTransactionCount/.test(t)).map(([f]) => f);
    expect(hits).toEqual([]);
  });
});
