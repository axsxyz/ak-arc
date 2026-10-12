import path from 'node:path';
import { z } from 'zod';
import type { Address } from 'viem';
import { NETWORKS, type NetworkDef } from './networks.js';

export type Channel = 'smart-flow' | 'major-coins' | 'launchpads' | 'alerts';
export const CHANNELS: Channel[] = ['smart-flow', 'major-coins', 'launchpads', 'alerts'];

export class ConfigError extends Error {}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === '1' || v.toLowerCase() === 'true'));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a number: ${v}` });
        return z.NEVER;
      }
      return n;
    });
const str = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const schema = z.object({
  ARC_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  ARC_CHAIN_ID: str,
  ARC_HTTP_URL: str,
  ARC_WSS_URL: str,
  ARC_TESTNET_HTTP_URL: str,
  ARC_TESTNET_WSS_URL: str,
  ARC_MAINNET_HTTP_URL: str,
  ARC_MAINNET_WSS_URL: str,

  DISCORD_WH_SMART_FLOW: str,
  DISCORD_WH_MAJOR_COINS: str,
  DISCORD_WH_LAUNCHPADS: str,
  DISCORD_WH_ALERTS: str,
  DISCORD_DRY_RUN: bool(true), // safe default: nothing leaves the box unless explicitly set to 0
  DISCORD_USERNAME: str, // unset by default: let each webhook use the name/avatar configured for it on Discord
  ALERTS_PING_ENABLED: bool(true),

  // ---- Tunable alert thresholds (operator recalibrates) ----
  ALERT_LP_USD: num(50_000), // LP_SURGE: net USDC added (testnet-tune lower, e.g. 5000)
  ALERT_LP_WINDOW_SEC: num(120),
  ALERT_MIGRATE_VOL_USD: num(10_000), // PAD_MIGRATE_HOT: post-migrate USDC vol
  ALERT_MIGRATE_WINDOW_SEC: num(300),
  ALERT_WALLET_AGE_SEC: num(120), // WATCHLIST_WALLET_FAST: max pool age at buy
  ALERT_WALLET_BUY_USD: num(500),
  ALERT_ANOMALY_Z: num(5), // MAJOR_ANOMALY: 5m vol z-score vs 1h baseline
  ALERT_ANOMALY_PCT: num(100), // MAJOR_ANOMALY: |price Δ| % vs 1h baseline
  ALERT_ANOMALY_MIN_SAMPLES: num(30), // minutes of history before z-score is trusted
  ALERT_ANOMALY_MIN_VOL_USD: num(1_000), // ignore z-spikes on dust volume
  ALERT_ANOMALY_COOLDOWN_SEC: num(900), // don't re-fire the same major anomaly for 15 min
  ALERT_LP_WATCH_USD: num(10_000), // below LP_SURGE but worth a specialty-channel post (no ping)
  EARLY_BUYER_BLOCKS: num(20), // "first M blocks" after pool birth (~10s on Arc)
  EARLY_BUYER_MIN_COUNT: num(8), // N unique buyers in those blocks
  CLUSTER_MIN_WALLETS: num(3), // fresh wallets sharing one funder
  PAD_TIME_TO_USD: num(69_000), // "median time-to-$X" mark
  BRIDGE_FLOW_USD: num(25_000), // bridge in/out -> #smart-flow
  ALERT_BRIDGE_USD: num(250_000), // bridge in/out -> #alerts (never pings)
  BRIDGE_FOLLOW_MIN_USD: num(10_000), // BRIDGE_DEPLOY: only watch wallets that arrived with at least this much
  BRIDGE_FOLLOW_MINUTES: num(30), // BRIDGE_DEPLOY: how long after arrival a swap still counts as "deploying the bridged capital"
  DEDUPE_SEC: num(60),

  MAJOR_DIGEST_SEC: num(300),
  MAJOR_PRICE_MIN_LP_USD: num(1000), // a major's price only follows its deepest trusted pool, and only if it holds >= this much USDC
  MAJOR_DEPTH_REFRESH_SEC: num(300), // how often pool USDC depths (price source selection) are refreshed
  PAD_LEADERBOARD_SEC: num(3600),
  BRIDGE_DIGEST_SEC: num(300), // BRIDGE_NET_FLOW: rolling 5m/1h in/out/net digest cadence; skipped when both windows are flat

  // ---- Edge scorecard (paper only; never affects posting or pings) ----
  PAPER_LATENCY_MS: num(3000), // paper entry = first print at/after fire + this latency
  PAPER_SIZE_USD: num(500), // paper trade size for the impact estimate: size / (2 * pool USDC depth)

  RPC_GETLOGS_MAX_RANGE: num(5), // QuickNode Discover plan limit
  ALLOW_MAINNET_HTTP_POLLING: bool(false), // opt-in: run the live bot on mainnet via HTTP polling (no WSS)
  POLL_INTERVAL_MS: num(1000), // HTTP polling cadence (no-WSS mode)
  WARM_START_HOURS: num(0), // replay last N hours on boot with Discord muted (0 = off)
  ARC_PROFILE: str,
  // ---- Holder backfill (major digests: holders≈ / top10%) — background job, off the alert hot path ----
  HOLDERS_BACKFILL: bool(true),
  HOLDERS_RPC_URL: str, // optional separate HTTP RPC for the job (default: the main HTTP RPC)
  HOLDERS_RPC_MAX_RPS: num(2),
  HOLDERS_BACKFILL_RANGE: num(10_000), // rpc.arc-scan.org getLogs cap is 10,000 blocks; failures auto-split
  HOLDERS_BACKFILL_MAX_BLOCKS: num(30_000_000), // cap history depth (~174 days on Arc); beyond -> partial, top10% n/a
  HOLDERS_SYNC_SEC: num(60),
  HOLDERS_CHECKPOINT_SEC: num(120),
  RPC_MAX_RPS: num(10),
  BACKFILL_MAX_BLOCKS: num(2400),
  HEAD_STALL_SEC: num(30),

  ALLOW_EMPTY_CHAIN: bool(false),
  DB_PATH: z.string().default('data/radar.sqlite'),
  WATCHLIST_DIR: z.string().default('config/watchlists'), // runtime watchlists live ONLY here
  LOG_LEVEL: z.string().default('info'),
});

export interface Thresholds {
  lpUsd: number;
  lpWindowSec: number;
  migrateVolUsd: number;
  migrateWindowSec: number;
  walletAgeSec: number;
  walletBuyUsd: number;
  anomalyZ: number;
  anomalyPct: number;
  anomalyMinSamples: number;
  anomalyMinVolUsd: number;
  anomalyCooldownSec: number;
  lpWatchUsd: number;
  earlyBuyerBlocks: number;
  earlyBuyerMinCount: number;
  clusterMinWallets: number;
  padTimeToUsd: number;
  bridgeFlowUsd: number;
  alertBridgeUsd: number;
  bridgeFollowMinUsd: number;
  bridgeFollowMinutes: number;
  dedupeSec: number;
}

export interface Config {
  network: NetworkDef;
  httpUrl?: string;
  wssUrl?: string;
  usdcMirror: Address;
  webhooks: Partial<Record<Channel, string>>;
  discordDryRun: boolean;
  discordUsername?: string;
  pingEnabled: boolean;
  thresholds: Thresholds;
  majorDigestSec: number;
  majorPriceMinLpUsd: number;
  majorDepthRefreshSec: number;
  padLeaderboardSec: number;
  bridgeDigestSec: number;
  paper: { latencyMs: number; sizeUsd: number };
  rpc: { getLogsMaxRange: number; maxRps: number; backfillMaxBlocks: number; headStallSec: number; pollIntervalMs: number };
  allowMainnetHttpPolling: boolean;
  holders: { enabled: boolean; rpcUrl?: string; maxRps: number; range: number; maxBlocks: number; syncSec: number; checkpointSec: number };
  warmStartHours: number;
  profile?: string;
  allowEmptyChain: boolean;
  dbPath: string;
  watchlistDir: string;
  logLevel: string;
}

export interface LoadOpts {
  /** Fail if no RPC URL resolves for the selected network (true for runtime + probe). */
  requireRpc?: boolean;
  /**
   * Live bot only: mainnet needs a WSS endpoint (newHeads/logs subscriptions). HTTP-only public RPCs such as
   * https://rpc.arc-scan.org are fine for probe/discovery tools but are refused for 24/7 ingest.
   */
  requireWssOnMainnet?: boolean;
  cwd?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadOpts = {}): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid env: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const network = NETWORKS[e.ARC_NETWORK];

  if (e.ARC_CHAIN_ID !== undefined && Number(e.ARC_CHAIN_ID) !== network.chainId) {
    throw new ConfigError(
      `ARC_CHAIN_ID=${e.ARC_CHAIN_ID} does not match ARC_NETWORK=${network.name} (expected ${network.chainId}).`,
    );
  }

  const perNet =
    network.name === 'mainnet'
      ? { http: e.ARC_MAINNET_HTTP_URL, wss: e.ARC_MAINNET_WSS_URL }
      : { http: e.ARC_TESTNET_HTTP_URL, wss: e.ARC_TESTNET_WSS_URL };
  const httpUrl = e.ARC_HTTP_URL ?? perNet.http;
  const wssUrl = e.ARC_WSS_URL ?? perNet.wss;

  if (opts.requireRpc && !httpUrl) {
    throw new ConfigError(
      network.name === 'mainnet'
        ? 'ARC_NETWORK=mainnet but no RPC configured: attach QuickNode Arc Mainnet endpoint via ARC_MAINNET_HTTP_URL / ARC_MAINNET_WSS_URL.'
        : 'ARC_NETWORK=testnet but ARC_TESTNET_HTTP_URL (or ARC_HTTP_URL) is empty.',
    );
  }

  if (opts.requireWssOnMainnet && network.name === 'mainnet' && !wssUrl && !e.ALLOW_MAINNET_HTTP_POLLING) {
    throw new ConfigError(
      'ARC_NETWORK=mainnet live bot requires ARC_MAINNET_WSS_URL (e.g. QuickNode Arc Mainnet wss). ' +
        'An HTTP-only RPC (like https://rpc.arc-scan.org) is supported for test:chain-probe / discover:* only — ' +
        'or opt in to ~2-3s-lag HTTP polling with ALLOW_MAINNET_HTTP_POLLING=1 (profile: ARC_PROFILE=mainnet-poll).',
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  return {
    network,
    httpUrl,
    wssUrl,
    usdcMirror: network.usdcMirror,
    webhooks: {
      'smart-flow': e.DISCORD_WH_SMART_FLOW,
      'major-coins': e.DISCORD_WH_MAJOR_COINS,
      launchpads: e.DISCORD_WH_LAUNCHPADS,
      alerts: e.DISCORD_WH_ALERTS,
    },
    discordDryRun: e.DISCORD_DRY_RUN,
    discordUsername: e.DISCORD_USERNAME,
    pingEnabled: e.ALERTS_PING_ENABLED,
    thresholds: {
      lpUsd: e.ALERT_LP_USD,
      lpWindowSec: e.ALERT_LP_WINDOW_SEC,
      migrateVolUsd: e.ALERT_MIGRATE_VOL_USD,
      migrateWindowSec: e.ALERT_MIGRATE_WINDOW_SEC,
      walletAgeSec: e.ALERT_WALLET_AGE_SEC,
      walletBuyUsd: e.ALERT_WALLET_BUY_USD,
      anomalyZ: e.ALERT_ANOMALY_Z,
      anomalyPct: e.ALERT_ANOMALY_PCT,
      anomalyMinSamples: e.ALERT_ANOMALY_MIN_SAMPLES,
      anomalyMinVolUsd: e.ALERT_ANOMALY_MIN_VOL_USD,
      anomalyCooldownSec: e.ALERT_ANOMALY_COOLDOWN_SEC,
      lpWatchUsd: e.ALERT_LP_WATCH_USD,
      earlyBuyerBlocks: e.EARLY_BUYER_BLOCKS,
      earlyBuyerMinCount: e.EARLY_BUYER_MIN_COUNT,
      clusterMinWallets: e.CLUSTER_MIN_WALLETS,
      padTimeToUsd: e.PAD_TIME_TO_USD,
      bridgeFlowUsd: e.BRIDGE_FLOW_USD,
      alertBridgeUsd: e.ALERT_BRIDGE_USD,
      bridgeFollowMinUsd: e.BRIDGE_FOLLOW_MIN_USD,
      bridgeFollowMinutes: e.BRIDGE_FOLLOW_MINUTES,
      dedupeSec: e.DEDUPE_SEC,
    },
    majorDigestSec: e.MAJOR_DIGEST_SEC,
    majorPriceMinLpUsd: e.MAJOR_PRICE_MIN_LP_USD,
    majorDepthRefreshSec: Math.max(30, e.MAJOR_DEPTH_REFRESH_SEC),
    padLeaderboardSec: e.PAD_LEADERBOARD_SEC,
    bridgeDigestSec: e.BRIDGE_DIGEST_SEC,
    paper: { latencyMs: Math.max(0, e.PAPER_LATENCY_MS), sizeUsd: Math.max(1, e.PAPER_SIZE_USD) },
    rpc: {
      getLogsMaxRange: Math.max(1, Math.floor(e.RPC_GETLOGS_MAX_RANGE)),
      maxRps: Math.max(1, e.RPC_MAX_RPS),
      backfillMaxBlocks: e.BACKFILL_MAX_BLOCKS,
      headStallSec: e.HEAD_STALL_SEC,
      pollIntervalMs: Math.max(200, e.POLL_INTERVAL_MS),
    },
    allowMainnetHttpPolling: e.ALLOW_MAINNET_HTTP_POLLING,
    holders: {
      enabled: e.HOLDERS_BACKFILL,
      rpcUrl: e.HOLDERS_RPC_URL,
      maxRps: Math.max(0.2, e.HOLDERS_RPC_MAX_RPS),
      range: Math.max(1, Math.floor(e.HOLDERS_BACKFILL_RANGE)),
      maxBlocks: Math.max(0, Math.floor(e.HOLDERS_BACKFILL_MAX_BLOCKS)),
      syncSec: Math.max(5, e.HOLDERS_SYNC_SEC),
      checkpointSec: Math.max(5, e.HOLDERS_CHECKPOINT_SEC),
    },
    warmStartHours: Math.max(0, e.WARM_START_HOURS),
    profile: e.ARC_PROFILE,
    allowEmptyChain: e.ALLOW_EMPTY_CHAIN,
    dbPath: path.resolve(cwd, e.DB_PATH),
    watchlistDir: path.resolve(cwd, e.WATCHLIST_DIR),
    logLevel: e.LOG_LEVEL,
  };
}
