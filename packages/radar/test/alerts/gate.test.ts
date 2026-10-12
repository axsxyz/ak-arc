import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPayloadSafe, makePayload } from '../../src/discord/client.js';
import { decide } from '../../src/score/gate.js';
import type { Signal } from '../../src/score/types.js';

const sig = (o: Partial<Signal>): Signal => ({
  type: 'LP_SURGE',
  hardRule: 'LP_SURGE',
  channel: 'alerts',
  fallbackChannel: 'launchpads',
  severity: 'alert',
  dedupeKey: 'k',
  eventTimeMs: 0,
  evidence: { usdCertain: true, trusted: true },
  ...o,
});

describe('ping gate', () => {
  it('hard rule + certain + trusted → ping', () => {
    expect(decide(sig({}), true)).toMatchObject({ channel: 'alerts', ping_everyone: true });
  });
  it('kill-switch ALERTS_PING_ENABLED=0 → alerts without ping', () => {
    expect(decide(sig({}), false)).toMatchObject({ channel: 'alerts', ping_everyone: false });
  });
  it('uncertain USD or untrusted pool → fallback, no ping', () => {
    expect(decide(sig({ evidence: { usdCertain: false, trusted: true } }), true)).toMatchObject({ channel: 'launchpads', ping_everyone: false });
    expect(decide(sig({ evidence: { usdCertain: true, trusted: false } }), true)).toMatchObject({ channel: 'launchpads', ping_everyone: false });
  });
  it('non-hard-rule in #alerts is refused unless whitelisted no-ping type', () => {
    expect(decide(sig({ type: 'LP_WATCH', hardRule: undefined }), true)).toMatchObject({ channel: 'launchpads', ping_everyone: false });
    expect(decide(sig({ type: 'MISSING_ON_CHAIN', hardRule: undefined }), true)).toMatchObject({ channel: 'alerts', ping_everyone: false });
    expect(decide(sig({ type: 'EARLY_BUYER_DENSITY', hardRule: 'LP_SURGE' }), true)).toMatchObject({ ping_everyone: false });
  });
  it('specialty channels never ping', () => {
    expect(decide(sig({ channel: 'major-coins' }), true).ping_everyone).toBe(false);
  });
  it('payload builder refuses ping outside #alerts; sink assertion catches forged payloads', () => {
    const embed = { title: 't', color: 0, fields: [], footer: { text: '' }, timestamp: '' };
    expect(() => makePayload('launchpads', embed, { channel: 'launchpads', ping_everyone: true, reason: '' }, 'Arc Radar')).toThrow(/P0/);
    expect(() =>
      assertPayloadSafe({ channel: 'smart-flow', payload: { username: 'x', content: '@everyone', embeds: [], allowed_mentions: { parse: [] } } }),
    ).toThrow(/P0/);
  });
});

describe('static: no @everyone outside the alerts scorer', () => {
  const root = path.resolve(import.meta.dirname, '../../src');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []));
  const rel = (f: string) => path.relative(root, f).replaceAll('\\', '/');
  it('"@everyone" literal only in discord/client.ts (payload) and score/gate.ts (doc)', () => {
    const hits = files(root).filter((f) => fs.readFileSync(f, 'utf8').includes('@everyone')).map(rel).sort();
    expect(hits.filter((h) => !['discord/client.ts', 'score/gate.ts', 'tools/webhooks-dry.ts'].includes(h))).toEqual([]);
  });
  it('ping_everyone: true is only ever produced by score/gate.ts', () => {
    const hits = files(root)
      .filter((f) => /ping_everyone\s*:\s*true/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    expect(hits).toEqual(['score/gate.ts']);
  });
});
