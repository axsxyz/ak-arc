import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { loadWatchlists, watchedContracts } from '../../src/config/watchlists.js';
import { assertChain, ChainMismatchError, criticalMajorsAllMissing, probeContracts } from '../../src/rpc/probe.js';
import { FakeChainReader, type ChainFixture } from '../../src/testing/fake-reader.js';
import { FIXTURES_DIR } from '../../src/testing/runner.js';

const T = 'https://testnet.example/';
const M = 'https://mainnet.example/';

describe('ARC_NETWORK switch', () => {
  it('defaults to testnet 5042002', () => {
    const c = loadConfig({ ARC_TESTNET_HTTP_URL: T }, { requireRpc: true });
    expect(c.network.name).toBe('testnet');
    expect(c.network.chainId).toBe(5042002);
    expect(c.httpUrl).toBe(T);
    expect(c.network.label).toBe('arc-testnet');
  });
  it('mainnet = 5042 with its own URLs and explorer', () => {
    const c = loadConfig({ ARC_NETWORK: 'mainnet', ARC_TESTNET_HTTP_URL: T, ARC_MAINNET_HTTP_URL: M, ARC_MAINNET_WSS_URL: 'wss://m' }, { requireRpc: true });
    expect(c.network.chainId).toBe(5042);
    expect(c.httpUrl).toBe(M);
    expect(c.wssUrl).toBe('wss://m');
    expect(c.network.explorer).toBe('https://www.arcexplorer.org');
  });
  it('mainnet without RPC fails fast with an actionable message', () => {
    expect(() => loadConfig({ ARC_NETWORK: 'mainnet', ARC_TESTNET_HTTP_URL: T }, { requireRpc: true })).toThrow(/attach QuickNode Arc Mainnet endpoint/);
  });
  it('live bot on mainnet requires WSS; HTTP-only RPC (rpc.arc-scan.org) is allowed for probe/discovery', () => {
    const env = { ARC_NETWORK: 'mainnet', ARC_MAINNET_HTTP_URL: 'https://rpc.arc-scan.org' };
    expect(loadConfig(env, { requireRpc: true }).httpUrl).toBe('https://rpc.arc-scan.org');
    expect(() => loadConfig(env, { requireRpc: true, requireWssOnMainnet: true })).toThrow(/requires ARC_MAINNET_WSS_URL/);
    expect(loadConfig({ ...env, ARC_MAINNET_WSS_URL: 'wss://m' }, { requireRpc: true, requireWssOnMainnet: true }).wssUrl).toBe('wss://m');
    expect(loadConfig({ ARC_TESTNET_HTTP_URL: T }, { requireRpc: true, requireWssOnMainnet: true }).wssUrl).toBeUndefined(); // testnet keeps HTTP polling fallback
  });
  it('ALLOW_MAINNET_HTTP_POLLING=1 opts the live bot into mainnet HTTP polling (no WSS)', () => {
    const env = { ARC_NETWORK: 'mainnet', ARC_MAINNET_HTTP_URL: 'https://rpc.arc-scan.org', ALLOW_MAINNET_HTTP_POLLING: '1', POLL_INTERVAL_MS: '1000', WARM_START_HOURS: '6' };
    const c = loadConfig(env, { requireRpc: true, requireWssOnMainnet: true });
    expect(c).toMatchObject({ allowMainnetHttpPolling: true, warmStartHours: 6, wssUrl: undefined });
    expect(c.rpc.pollIntervalMs).toBe(1000);
    expect(() => loadConfig({ ...env, ALLOW_MAINNET_HTTP_POLLING: '0' }, { requireRpc: true, requireWssOnMainnet: true })).toThrow(/ALLOW_MAINNET_HTTP_POLLING=1/);
    expect(loadConfig({}).warmStartHours).toBe(0); // off unless asked
  });
  it('ARC_CHAIN_ID must agree with ARC_NETWORK', () => {
    expect(() => loadConfig({ ARC_NETWORK: 'mainnet', ARC_CHAIN_ID: '5042002', ARC_MAINNET_HTTP_URL: M })).toThrow(ConfigError);
    expect(loadConfig({ ARC_CHAIN_ID: '5042002', ARC_TESTNET_HTTP_URL: T }).network.chainId).toBe(5042002);
  });
  it('generic ARC_HTTP_URL overrides the per-network URL (brief env names)', () => {
    expect(loadConfig({ ARC_HTTP_URL: 'https://x/', ARC_TESTNET_HTTP_URL: T }).httpUrl).toBe('https://x/');
  });
  it('invalid values rejected', () => {
    expect(() => loadConfig({ ARC_NETWORK: 'devnet' })).toThrow(ConfigError);
    expect(() => loadConfig({ ALERT_LP_USD: 'lots' })).toThrow(ConfigError);
  });
  it('safe defaults: dry-run on, brief thresholds', () => {
    const c = loadConfig({});
    expect(c.discordDryRun).toBe(true);
    expect(c.thresholds.lpUsd).toBe(50_000);
    expect(c.thresholds.dedupeSec).toBe(60);
    expect(c.rpc.getLogsMaxRange).toBe(5);
  });
});

describe('boot chainId assertion', () => {
  const fx = (chainId: number) => ({ chainId, tokens: {}, pools: {}, code: [], txFrom: {}, balances: {}, sqrtPrices: {}, head: '1' }) as ChainFixture;
  it('mainnet config on testnet RPC is refused', async () => {
    const cfg = loadConfig({ ARC_NETWORK: 'mainnet', ARC_MAINNET_HTTP_URL: T });
    await expect(assertChain(new FakeChainReader(fx(5042002)), cfg)).rejects.toThrow(ChainMismatchError);
  });
  it('matching chain passes', async () => {
    await expect(assertChain(new FakeChainReader(fx(5042002)), loadConfig({}))).resolves.toBe(5042002);
  });
});

describe('operator watchlists (config/watchlists/ via default WATCHLIST_DIR)', () => {
  const dir = loadConfig({}, { cwd: path.resolve(import.meta.dirname, '../..') }).watchlistDir;
  const w = loadWatchlists(dir, 'testnet');
  it('loads all lists', () => {
    expect(w.majors.map((m) => m.symbol)).toEqual(['Architects', 'COOL', 'Arcat', 'Arcash', 'Steve', 'BARC', 'Buildog', 'CRCL', 'bull']);
    expect(w.padTokens.map((t) => t.symbol)).toEqual(['LIFT', 'ARGUS', 'TOLLY', 'LONG', 'WARP', 'SHARC']);
    expect(w.pads.map((p) => p.name)).toEqual(['Lift', 'Argus', 'Tolly', 'Long', 'Warp', 'Dyor', 'Sharc']);
    expect(w.dex.map((d) => d.name)).toEqual(['UniswapV3-Arc', 'RadarDEX']);
    expect(w.wallets).toEqual([]);
  });
  it('addresses normalized to lowercase (mixed-case Sharc CA)', () => {
    expect(w.padTokens.find((t) => t.symbol === 'SHARC')!.address).toBe('0x99b37b7fccaa7a1030617b6195eb3045c523bb97');
  });
  it('testnet: only TollyPad (as a UniV3 launch factory)', () => {
    const all = [...w.pads, ...w.dex].flatMap((v) => v.factories.map((f) => [v.name, f.address, f.kind, f.role]));
    expect(all).toEqual([['Tolly', '0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b', 'univ3', 'launch']]);
  });
  it('mainnet: factories populated from launchpads.discovered.yaml (and only from it)', () => {
    const main = loadWatchlists(dir, 'mainnet');
    const all = [...main.pads, ...main.dex].flatMap((v) => v.factories.map((f) => `${v.name}:${f.kind}:${f.role}:${f.address}`));
    expect(all).toEqual([
      'Lift:lift:launch:0x3f29dd25d1f6ad3d09d1d4a880f8a869e3039153',
      'Tolly:tolly:launch:0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b',
      'Warp:warp:launch:0x0dcad158e98bc24455f9e94f46709d8a5f6d1255',
      'Warp:univ2:migration:0x32330c2400a6e0830d56661169ebb6c147e3577a',
      'UniswapV3-Arc:univ3:amm:0xf0db7b58379503491d857db50ac9ece64c653918',
      'RadarDEX:radar:launch:0x4b638c1502a07a8e1a26112ee98f51a3f34bc93a',
      'RadarDEX:todo:launch:0x62d6e545ee3882a9bde308a10a2b79e32b2d073a',
    ]);
    // Every configured mainnet CA must appear in the curated discovered file (no invented CAs).
    const discovered = fs.readFileSync(path.join(dir, 'launchpads.discovered.yaml'), 'utf8').toLowerCase();
    const cas = [...main.pads, ...main.dex].flatMap((v) => [...v.factories.map((f) => f.address), ...v.routers, ...Object.values(v.aux)]);
    expect(cas.length).toBeGreaterThan(10);
    for (const a of cas) expect(discovered, a).toContain(a);
  });
  it('still TODO on mainnet: Sharc, Argus, Long (no factories), Dyor (routers only)', () => {
    const main = loadWatchlists(dir, 'mainnet');
    for (const n of ['Sharc', 'Argus', 'Long', 'Dyor']) expect(main.pads.find((p) => p.name === n)!.factories, n).toEqual([]);
    expect(main.pads.find((p) => p.name === 'Dyor')!.routers).toHaveLength(2);
    expect(main.infra.bridge?.[0]?.contracts ?? []).toEqual([]); // Ellipse TODO
  });
  it('CCTP contracts (Base<->Arc corridor) are configured with checksummable addresses', () => {
    const main = loadWatchlists(dir, 'mainnet');
    expect(main.infra.cctp?.message_transmitter).toBe('0x81d40f21f12a8f0e3252bccb954d722d4c464b64');
    expect(main.infra.cctp?.token_messenger).toBe('0x28b5a0e9c621a5badaa536219b3a228c8168cf5d');
    expect(main.infra.cctp?.local_minter).toBe('0xfd78ee919681417d192449715b2594ab58f5d002');
    expect(main.infra.cctp?.source_domain).toBe(6);
  });
  it('watched contract set includes USDC, majors, pad tokens, factory + router', () => {
    const c = watchedContracts(w, '0x3600000000000000000000000000000000000000');
    expect(c).toHaveLength(1 + 9 + 6 + 1 + 2); // testnet: USDC, majors, pad tokens, TollyPad (router is mainnet-only), 2 CCTP contracts (shared across networks like majors — boot probe flags them MISSING_ON_CHAIN on testnet)
  });
});

describe('chain probe gate', () => {
  const w = loadWatchlists(path.join(FIXTURES_DIR, 'watchlists'), 'testnet');
  const base = { chainId: 5042002, tokens: {}, pools: {}, txFrom: {}, balances: {}, sqrtPrices: {}, head: '1' };
  it('passes when at least one critical major has code', async () => {
    const rows = await probeContracts(new FakeChainReader({ ...base, code: ['0xeb64987643db71c76b2a2be7e723decc995e5b37'] }), 5042002, watchedContracts(w, '0x3600000000000000000000000000000000000000'));
    expect(criticalMajorsAllMissing(rows)).toBe(false);
  });
  it('fails when ALL critical majors are missing (testnet reality)', async () => {
    const rows = await probeContracts(new FakeChainReader({ ...base, code: [] }), 5042002, watchedContracts(w, '0x3600000000000000000000000000000000000000'));
    expect(criticalMajorsAllMissing(rows)).toBe(true);
    expect(rows.every((r) => r.status === 'MISSING_ON_CHAIN')).toBe(true);
  });
});
