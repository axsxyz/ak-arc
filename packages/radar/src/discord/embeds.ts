import type { NetworkDef } from '../config/networks.js';
import type { Field, Severity, Signal } from '../score/types.js';

export interface Embed {
  title: string;
  description?: string;
  color: number;
  fields: Field[];
  footer: { text: string };
  timestamp: string;
  url?: string;
}

export interface WebhookPayload {
  username?: string;
  content?: string;
  embeds: Embed[];
  allowed_mentions: { parse: string[] };
}

export const COLORS: Record<Severity, number> = { info: 0x3498db, watch: 0xe67e22, alert: 0xe74c3c };

export const NA = 'n/a';

export function truncAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function fmtUsd(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return NA;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}k`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (abs === 0) return '$0';
  return `$${v.toPrecision(4)}`;
}

export function fmtPrice(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return NA;
  return v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(4)}`;
}

export function fmtPct(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) ? NA : `${(v * 100).toFixed(1)}%`;
}

export const txLink = (net: NetworkDef, hash: string) => `[${truncAddr(hash)}](${net.explorer}/tx/${hash})`;
export const tokenLink = (net: NetworkDef, addr: string, label?: string) =>
  `[${label ? `${label} ` : ''}${truncAddr(addr)}](${net.explorer}/token/${addr})`;
export const addrLink = (net: NetworkDef, addr: string, label?: string) =>
  `[${label ?? truncAddr(addr)}](${net.explorer}/address/${addr})`;

export type ContractField = 'token' | 'venue' | 'usd' | 'velocity' | 'lp' | 'mcap' | 'tx';

/**
 * Which contract fields CAN be known per signal type. A field is rendered only if it is in the policy AND its
 * value was actually computed — no "n/a" filler in alerts. `T+Xs` is always rendered for event signals.
 * Compact types (digests, leaderboard, probe) render only their own extraFields (MAJOR_DIGEST keeps explicit n/a).
 */
export const FIELD_POLICY: Record<Signal['type'], ContractField[] | 'compact'> = {
  LP_SURGE: ['token', 'venue', 'usd', 'velocity', 'lp', 'mcap', 'tx'],
  LP_WATCH: ['token', 'venue', 'usd', 'velocity', 'lp', 'mcap', 'tx'],
  LP_REMOVE: ['token', 'venue', 'usd', 'lp', 'mcap', 'tx'],
  NEW_LAUNCH: ['token', 'venue', 'usd', 'lp', 'mcap', 'tx'], // usd = initial buy when known; no velocity at birth
  PAD_GRADUATED: ['token', 'venue', 'lp', 'mcap', 'tx'],
  PAD_MIGRATE_HOT: ['token', 'venue', 'usd', 'velocity', 'lp', 'mcap', 'tx'],
  WATCHLIST_WALLET_FAST: ['token', 'venue', 'usd', 'velocity', 'lp', 'mcap', 'tx'],
  WALLET_ACTIVITY: ['token', 'venue', 'usd', 'velocity', 'lp', 'mcap', 'tx'],
  EARLY_BUYER_DENSITY: ['token', 'venue', 'usd', 'mcap', 'tx'],
  FUNDER_CLUSTER: ['token', 'venue', 'tx'],
  BRIDGE_FLOW: ['token', 'venue', 'usd', 'tx'],
  BRIDGE_INFLOW: ['token', 'venue', 'usd', 'tx'],
  BRIDGE_OUTFLOW: ['token', 'venue', 'usd', 'tx'],
  BRIDGE_DEPLOY: ['token', 'venue', 'usd', 'tx'],
  MAJOR_ANOMALY: ['token', 'venue', 'usd', 'velocity', 'lp', 'mcap', 'tx'],
  MISSING_ON_CHAIN: 'compact',
  MAJOR_DIGEST: 'compact',
  PAD_LEADERBOARD: 'compact',
  BRIDGE_NET_FLOW: 'compact',
};

const known = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/** Build the embed: title, policy-filtered contract fields (+ T+Xs), extra fields; color by severity; footer network. */
export function buildEmbed(s: Signal, net: NetworkDef, nowMs: number): Embed {
  const lagS = Math.max(0, (nowMs - s.eventTimeMs) / 1000);
  const policy = s.compact ? 'compact' : FIELD_POLICY[s.type];
  const fields: Field[] = [];
  if (policy !== 'compact') {
    const want = new Set(policy);
    if (want.has('token') && s.token) fields.push({ name: 'token', value: tokenLink(net, s.token.address, s.token.symbol), inline: true });
    if (want.has('venue') && s.venue) fields.push({ name: 'venue/pad', value: s.venue, inline: true });
    if (want.has('usd') && known(s.usd)) fields.push({ name: 'usd', value: fmtUsd(s.usd), inline: true });
    if (want.has('velocity') && known(s.velocity)) fields.push({ name: 'velocity', value: `${fmtUsd(s.velocity)}/min`, inline: true });
    if (want.has('lp') && known(s.lp)) fields.push({ name: 'lp', value: fmtUsd(s.lp), inline: true });
    if (want.has('mcap') && known(s.mcap)) fields.push({ name: 'mcap', value: fmtUsd(s.mcap), inline: true });
    if (want.has('tx') && s.txHash) fields.push({ name: 'tx', value: txLink(net, s.txHash), inline: true });
    fields.push({ name: 'T+Xs', value: `T+${lagS.toFixed(1)}s`, inline: true });
    // Only flag USD uncertainty when a USD number is actually shown.
    if (!s.evidence.usdCertain && known(s.usd)) fields.push({ name: 'confidence', value: 'usd uncertain (non-USDC pair)', inline: true });
  }
  if (s.extraFields) fields.push(...s.extraFields);
  if (net.name === 'testnet') fields.push({ name: 'data', value: 'testnet plumbing — not market intel', inline: false });
  return {
    title: s.title ?? s.type,
    description: s.description,
    color: COLORS[s.severity],
    fields: fields.slice(0, 25), // Discord max
    footer: { text: `${net.label} | radar v1` },
    timestamp: new Date(s.eventTimeMs).toISOString(),
    url: s.token ? `${net.explorer}/token/${s.token.address}` : undefined,
  };
}
