import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertNoSecretsInJson, ConfigError, loadConfig, parseArgv, redactedView } from '../../src/config.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const JSON_TEXT = fs.readFileSync(path.join(ROOT, 'config', 'executor.json'), 'utf8');
const KEY = 'ab'.repeat(32);
const ENV = { PRIVATE_KEY: KEY } as NodeJS.ProcessEnv; // no 0x on purpose (MetaMask export shape)
const load = (argv: string[] = [], env: NodeJS.ProcessEnv = ENV, jsonText = JSON_TEXT) => loadConfig({ argv, env, dotenvText: null, jsonText });
const withJson = (mut: (j: Record<string, unknown>) => void) => {
  const j = JSON.parse(JSON_TEXT) as Record<string, unknown>;
  mut(j);
  return JSON.stringify(j);
};

describe('config: a JSON config can never hold a secret or a kill-switch', () => {
  it('the shipped executor.json is clean and loads', () => {
    expect(() => load()).not.toThrow();
  });
  it('a webhook URL inside executor.json fails startup, naming the path', () => {
    const j = withJson((j) => ((j.notify as Record<string, unknown>).webhook = 'https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz'));
    expect(() => load([], ENV, j)).toThrow(/executor\.json\.notify\.webhook: URL-shaped/);
  });
  it('any URL-shaped string fails (RPC URLs belong in .env)', () => {
    const j = withJson((j) => ((j.route as Record<string, unknown>).rpc = 'wss://rpc-provider.example/abc'));
    expect(() => load([], ENV, j)).toThrow(/route\.rpc: URL-shaped/);
  });
  it('a 0x private key inside executor.json fails startup', () => {
    const j = withJson((j) => ((j.trade as Record<string, unknown>).signer = `0x${KEY}`));
    expect(() => load([], ENV, j)).toThrow(/trade\.signer: private-key-shaped/);
  });
  it('a bare 64-hex key (no 0x) also fails', () => {
    expect(() => assertNoSecretsInJson({ a: [{ b: KEY }] })).toThrow(/executor\.json\.a\[0\]\.b/);
  });
  it('kill-switch keys in JSON fail', () => {
    for (const k of ['EXECUTION_DRY_RUN', 'DISCORD_DRY_RUN', 'live', 'dryRun']) expect(() => assertNoSecretsInJson({ [k]: 0 })).toThrow(ConfigError);
  });
  it('unknown keys are rejected (strict schema)', () => {
    const j = withJson((j) => ((j.trade as Record<string, unknown>).maxImpactBps = 300));
    expect(() => load([], ENV, j)).toThrow(/maxImpactBps/);
  });
  it('40-hex addresses are fine (not keys)', () => {
    expect(() => assertNoSecretsInJson({ token: '0x1111111111111111111111111111111111111111' })).not.toThrow();
  });
});

describe('config: precedence CLI > env > json > default, safe defaults', () => {
  it('defaults to dry run for execution AND Discord', () => {
    const c = load();
    expect(c.live).toBe(false);
    expect(c.discordDryRun).toBe(true);
  });
  it('--live beats EXECUTION_DRY_RUN=1; EXECUTION_DRY_RUN=0 alone goes live; --dry-run wins over --live', () => {
    expect(load(['--live'], { ...ENV, EXECUTION_DRY_RUN: '1' }).live).toBe(true);
    expect(load([], { ...ENV, EXECUTION_DRY_RUN: '0' }).live).toBe(true);
    expect(load(['--live', '--dry-run'], { ...ENV, EXECUTION_DRY_RUN: '1' }).live).toBe(false);
  });
  it('--slippage-bps overrides json for both buy and sell', () => {
    const c = load(['--slippage-bps', '150']);
    expect(c.trade.slippageBps).toBe(150);
    expect(c.sell.slippageBps).toBe(150);
    expect(load().trade.slippageBps).toBe(300);
  });
  it('--token overrides trade.targetToken (lowercased)', () => {
    expect(load(['--token', '0xABCDEF0000000000000000000000000000000001']).trade.targetToken).toBe('0xabcdef0000000000000000000000000000000001');
  });
  it('per-token minPoolDepthUsd > default; unknown token uses the default (fresh launches tradeable)', () => {
    const c = load();
    expect(c.minPoolDepthFor('0x1111111111111111111111111111111111111111')).toBe(50_000);
    expect(c.minPoolDepthFor('0x1111111111111111111111111111111111111111')).toBe(50_000);
    expect(c.minPoolDepthFor('0x0000000000000000000000000000000000000abc')).toBe(2000);
    expect(c.expectedFeeTierFor('0x0000000000000000000000000000000000000abc')).toBeUndefined();
  });
  it('.env values fill in under the shell; shell wins', () => {
    const c = loadConfig({ argv: [], env: { PRIVATE_KEY: KEY, IRIS_API_URL: 'https://shell.example/' }, dotenvText: 'IRIS_API_URL=https://dotenv.example\nDISCORD_DRY_RUN=0\n', jsonText: JSON_TEXT });
    expect(c.irisUrl).toBe('https://shell.example');
    expect(c.discordDryRun).toBe(false);
  });
  it('PRIVATE_KEY without 0x is normalised; malformed keys abort', () => {
    expect(load().privateKey).toBe(`0x${KEY}`);
    expect(() => load([], { PRIVATE_KEY: 'nope' })).toThrow(/PRIVATE_KEY/);
  });
  it('malformed CLI values are rejected, unknown flags too', () => {
    expect(() => parseArgv(['--amount', 'lots'])).toThrow(/--amount/);
    expect(() => parseArgv(['--burn-tx', '0x12'])).toThrow(/--burn-tx/);
    expect(() => parseArgv(['--yolo'])).toThrow(/unknown flag/);
    expect(parseArgv(['--amount', '5000.5', '--prefunded']).prefunded).toBe(true);
  });
  it('--bridge-amount and --buy-amount parse independently of --amount', () => {
    const c = parseArgv(['--bridge-amount', '25000', '--buy-amount', '10000']);
    expect(c.bridgeAmount).toBe('25000');
    expect(c.buyAmount).toBe('10000');
    expect(c.amount).toBeUndefined();
    expect(() => parseArgv(['--bridge-amount', 'lots'])).toThrow(/--bridge-amount/);
    expect(() => parseArgv(['--buy-amount', 'lots'])).toThrow(/--buy-amount/);
  });
  it('redacted view never contains the key, the webhook or an RPC path', () => {
    const c = load([], { ...ENV, DISCORD_WH_EXECUTOR: 'https://discord.com/api/webhooks/1234567890/tokentokentokentokentoken', ARC_MAINNET_HTTP_URL: 'https://x.rpc-provider.example/secretsecretsecret' });
    const text = JSON.stringify(redactedView(c));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('tokentoken');
    expect(text).not.toContain('secretsecret');
    expect(text).toContain('x.rpc-provider.example');
  });
});

describe('config: Arc reader rate', () => {
  it('defaults to 5 rps; ARC_RPC_MAX_RPS raises it; --rps beats env; bounds enforced', () => {
    expect(load().arcRpcMaxRps).toBe(5);
    expect(load([], { ...ENV, ARC_RPC_MAX_RPS: '50' }).arcRpcMaxRps).toBe(50);
    expect(load(['--rps', '20'], { ...ENV, ARC_RPC_MAX_RPS: '50' }).arcRpcMaxRps).toBe(20);
    expect(() => load([], { ...ENV, ARC_RPC_MAX_RPS: '0' })).toThrow(/ARC_RPC_MAX_RPS/);
    expect(() => load(['--rps', '1000'])).toThrow(/--rps/);
    expect(JSON.stringify(redactedView(load([], { ...ENV, ARC_RPC_MAX_RPS: '50' })))).toContain('"ARC_RPC_MAX_RPS":50');
  });
});

describe('config: exit-path and reader knobs', () => {
  it('approveOnFill defaults on and is settable; retry base is env-driven and bounded', () => {
    expect(load().trade.approveOnFill).toBe(true);
    expect(load([], ENV, withJson((j) => ((j.trade as Record<string, unknown>).approveOnFill = false))).trade.approveOnFill).toBe(false);
    expect(load().arcRpcRetryBaseMs).toBe(400);
    expect(load([], { ...ENV, ARC_RPC_RETRY_BASE_MS: '100' }).arcRpcRetryBaseMs).toBe(100);
    expect(() => load([], { ...ENV, ARC_RPC_RETRY_BASE_MS: '10' })).toThrow(/ARC_RPC_RETRY_BASE_MS/);
  });
});

describe('config: cached pool + npm flag trap', () => {
  it('trade.tokens[addr].pool is read back lowercased and requires expectedFeeTier', () => {
    expect(load().poolFor('0x1111111111111111111111111111111111111111')).toBe('0x2222222222222222222222222222222222222222');
    expect(load().poolFor('0x0000000000000000000000000000000000000abc')).toBeUndefined();
    const j = withJson((j) => { const t = (j.trade as Record<string, Record<string, Record<string, unknown>>>).tokens!; t['0x1111111111111111111111111111111111111111'] = { pool: '0x2222222222222222222222222222222222222222' }; });
    expect(() => load([], ENV, j)).toThrow(/pool requires expectedFeeTier/);
    expect(() => load([], ENV, withJson((j) => { (j.trade as Record<string, Record<string, Record<string, unknown>>>).tokens!['0x1111111111111111111111111111111111111111']!.pool = '0x123'; }))).toThrow(/not an address/);
  });
  it('any npm invocation aborts with the single supported-form message; stray positionals abort', () => {
    const msg = /^Run with npx tsx src\/<stage>\.ts — npm scripts are not supported\.$/;
    expect(() => parseArgv(['--live', '0.3'], { npm_config_cost_usdc: 'true' })).toThrow(msg);
    expect(() => parseArgv(['--live', '--amount', '1'], { npm_lifecycle_event: 'buy' })).toThrow(msg);
    expect(() => parseArgv(['--live', '--amount', '1'], { npm_command: 'run-script', npm_lifecycle_event: 'x' })).toThrow(msg);
    // npx sets npm_lifecycle_event=npx and npm_command=exec but passes arguments through: allowed
    expect(parseArgv(['--live', '--amount', '1'], { npm_lifecycle_event: 'npx', npm_command: 'exec' }).amount).toBe('1');
    expect(() => parseArgv(['--live', '0.3'])).toThrow(/unexpected positional/);
    expect(parseArgv(['--live', '--cost-usdc', '0.3'], { npm_config_cache: '/x', npm_config_token: 'abc' }).costUsdc).toBe('0.3');
  });
  it('no stage script exists in package.json (npx tsx is the only invocation)', () => {
    const scripts = Object.keys((JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts);
    expect(scripts.sort()).toEqual(['test', 'test:unit', 'typecheck']);
  });
  it('no "npm run <stage>" hint survives anywhere in src', () => {
    const src = path.join(ROOT, 'src');
    const hits = fs.readdirSync(src).filter((f) => /npm run (?!typecheck|test)/.test(fs.readFileSync(path.join(src, f), 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('config: --entry-tokens', () => {
  it('parses a positive decimal token amount and rejects junk', () => {
    expect(parseArgv(['--cost-usdc', '0.3', '--entry-tokens', '114.540548']).entryTokens).toBe('114.540548');
    expect(parseArgv([]).entryTokens).toBeUndefined();
    expect(() => parseArgv(['--entry-tokens', '0'])).toThrow(/--entry-tokens/);
    expect(() => parseArgv(['--entry-tokens', 'many'])).toThrow(/--entry-tokens/);
  });
});

describe('config: RPC failover list', () => {
  it('ARC_MAINNET_HTTP_URL accepts a comma-separated list; single value still works; rotateAfter env-driven', () => {
    const c = load([], { ...ENV, ARC_MAINNET_HTTP_URL: ' https://a.example/x , https://b.example ,, https://c.example' });
    expect(c.arcHttpUrls).toEqual(['https://a.example/x', 'https://b.example', 'https://c.example']);
    expect(c.arcHttpUrl).toBe('https://a.example/x');
    expect(load().arcHttpUrls).toEqual(['https://rpc.arc-scan.org']);
    expect(load().arcRpcRotateAfter).toBe(3);
    expect(load([], { ...ENV, ARC_RPC_ROTATE_AFTER: '5' }).arcRpcRotateAfter).toBe(5);
    expect(() => load([], { ...ENV, ARC_MAINNET_HTTP_URL: 'wss://nope' })).toThrow(/not an http\(s\) URL/);
    expect(JSON.stringify(redactedView(c))).toContain('a.example/…redacted, https://b.example, https://c.example');
  });
  it('--verbose is parsed; a rejected secret dumps the full config with the value masked', async () => {
    expect(parseArgv(['--verbose']).verbose).toBe(true);
    const j = withJson((j) => ((j.notify as Record<string, unknown>).webhook = 'https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz'));
    let msg = '';
    try { load([], ENV, j); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/notify\.webhook: URL-shaped/);
    expect(msg).toContain('full config as loaded');
    expect(msg).toContain('"targetToken"');
    expect(msg).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(msg).toContain('masked');
  });
});
