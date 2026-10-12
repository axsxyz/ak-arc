/**
 * config — the only module that reads process.env, .env and config/executor.json.
 *
 * Split by secrecy (hard rule, see README):
 *   .env                 secrets + kill-switches only
 *   config/executor.json   everything else, never a URL, key or kill-switch
 *
 * Precedence: CLI flag > env > json > built-in default.
 * `printConfig` renders the resolved effective config with secrets redacted;
 * every entrypoint prints it before anything is signed.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

export const EVENTS = [
  'bridge.burn_sent',
  'bridge.attestation_pending',
  'bridge.attestation_complete',
  'bridge.downgrade_detected',
  'bridge.mint_complete',
  'trade.preflight',
  'trade.fill',
  'trade.sell',
  'error.abort',
] as const;
export type EventName = (typeof EVENTS)[number];

export class ConfigError extends Error {}

// ── json schema ─────────────────────────────────────────────────────────

const lcAddr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'not an address')
  .transform((a) => a.toLowerCase() as Address);

const tokenOverride = z
  .object({
    minPoolDepthUsd: z.number().positive().optional(),
    expectedFeeTier: z.number().int().positive().optional(),
    /** Verified pool address. When set, buy/sell skip discovery and ASSERT this pool (factory, tokens, fee, depth); a mismatch aborts, never falls back. */
    pool: lcAddr.optional(),
    /** sell.ts multi-position TUI: per-token slippage, falling back to sell.slippageBps. --slippage-bps overrides every position for the session regardless. */
    slippageBps: z.number().int().min(1).max(9999).optional(),
    /** sell.ts multi-position TUI: per-token hotkey→percent map, falling back to sell.hotkeys. */
    hotkeys: z.record(z.string().regex(/^[0-9]$/), z.number().int().min(1).max(100)).optional(),
  })
  .strict();

const jsonSchema = z
  .object({
    route: z
      .object({
        baseDomain: z.number().int().nonnegative().default(6),
        arcDomain: z.number().int().nonnegative().default(26),
        baseChainId: z.number().int().positive().default(8453),
        arcChainId: z.number().int().positive().default(5042),
        minFinalityThreshold: z.number().int().positive().default(1000),
        maxFeeMargin: z.number().int().positive().default(3),
      })
      .strict()
      .prefault({}),
    trade: z
      .object({
        targetToken: lcAddr,
        router: lcAddr,
        factories: z.array(lcAddr).min(1),
        feeTiers: z.array(z.number().int().positive()).min(1).default([100, 500, 3000, 10000]),
        defaultMinPoolDepthUsd: z.number().positive().default(2000),
        /** Deepest tier must be at least this many times deeper than the runner-up, else liquidity is split: abort. */
        dominanceRatio: z.number().min(1).default(20),
        /** Fat-finger cap on --amount. Not an impact guard: impact is informational, never blocking. */
        maxNotionalUsd: z.number().positive().default(25_000),
        slippageBps: z.number().int().min(1).max(9999).default(300),
        deadlineSec: z.number().int().positive().default(60),
        /** Approve the bought token to the router right after the fill (same nonce counter), so the exit path never contains an approve. */
        approveOnFill: z.boolean().default(true),
        tokens: z.record(z.string().regex(/^0x[0-9a-fA-F]{40}$/), tokenOverride).default({}),
      })
      .strict(),
    sell: z
      .object({
        hotkeys: z.record(z.string().regex(/^[0-9]$/), z.number().int().min(1).max(100)),
        /** null = informational only (operator owns price decisions). A number refuses tiers whose modelled round-trip bps exceed it. */
        perTierMaxImpactBps: z.number().int().positive().nullable().default(null),
        confirmAbovePercent: z.number().int().min(0).max(100).default(100),
        slippageBps: z.number().int().min(1).max(9999).default(300),
      })
      .strict(),
    timing: z
      .object({
        attestationPollMs: z.number().int().min(250).default(2000),
        attestationTimeoutSec: z.number().int().positive().default(1200),
        statePollMs: z.number().int().min(250).default(1000),
        receiptTimeoutSec: z.number().int().positive().default(90),
        fastTransferTargetMs: z.number().int().positive().default(30_000),
      })
      .strict()
      .prefault({}),
    gas: z
      .object({
        arcMaxFeePerGasGwei: z.number().positive().default(30),
        arcPriorityFeeGwei: z.number().nonnegative().default(1),
        /** Gas floor: never spend the USDC that funds the exit. Reserve = reserveTxCount × reserveGasPerTx × maxFeePerGas. */
        reserveTxCount: z.number().int().nonnegative().default(6),
        reserveGasPerTx: z.number().int().positive().default(300_000),
      })
      .strict()
      .prefault({}),
    notify: z.partialRecord(z.enum(EVENTS), z.boolean()).prefault({}),
  })
  .strict();

export type ExecutorJson = z.infer<typeof jsonSchema>;

// ── secrets scan (runs on the raw JSON, before zod) ─────────────────────

const URL_SHAPED = /^[a-z][a-z0-9+.-]*:\/\//i;
const KEY_SHAPED = /^(0x)?[0-9a-fA-F]{64}$/;
const KILL_SWITCH_KEYS = /^(EXECUTION_DRY_RUN|DISCORD_DRY_RUN|dryRun|dry_run|live|LIVE|killSwitch|ALLOW_LIVE)$/;

/** Throws ConfigError naming the failing path if a URL, a 64-hex key or a kill-switch appears anywhere. */
export function assertNoSecretsInJson(v: unknown, at = 'executor.json'): void {
  if (typeof v === 'string') {
    if (URL_SHAPED.test(v)) throw new ConfigError(`${at}: URL-shaped value in JSON config (URLs belong in .env)`);
    if (KEY_SHAPED.test(v)) throw new ConfigError(`${at}: private-key-shaped value in JSON config`);
    if (/discord(?:app)?\.com\/api\/webhooks/i.test(v)) throw new ConfigError(`${at}: webhook in JSON config`);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertNoSecretsInJson(x, `${at}[${i}]`));
    return;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (KILL_SWITCH_KEYS.test(k)) throw new ConfigError(`${at}.${k}: kill-switches live in .env or on the CLI, never in JSON`);
      assertNoSecretsInJson(x, `${at}.${k}`);
    }
  }
}

// ── env ─────────────────────────────────────────────────────────────────

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : v === '1' || v.toLowerCase() === 'true'));
const str = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const envSchema = z.object({
  PRIVATE_KEY: str,
  BASE_RPC_URL: str,
  /** Comma-separated list; the first is used first, the rest are failover (see rpc-pool.ts). */
  ARC_MAINNET_HTTP_URL: str,
  ARC_MAINNET_WSS_URL: str,
  /** Rotate to the next endpoint after this many consecutive transport failures (default 3). */
  ARC_RPC_ROTATE_AFTER: str,
  /** Reader rate for the Arc HTTP RPC. Public rpc.arc-scan.org throttles above ~5; a private endpoint takes 50+. */
  ARC_RPC_MAX_RPS: str,
  /** Base backoff (ms) for transient RPC errors in the reader; 6 attempts, doubling. */
  ARC_RPC_RETRY_BASE_MS: str,
  IRIS_API_URL: str,
  DISCORD_WH_EXECUTOR: str,
  DISCORD_DRY_RUN: bool(true),
  EXECUTION_DRY_RUN: bool(true),
  /** sell.ts multi-position TUI: comma-separated extra token addresses to include as positions, beyond trade.targetToken and trade.tokens' keys. */
  EXTRA_TOKENS: str,
});

// ── cli ─────────────────────────────────────────────────────────────────

export interface Cli {
  live: boolean;
  discordLive: boolean;
  /** Shorthand: sets both bridgeAmount and buyAmount to the same value. Mutually exclusive with either of them. */
  amount?: string;
  /** run: USDC to burn on Base. Ignored with --prefunded. */
  bridgeAmount?: string;
  /** run/buy: USDC to spend on the swap. Must be <= the amount actually minted on Arc. */
  buyAmount?: string;
  burnTx?: Hex;
  token?: Address;
  /** bridge-out: mintRecipient override on Base. Defaults to the wallet's own address. */
  to?: Address;
  slippageBps?: number;
  prefunded: boolean;
  /** sell: USDC spent on the position, for unrealised PnL. */
  costUsdc?: string;
  /** sell: tokens received at fill, the fixed entry anchor (else the balance at TUI start). */
  entryTokens?: string;
  /** --verbose: print the full resolved config instead of the 3-line summary. */
  verbose: boolean;
  /** --rps: Arc reader rate for this run (beats ARC_RPC_MAX_RPS). */
  rps?: number;
  rest: string[];
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new ConfigError(`${name} needs a value`);
  return v;
}

const VALUE_FLAGS = ['--amount', '--bridge-amount', '--buy-amount', '--burn-tx', '--token', '--to', '--slippage-bps', '--cost-usdc', '--entry-tokens', '--rps'];
const NPM_SWALLOWABLE = /^npm_config_(live|discord_live|prefunded|dry_run|verbose|amount|bridge_amount|buy_amount|burn_tx|token|to|slippage_bps|cost_usdc|entry_tokens|rps)$/;

export const NPM_MESSAGE = 'Run with npx tsx src/<stage>.ts — npm scripts are not supported.';

/**
 * npm's run-script rewrites option-shaped arguments into its own config,
 * even after `--`. There is no npm-script form that reliably delivers flags,
 * so a run launched that way is refused outright. `npx tsx …` is the
 * supported form: npx also sets npm_lifecycle_event (to "npx") but passes
 * every argument after the command through untouched, so it is allowed.
 * (`env` is only read for this detection.)
 */
export function parseArgv(argv: string[], env: NodeJS.ProcessEnv = {}): Cli {
  const viaNpmRun = env.npm_command === 'run-script' || (env.npm_lifecycle_event !== undefined && env.npm_lifecycle_event !== 'npx');
  const viaNpm = viaNpmRun || Object.entries(env).some(([k, v]) => NPM_SWALLOWABLE.test(k) && v === 'true');
  if (viaNpm) throw new ConfigError(NPM_MESSAGE);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(argv[i - 1]!)));
  if (positional.length) throw new ConfigError(`unexpected positional argument(s): ${positional.join(' ')}`);
  const known = new Set(['--live', '--discord-live', '--prefunded', '--dry-run', '--verbose', '--amount', '--bridge-amount', '--buy-amount', '--burn-tx', '--token', '--to', '--slippage-bps', '--cost-usdc', '--entry-tokens', '--rps']);
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    if (!known.has(a)) rest.push(a);
    else if (VALUE_FLAGS.includes(a)) i += 1;
  }
  if (rest.length) throw new ConfigError(`unknown flag(s): ${rest.join(' ')}`);
  const burnTx = flagValue(argv, '--burn-tx');
  if (burnTx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(burnTx)) throw new ConfigError('malformed --burn-tx');
  const token = flagValue(argv, '--token');
  if (token !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new ConfigError('malformed --token');
  const to = flagValue(argv, '--to');
  if (to !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new ConfigError('malformed --to');
  const slip = flagValue(argv, '--slippage-bps');
  const slippageBps = slip === undefined ? undefined : Number(slip);
  if (slippageBps !== undefined && !(Number.isInteger(slippageBps) && slippageBps >= 1 && slippageBps <= 9999)) {
    throw new ConfigError('--slippage-bps must be an integer in 1..9999');
  }
  const rpsArg = flagValue(argv, '--rps');
  const rps = rpsArg === undefined ? undefined : parseRps(rpsArg, '--rps');
  for (const f of ['--amount', '--bridge-amount', '--buy-amount', '--cost-usdc'] as const) {
    const v = flagValue(argv, f);
    if (v !== undefined && !/^\d+(\.\d{1,6})?$/.test(v)) throw new ConfigError(`${f} must be a decimal USDC amount (max 6 decimals)`);
  }
  const entryTokens = flagValue(argv, '--entry-tokens');
  if (entryTokens !== undefined && !(/^\d+(\.\d+)?$/.test(entryTokens) && Number(entryTokens) > 0)) throw new ConfigError('--entry-tokens must be a positive decimal token amount');
  return {
    live: argv.includes('--live') && !argv.includes('--dry-run'),
    discordLive: argv.includes('--discord-live'),
    amount: flagValue(argv, '--amount'),
    bridgeAmount: flagValue(argv, '--bridge-amount'),
    buyAmount: flagValue(argv, '--buy-amount'),
    burnTx: burnTx as Hex | undefined,
    token: token?.toLowerCase() as Address | undefined,
    to: to?.toLowerCase() as Address | undefined,
    slippageBps,
    prefunded: argv.includes('--prefunded'),
    verbose: argv.includes('--verbose'),
    costUsdc: flagValue(argv, '--cost-usdc'),
    entryTokens,
    rps,
    rest,
  };
}

function parseIntIn(v: string, at: string, lo: number, hi: number): number {
  const n = Number(v);
  if (!(Number.isInteger(n) && n >= lo && n <= hi)) throw new ConfigError(`${at} must be an integer in ${lo}..${hi} (got ${v})`);
  return n;
}

function parseRps(v: string, at: string): number {
  const n = Number(v);
  if (!(Number.isInteger(n) && n >= 1 && n <= 200)) throw new ConfigError(`${at} must be an integer in 1..200 (got ${v})`);
  return n;
}

// ── resolved config ─────────────────────────────────────────────────────

export interface Config {
  /** EXECUTION_DRY_RUN=0 or --live. Default: dry run. */
  live: boolean;
  discordDryRun: boolean;
  privateKey: Hex;
  baseRpcUrl: string;
  /** Failover list, first = primary. */
  arcHttpUrls: string[];
  /** Primary endpoint (arcHttpUrls[0]); the pool decides the active one at runtime. */
  arcHttpUrl: string;
  arcWssUrl?: string;
  arcRpcRotateAfter: number;
  /** Arc reader rate, requests per second. CLI --rps > ARC_RPC_MAX_RPS > 5. */
  arcRpcMaxRps: number;
  arcRpcRetryBaseMs: number;
  irisUrl: string;
  webhook?: string;
  /** sell.ts multi-position TUI: extra position candidates from EXTRA_TOKENS, beyond trade.targetToken and trade.tokens' keys. */
  extraTokens: Address[];
  route: ExecutorJson['route'];
  trade: ExecutorJson['trade'] & { targetToken: Address; slippageBps: number };
  sell: ExecutorJson['sell'];
  timing: ExecutorJson['timing'];
  gas: ExecutorJson['gas'];
  notify: Record<EventName, boolean>;
  cli: Cli;
  jsonPath: string;
  minPoolDepthFor(token: Address): number;
  expectedFeeTierFor(token: Address): number | undefined;
  /** Verified pool from trade.tokens[addr].pool, or undefined (discovery path). */
  poolFor(token: Address): Address | undefined;
  /** sell.ts per-position: --slippage-bps (session-wide override) > trade.tokens[addr].slippageBps > sell.slippageBps. */
  slippageBpsFor(token: Address): number;
  /** sell.ts per-position: trade.tokens[addr].hotkeys, else the global sell.hotkeys. */
  hotkeysFor(token: Address): Record<string, number>;
}

export interface LoadOptions {
  argv?: string[];
  /** Real environment (shell wins over .env). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Inject file contents (tests). undefined = read from disk. */
  dotenvText?: string | null;
  jsonText?: string;
}

export function loadConfig(o: LoadOptions = {}): Config {
  const cwd = o.cwd ?? process.cwd();
  const shell = o.env ?? process.env;
  const merged: NodeJS.ProcessEnv = { ...shell };
  const dotenvText = o.dotenvText === undefined ? readIfExists(path.join(cwd, '.env')) : o.dotenvText;
  if (dotenvText) {
    for (const [k, v] of Object.entries(dotenv.parse(dotenvText))) if (shell[k] === undefined) merged[k] = v;
  }
  const env = envSchema.parse(merged);

  const jsonPath = path.join(cwd, 'config', 'executor.json');
  const jsonText = o.jsonText ?? readIfExists(jsonPath);
  if (jsonText === undefined) throw new ConfigError(`${jsonPath} not found`);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new ConfigError(`${jsonPath}: invalid JSON (${(e as Error).message})`);
  }
  try {
    assertNoSecretsInJson(raw);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(`${e.message}\n\nfull config as loaded (offending value masked):\n${dumpJsonForRejection(jsonText, e.message)}`);
    throw e;
  }
  const parsed = jsonSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${jsonPath}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`);
  }
  const json = parsed.data;

  const cli = parseArgv(o.argv ?? [], shell);

  // MetaMask exports private keys without the 0x prefix; viem requires it. Normalise, never reject.
  const rawPk = env.PRIVATE_KEY ?? '';
  const pk = rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new ConfigError('PRIVATE_KEY missing or malformed in packages/executor/.env (need 64 hex chars)');

  json.trade.tokens = Object.fromEntries(Object.entries(json.trade.tokens).map(([k, v]) => [k.toLowerCase(), v]));
  for (const [k, v] of Object.entries(json.trade.tokens)) {
    if (v.pool !== undefined && v.expectedFeeTier === undefined) throw new ConfigError(`${jsonPath}: trade.tokens.${k}.pool requires expectedFeeTier (the cached pool's fee is asserted against it)`);
  }

  const notify = Object.fromEntries(EVENTS.map((e) => [e, json.notify[e] ?? true])) as Record<EventName, boolean>;

  const targetToken = cli.token ?? json.trade.targetToken;
  const extraTokens: Address[] = [];
  for (const raw of (env.EXTRA_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new ConfigError(`EXTRA_TOKENS entry is not an address: ${raw}`);
    const a = raw.toLowerCase() as Address;
    if (!extraTokens.includes(a)) extraTokens.push(a);
  }
  const arcHttpUrls = (env.ARC_MAINNET_HTTP_URL ?? 'https://rpc.arc-scan.org').split(',').map((u) => u.trim()).filter(Boolean);
  if (!arcHttpUrls.length) throw new ConfigError('ARC_MAINNET_HTTP_URL is empty');
  for (const u of arcHttpUrls) if (!/^https?:\/\//.test(u)) throw new ConfigError(`ARC_MAINNET_HTTP_URL entry is not an http(s) URL: ${redactUrl(u)}`);
  // --live wins over EXECUTION_DRY_RUN; EXECUTION_DRY_RUN=0 alone also goes live. Default: dry run.
  const live = cli.live || !env.EXECUTION_DRY_RUN;
  return {
    live,
    discordDryRun: cli.discordLive ? false : env.DISCORD_DRY_RUN,
    privateKey: pk as Hex,
    baseRpcUrl: env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    arcHttpUrls,
    arcHttpUrl: arcHttpUrls[0]!,
    arcWssUrl: env.ARC_MAINNET_WSS_URL,
    arcRpcRotateAfter: env.ARC_RPC_ROTATE_AFTER === undefined ? 3 : parseIntIn(env.ARC_RPC_ROTATE_AFTER, 'ARC_RPC_ROTATE_AFTER', 1, 20),
    arcRpcMaxRps: cli.rps ?? (env.ARC_RPC_MAX_RPS === undefined ? 5 : parseRps(env.ARC_RPC_MAX_RPS, 'ARC_RPC_MAX_RPS')),
    arcRpcRetryBaseMs: env.ARC_RPC_RETRY_BASE_MS === undefined ? 400 : parseIntIn(env.ARC_RPC_RETRY_BASE_MS, 'ARC_RPC_RETRY_BASE_MS', 50, 10_000),
    irisUrl: (env.IRIS_API_URL ?? 'https://iris-api.circle.com').replace(/\/$/, ''),
    webhook: env.DISCORD_WH_EXECUTOR,
    extraTokens,
    route: json.route,
    trade: { ...json.trade, targetToken, slippageBps: cli.slippageBps ?? json.trade.slippageBps },
    sell: { ...json.sell, slippageBps: cli.slippageBps ?? json.sell.slippageBps },
    timing: json.timing,
    gas: json.gas,
    notify,
    cli,
    jsonPath,
    minPoolDepthFor: (t) => json.trade.tokens[t.toLowerCase()]?.minPoolDepthUsd ?? json.trade.defaultMinPoolDepthUsd,
    expectedFeeTierFor: (t) => json.trade.tokens[t.toLowerCase()]?.expectedFeeTier,
    poolFor: (t) => json.trade.tokens[t.toLowerCase()]?.pool,
    slippageBpsFor: (t) => cli.slippageBps ?? json.trade.tokens[t.toLowerCase()]?.slippageBps ?? json.sell.slippageBps,
    hotkeysFor: (t) => json.trade.tokens[t.toLowerCase()]?.hotkeys ?? json.sell.hotkeys,
  };
}

function readIfExists(p: string): string | undefined {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
}

// ── standalone tools ────────────────────────────────────────────────────

/** Env for the standalone tools (status.ts, approve.ts), so config.ts stays the only process.env reader. */
export interface ToolEnv {
  privateKey: string;
  arcRpcs: string[];
  baseRpcs: string[];
  irisUrl: string;
  pendingBurnTx: string | undefined;
  extraTokens: string[];
}

export function toolEnv(env: NodeJS.ProcessEnv = process.env): ToolEnv {
  const list = (v: string | undefined, def: string) => (v ?? def).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    privateKey: (env.PRIVATE_KEY ?? '').trim(),
    arcRpcs: list(env.ARC_MAINNET_HTTP_URL, 'https://rpc.arc-scan.org'),
    baseRpcs: list(env.BASE_RPC_URL, 'https://mainnet.base.org'),
    irisUrl: (env.IRIS_API_URL ?? 'https://iris-api.circle.com').replace(/\/$/, ''),
    pendingBurnTx: env.PENDING_BURN_TX?.trim() || undefined,
    extraTokens: list(env.EXTRA_TOKENS, ''),
  };
}

// ── redaction / print ───────────────────────────────────────────────────

export function redactUrl(u: string | undefined): string {
  if (!u) return '(unset)';
  try {
    const url = new URL(u);
    const hasPath = url.pathname.length > 1 || url.search.length > 0;
    return `${url.protocol}//${url.host}${hasPath ? '/…redacted' : ''}`;
  } catch {
    return '(malformed, redacted)';
  }
}

export function redactedView(cfg: Config): Record<string, unknown> {
  return {
    mode: { execution: cfg.live ? 'LIVE' : 'DRY RUN', discord: cfg.discordDryRun ? 'dry-run (log only)' : 'LIVE POST' },
    secrets: {
      PRIVATE_KEY: '0x…(64 hex, redacted)',
      BASE_RPC_URL: redactUrl(cfg.baseRpcUrl),
      ARC_MAINNET_HTTP_URL: cfg.arcHttpUrls.map(redactUrl).join(', '),
      ARC_RPC_ROTATE_AFTER: cfg.arcRpcRotateAfter,
      ARC_MAINNET_WSS_URL: cfg.arcWssUrl ? redactUrl(cfg.arcWssUrl) : '(unset → HTTP polling)',
      ARC_RPC_MAX_RPS: cfg.arcRpcMaxRps,
      ARC_RPC_RETRY_BASE_MS: cfg.arcRpcRetryBaseMs,
      IRIS_API_URL: redactUrl(cfg.irisUrl),
      DISCORD_WH_EXECUTOR: cfg.webhook ? 'set (redacted)' : '(unset)',
    },
    cli: { ...cfg.cli, rest: undefined },
    route: cfg.route,
    trade: { ...cfg.trade, targetToken: getAddress(cfg.trade.targetToken) },
    extraTokens: cfg.extraTokens.map((a) => getAddress(a)),
    sell: cfg.sell,
    timing: cfg.timing,
    gas: cfg.gas,
    notify: cfg.notify,
    json: cfg.jsonPath,
  };
}

/** 3-line summary by default; the full redacted dump behind --verbose. */
export function printConfig(cfg: Config, o: { wallet?: string; rpcHost?: string } = {}): void {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  if (cfg.cli.verbose) {
    console.log(`${bold('resolved config')} ${cfg.live ? 'LIVE' : 'DRY RUN'}`);
    console.log(JSON.stringify(redactedView(cfg), (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    console.log('');
    return;
  }
  const more = cfg.arcHttpUrls.length > 1 ? dim(` +${cfg.arcHttpUrls.length - 1} failover`) : '';
  console.log(`  mode     ${bold(cfg.live ? 'LIVE' : 'DRY RUN')}  ${dim(`discord ${cfg.discordDryRun ? 'dry-run' : 'live'} · ${cfg.jsonPath}`)}`);
  console.log(`  wallet   ${o.wallet ?? '(unset)'}`);
  console.log(`  network  Arc ${cfg.route.arcChainId} via ${o.rpcHost ?? redactUrl(cfg.arcHttpUrl)}${more}  ${dim(`rps ${cfg.arcRpcMaxRps} · rotate after ${cfg.arcRpcRotateAfter} · ${cfg.arcWssUrl ? 'wss' : 'http polling'} · --verbose for the full config`)}`);
  console.log('');
}

/** On a secrets-scan rejection: the full JSON, with the offending value masked, so the failing path is diagnosable. */
export function dumpJsonForRejection(jsonText: string, failingPath: string): string {
  try {
    const raw = JSON.parse(jsonText) as unknown;
    const mask = (v: unknown): unknown => {
      if (typeof v === 'string') return URL_SHAPED.test(v) || KEY_SHAPED.test(v) || /discord(?:app)?\.com\/api\/webhooks/i.test(v) ? `${v.slice(0, 8)}…(masked, ${v.length} chars)` : v;
      if (Array.isArray(v)) return v.map(mask);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]));
      return v;
    };
    return `${failingPath}\n${JSON.stringify(mask(raw), null, 2)}`;
  } catch {
    return `${failingPath}\n${jsonText}`;
  }
}
