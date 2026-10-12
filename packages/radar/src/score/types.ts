import type { Address, Hex } from 'viem';
import type { Channel } from '../config/env.js';

/** The ONLY four conditions allowed to ping. */
export type HardRule = 'LP_SURGE' | 'PAD_MIGRATE_HOT' | 'WATCHLIST_WALLET_FAST' | 'MAJOR_ANOMALY';

export type SignalType =
  | HardRule
  | 'LP_WATCH'
  | 'LP_REMOVE'
  | 'NEW_LAUNCH'
  | 'PAD_GRADUATED'
  | 'WALLET_ACTIVITY'
  | 'EARLY_BUYER_DENSITY'
  | 'FUNDER_CLUSTER'
  | 'BRIDGE_FLOW'
  | 'BRIDGE_INFLOW'
  | 'BRIDGE_OUTFLOW'
  | 'BRIDGE_DEPLOY'
  | 'BRIDGE_NET_FLOW'
  | 'MISSING_ON_CHAIN'
  | 'MAJOR_DIGEST'
  | 'PAD_LEADERBOARD';

export type Severity = 'info' | 'watch' | 'alert';

export interface Field {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Signal {
  type: SignalType;
  /** Channel the scorer wants; the gate may downgrade. */
  channel: Channel;
  /** Where to go if the gate refuses an #alerts post. undefined = logs only. */
  fallbackChannel?: Channel;
  severity: Severity;
  dedupeKey: string;
  /** Event (block) time, ms. Dedupe windows and T+Xs use this. */
  eventTimeMs: number;
  hardRule?: HardRule;
  evidence: {
    /** USD value derived from the USDC mirror side of a pool (not a token/token guess). */
    usdCertain: boolean;
    /** Pool/pad provenance proven against an allowlisted factory. */
    trusted: boolean;
    notes?: string[];
  };
  token?: { symbol?: string; address: Address };
  /** Pool (or bonding curve) the signal is about. Cold-path scoring only (paper fills); never rendered. */
  pool?: Address;
  venue?: string;
  usd?: number;
  velocity?: number;
  lp?: number;
  mcap?: number;
  txHash?: Hex;
  title?: string;
  description?: string;
  extraFields?: Field[];
  /** Suppress generic contract fields (digests/leaderboards/probe use extraFields only). */
  compact?: boolean;
}
