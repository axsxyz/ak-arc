import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config/env.js';
import { loadWatchlists } from '../../src/config/watchlists.js';
import { decodeLog, parseRpcLog } from '../../src/decode/index.js';
import { MemorySink } from '../../src/discord/client.js';
import { Router } from '../../src/discord/router.js';
import { Pipeline } from '../../src/pipeline.js';
import { FakeChainReader, type ChainFixture } from '../../src/testing/fake-reader.js';
import { FIXTURES_DIR, REPO_ROOT } from '../../src/testing/runner.js';

/**
 * Replays REAL Arc mainnet receipts (fixtures/mainnet-real/receipts.json, recorded 2026-09-14) through the pipeline
 * with the REAL operator allowlist (config/watchlists, ARC_NETWORK=mainnet). Proves the adapters + allowlist on chain data.
 */
type Rec = { hash: string; from: string; blockTimestamp: string; logs: Parameters<typeof parseRpcLog>[0][] };
const R = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'mainnet-real', 'receipts.json'), 'utf8')) as {
  txs: Record<string, Rec>;
  chain: { tokens: ChainFixture['tokens']; pools: ChainFixture['pools']; curves: ChainFixture['curves'] };
};

async function replay(keys: string[], mutate?: (logs: Rec['logs']) => Rec['logs']) {
  const cfg = loadConfig({ ARC_NETWORK: 'mainnet', DB_PATH: ':memory:' }, { cwd: REPO_ROOT });
  const reader = new FakeChainReader({ chainId: 5042, head: '0', code: [], txFrom: {}, balances: {}, sqrtPrices: {}, ...R.chain });
  const sink = new MemorySink();
  const clock = new FakeClock(0);
  const log = pino({ level: 'silent' });
  const router = new Router(cfg, sink, clock, log);
  const pipeline = new Pipeline({ cfg, watchlists: loadWatchlists(cfg.watchlistDir, 'mainnet'), reader, router, clock, log });
  await pipeline.init();
  for (const k of keys) {
    const tx = R.txs[k]!;
    clock.set(Number(BigInt(tx.blockTimestamp)) * 1000 + 1500);
    const logs = (mutate ? mutate(tx.logs) : tx.logs).map((l) => parseRpcLog({ ...l, blockTimestamp: tx.blockTimestamp }));
    await pipeline.enqueue(logs);
  }
  await pipeline.idle();
  return { sink, pipeline };
}

const titles = (s: MemorySink) => s.posts.map((p) => `${p.channel}|${p.payload.embeds[0]!.title}|${p.payload.content ?? ''}`);
const field = (s: MemorySink, i: number, name: string) => s.posts[i]!.payload.embeds[0]!.fields.find((f) => f.name === name)?.value;

describe('mainnet real receipts → adapters + operator allowlist', () => {
  it('every launcher log in the receipts decodes', () => {
    const kinds = Object.values(R.txs).flatMap((t) => t.logs.map((l) => decodeLog(parseRpcLog(l))).filter((e) => e?.kind === 'pad_token_created' || e?.kind === 'pad_trade').map((e) => `${e!.kind}:${(e as { adapter: string }).adapter}`));
    expect(kinds.sort()).toEqual(['pad_token_created:lift', 'pad_token_created:radar', 'pad_token_created:tolly', 'pad_token_created:warp', 'pad_trade:warp']);
  });

  it('Lift launch: NEW_LAUNCH #launchpads, pool verified on UniV3-Arc, initial buy counted once ($3.50)', async () => {
    const { sink, pipeline } = await replay(['lift_launch']);
    expect(titles(sink)).toEqual(['launchpads|NEW_LAUNCH · Lift|']);
    expect(field(sink, 0, 'token')).toContain('E/ACC');
    expect(field(sink, 0, 'usd')).toBe('$3.50');
    expect(field(sink, 0, 'pool trust')).toMatch(/^verified/);
    const pool = pipeline.pools.get('0xaa86f4e20ee878ac877f167c7269706478164132')!;
    expect(pool).toMatchObject({ trusted: true, padName: 'Lift', usdcSide: 0 });
    expect(pool.usdInSinceBirth).toBe(3.5); // V3 swap only; InitialBuyExecuted not double-counted
    expect(pipeline.pads.get('Lift')!.window(Date.UTC(2030, 0), 100 * 365 * 24 * 3600_000).launched).toBe(1);
  });

  it('Tolly mainnet custom pad: NEW_LAUNCH (OS), dev buy $1.01 via pool swap', async () => {
    const { sink, pipeline } = await replay(['tolly_launch']);
    expect(titles(sink)).toEqual(['launchpads|NEW_LAUNCH · Tolly|']);
    expect(field(sink, 0, 'token')).toContain('OS');
    expect(pipeline.pools.get('0xf1f09239f8865646132ec9a9c9d5b12abaf48d05')).toMatchObject({ trusted: true, padName: 'Tolly', usdInSinceBirth: 1.01 });
  });

  it('RadarDEX launcher: NEW_LAUNCH attributed to RadarDEX, initial buy $10 via pool swap', async () => {
    const { sink, pipeline } = await replay(['radar_launch_initial_buy']);
    expect(titles(sink)).toEqual(['launchpads|NEW_LAUNCH · RadarDEX|']);
    const pool = [...pipeline.pools.all()].find((p) => p.padName === 'RadarDEX')!;
    expect(pool).toMatchObject({ trusted: true, usdInSinceBirth: 10 });
  });

  it('Warp: TokenCreated registers curve; Trade quote is native USDC 18-dec (1e18 → $1.00)', async () => {
    const { sink, pipeline } = await replay(['warp_create', 'warp_buy']);
    expect(titles(sink)).toEqual(['launchpads|NEW_LAUNCH · Warp|']);
    expect(field(sink, 0, 'curve')).toContain('0x9914');
    const stats = pipeline.pads.get('Warp')!.window(Date.UTC(2030, 0), 100 * 365 * 24 * 3600_000);
    expect(stats.launched).toBe(1);
    expect(stats.volUsd).toBe(1);
  });

  it('CCTP mint (real Arc mainnet mint, identifiers anonymized): MessageReceived decodes as bridge_mint (regression for the missing `indexed` on finalityThresholdExecuted — see src/abi/cctp.ts), and its paired Transfer(0x0->recipient) decodes too', async () => {
    const tx = R.txs['cctp_mint']!;
    const decoded = tx.logs.map((l) => decodeLog(parseRpcLog(l)));
    const mint = decoded.find((e) => e?.kind === 'bridge_mint' && (e as { caller: string }).caller === '0x00000000000000000000000000000000000a11ce');
    expect(mint).toMatchObject({ kind: 'bridge_mint', caller: '0x00000000000000000000000000000000000a11ce', sourceDomain: 6 });
    const transfer = decoded.find((e) => e?.kind === 'transfer' && e.emitter === '0xfffffffffffffffffffffffffffffffffffffffe' && (e as { to: string }).to === '0x00000000000000000000000000000000000a11ce');
    expect(transfer).toMatchObject({ from: '0x0000000000000000000000000000000000000000', value: 999_968_000_000_000_000n });
    const { sink, pipeline } = await replay(['cctp_mint']);
    // This real tx mints to two recipients but carries only one MessageReceived log (the second appears to be a
    // separate/batched transfer, not an independent CCTP message) — the count below is what's actually on chain.
    expect(pipeline.stats.byKind['bridge_mint']).toBe(1);
    // ~$1 mint, well under the default BRIDGE_FLOW_USD ($25,000): decoded and tracked, but does not post — the threshold working as intended, not a bug.
    expect(sink.posts).toEqual([]);
  });

  it('no alerts, no @everyone from plain launches', async () => {
    const { sink } = await replay(Object.keys(R.txs));
    expect(sink.posts.some((p) => p.channel === 'alerts' || p.payload.content)).toBe(false);
  });

  it('spoof: identical launcher logs from a non-allowlisted emitter are ignored', async () => {
    const rogue = '0xdead00000000000000000000000000000000dead';
    const { sink } = await replay(['lift_launch', 'tolly_launch', 'radar_launch_initial_buy', 'warp_create'], (logs) =>
      logs.map((l) => (['0x3f29dd25d1f6ad3d09d1d4a880f8a869e3039153', '0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b', '0x4b638c1502a07a8e1a26112ee98f51a3f34bc93a', '0x0dcad158e98bc24455f9e94f46709d8a5f6d1255'].includes(l.address.toLowerCase()) ? { ...l, address: rogue } : l)),
    );
    expect(sink.posts).toEqual([]);
  });

  it('payload snapshot', async () => {
    const { sink } = await replay(Object.keys(R.txs));
    await expect(JSON.stringify(sink.posts, null, 2) + '\n').toMatchFileSnapshot(path.join(FIXTURES_DIR, 'expected', 'mainnet-real.json'));
  });
});
