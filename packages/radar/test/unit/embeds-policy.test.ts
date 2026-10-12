import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../../src/config/networks.js';
import { buildEmbed, FIELD_POLICY } from '../../src/discord/embeds.js';
import type { Signal, SignalType } from '../../src/score/types.js';

const TOKEN = { symbol: 'X', address: '0xaaaa00000000000000000000000000000000a001' as const };
const TX = `0x${'ab'.repeat(32)}` as const;
const full = (type: SignalType, extra: Partial<Signal> = {}): Signal => ({
  type,
  channel: 'launchpads',
  severity: 'info',
  dedupeKey: 'k',
  eventTimeMs: 1_000_000,
  evidence: { usdCertain: true, trusted: true },
  token: TOKEN,
  venue: 'Pad',
  usd: 1000,
  velocity: 50,
  lp: 20000,
  mcap: 300000,
  txHash: TX,
  ...extra,
});
const names = (s: Signal) => buildEmbed(s, NETWORKS.mainnet, 1_002_000).fields.map((f) => f.name);

describe('compact embeds: fields per signal type (all values available)', () => {
  const expected: Partial<Record<SignalType, string[]>> = {
    LP_SURGE: ['token', 'venue/pad', 'usd', 'velocity', 'lp', 'mcap', 'tx', 'T+Xs'],
    LP_WATCH: ['token', 'venue/pad', 'usd', 'velocity', 'lp', 'mcap', 'tx', 'T+Xs'],
    LP_REMOVE: ['token', 'venue/pad', 'usd', 'lp', 'mcap', 'tx', 'T+Xs'],
    NEW_LAUNCH: ['token', 'venue/pad', 'usd', 'lp', 'mcap', 'tx', 'T+Xs'],
    PAD_GRADUATED: ['token', 'venue/pad', 'lp', 'mcap', 'tx', 'T+Xs'],
    PAD_MIGRATE_HOT: ['token', 'venue/pad', 'usd', 'velocity', 'lp', 'mcap', 'tx', 'T+Xs'],
    WATCHLIST_WALLET_FAST: ['token', 'venue/pad', 'usd', 'velocity', 'lp', 'mcap', 'tx', 'T+Xs'],
    WALLET_ACTIVITY: ['token', 'venue/pad', 'usd', 'velocity', 'lp', 'mcap', 'tx', 'T+Xs'],
    EARLY_BUYER_DENSITY: ['token', 'venue/pad', 'usd', 'mcap', 'tx', 'T+Xs'],
    FUNDER_CLUSTER: ['token', 'venue/pad', 'tx', 'T+Xs'],
    BRIDGE_FLOW: ['token', 'venue/pad', 'usd', 'tx', 'T+Xs'],
    BRIDGE_INFLOW: ['token', 'venue/pad', 'usd', 'tx', 'T+Xs'],
    BRIDGE_OUTFLOW: ['token', 'venue/pad', 'usd', 'tx', 'T+Xs'],
    BRIDGE_DEPLOY: ['token', 'venue/pad', 'usd', 'tx', 'T+Xs'],
    MAJOR_ANOMALY: ['token', 'venue/pad', 'usd', 'velocity', 'lp', 'mcap', 'tx', 'T+Xs'],
  };
  for (const [type, fields] of Object.entries(expected)) {
    it(type, () => expect(names(full(type as SignalType))).toEqual(fields));
  }
  it('every signal type has a policy', () => {
    const all: SignalType[] = [
      'LP_SURGE',
      'PAD_MIGRATE_HOT',
      'WATCHLIST_WALLET_FAST',
      'MAJOR_ANOMALY',
      'LP_WATCH',
      'LP_REMOVE',
      'NEW_LAUNCH',
      'PAD_GRADUATED',
      'WALLET_ACTIVITY',
      'EARLY_BUYER_DENSITY',
      'FUNDER_CLUSTER',
      'BRIDGE_FLOW',
      'BRIDGE_INFLOW',
      'BRIDGE_OUTFLOW',
      'BRIDGE_DEPLOY',
      'BRIDGE_NET_FLOW',
      'MISSING_ON_CHAIN',
      'MAJOR_DIGEST',
      'PAD_LEADERBOARD',
    ];
    expect(Object.keys(FIELD_POLICY).sort()).toEqual([...all].sort());
  });
});

describe('compact embeds: unknown values are omitted, never "n/a"', () => {
  it('pad_token_created with nothing computed → token, venue/pad, tx, T+Xs only', () => {
    expect(names(full('NEW_LAUNCH', { usd: undefined, velocity: undefined, lp: undefined, mcap: undefined }))).toEqual(['token', 'venue/pad', 'tx', 'T+Xs']);
  });
  it('swap alert without lp/mcap keeps usd + velocity', () => {
    expect(names(full('WATCHLIST_WALLET_FAST', { lp: undefined, mcap: undefined }))).toEqual(['token', 'venue/pad', 'usd', 'velocity', 'tx', 'T+Xs']);
  });
  it('NaN / Infinity are treated as unknown', () => {
    expect(names(full('LP_SURGE', { velocity: Infinity, mcap: NaN }))).toEqual(['token', 'venue/pad', 'usd', 'lp', 'tx', 'T+Xs']);
  });
  it('no alert embed contains "n/a" values', () => {
    const e = buildEmbed(full('MAJOR_ANOMALY', { lp: undefined, mcap: undefined, velocity: undefined, txHash: undefined }), NETWORKS.mainnet, 1_002_000);
    expect(e.fields.some((f) => f.value === 'n/a')).toBe(false);
  });
  it('usd-uncertain flag only when a USD number is shown', () => {
    expect(names(full('LP_WATCH', { evidence: { usdCertain: false, trusted: true } }))).toContain('confidence');
    expect(names(full('NEW_LAUNCH', { usd: undefined, evidence: { usdCertain: false, trusted: true } }))).not.toContain('confidence');
  });
  it('compact types render only their extra fields (digest keeps explicit n/a)', () => {
    const s = full('MAJOR_DIGEST', { compact: true, extraFields: [{ name: 'top10%', value: 'n/a' }] });
    expect(buildEmbed(s, NETWORKS.mainnet, 0).fields).toEqual([{ name: 'top10%', value: 'n/a' }]);
  });
});
