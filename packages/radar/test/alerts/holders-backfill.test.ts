import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, toHex, type Address } from 'viem';
import { erc20Abi } from '../../src/abi/erc20.js';
import { FakeClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config/env.js';
import { loadWatchlists } from '../../src/config/watchlists.js';
import { MemorySink } from '../../src/discord/client.js';
import { Router } from '../../src/discord/router.js';
import { majorDigest } from '../../src/jobs/digests.js';
import { HoldersBackfill } from '../../src/jobs/holders-backfill.js';
import { Pipeline } from '../../src/pipeline.js';
import { Store } from '../../src/store/sqlite.js';
import { FakeChainReader, type ChainFixture } from '../../src/testing/fake-reader.js';
import { FIXTURES_DIR, FIXTURES_ENV_FOR_TESTS } from '../../src/testing/runner.js';
import { blockTs, GENESIS, W } from '../../src/testing/world.js';
import type { LogFilter } from '../../src/rpc/reader.js';

const log = pino({ level: 'silent' });
const Z = '0x0000000000000000000000000000000000000000';
const BIRTH = GENESIS.block + 10n;
const HEAD = GENESIS.block + 30_000n;
const holder = (n: number) => `0x${(0x7000 + n).toString(16).padStart(40, '0')}` as Address;
const E18 = 10n ** 18n;

let seq = 0;
function transfer(block: bigint, from: string, to: string, value: bigint) {
  return {
    address: W.cool,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as Address, to: to as Address } }) as string[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: toHex(block),
    transactionHash: toHex(++seq, { size: 32 }),
    logIndex: '0x0',
  };
}

/** COOL history: mint 1e9 to deployer at birth, distribute to 30 holders + the COOL/USDC pool over 30k blocks. */
function history() {
  const logs = [transfer(BIRTH, Z, holder(0), 1_000_000_000n * E18)];
  for (let i = 1; i <= 30; i++) logs.push(transfer(BIRTH + BigInt(i * 900), holder(0), holder(i), BigInt(i) * 1_000_000n * E18));
  logs.push(transfer(BIRTH + 28_000n, holder(0), W.poolCool, 400_000_000n * E18)); // LP: excluded from top10
  return logs;
}

function world(env: Record<string, string> = {}, store = new Store(':memory:'), extraLogs: ReturnType<typeof transfer>[] = [], head = HEAD) {
  const chain = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'chain.json'), 'utf8')) as ChainFixture;
  chain.createdAt = { [W.cool]: BIRTH.toString() };
  const reader = new FakeChainReader(chain, [...history(), ...extraLogs]);
  reader.head = head;
  const cfg = loadConfig({ ...FIXTURES_ENV_FOR_TESTS, WATCHLIST_DIR: path.join(FIXTURES_DIR, 'watchlists'), HOLDERS_BACKFILL_RANGE: '10000', ...env } as NodeJS.ProcessEnv, { cwd: FIXTURES_DIR });
  const clock = new FakeClock(blockTs(head) * 1000);
  const sink = new MemorySink();
  const router = new Router(cfg, sink, clock, log);
  const pipeline = new Pipeline({ cfg, watchlists: loadWatchlists(cfg.watchlistDir, 'testnet'), reader, router, clock, log });
  pipeline.missing.add(W.architects); // boot probe result: no code
  pipeline.coverageFromMs = clock.now() - 2 * 3600_000;
  const job = new HoldersBackfill({ cfg, reader, pipeline, store, clock, log });
  return { cfg, reader, clock, sink, pipeline, job, store };
}

const digestField = async (w: ReturnType<typeof world>, name: string) => {
  w.sink.posts.length = 0;
  w.clock.advance(61_000); // digests are deduped per subject within DEDUPE_SEC
  await majorDigest(w.pipeline, w.reader, w.cfg, w.clock.now(), undefined, w.job);
  return w.sink.posts[0]!.payload.embeds[0]!.fields.find((f) => f.name === name)?.value;
};

describe('holders backfill job (fake chain, no network)', () => {
  it('birth → head scan makes holders≈ and top10% real (LP excluded)', async () => {
    const w = world();
    expect(await digestField(w, 'top10% (ex LP/burn/venues)')).toBe('n/a');
    await w.job.pass();
    const t = w.pipeline.holders.get(W.cool)!;
    expect(t.birthBlock).toBe(BIRTH);
    expect(t.sinceBirth).toBe(true);
    expect(t.holderCount()).toBe(32); // deployer + 30 + pool
    expect(w.reader.getCodeAtCalls).toBeGreaterThan(5); // archive binary search
    for (const c of w.reader.getLogsCalls) expect(c.to - c.from + 1n).toBeLessThanOrEqual(10_000n);
    expect(await digestField(w, 'holders≈')).toBe('32');
    // top10 ex pool: deployer 135M + holders 21..30 (21M..30M)
    const deployer = 1_000_000_000n - 465_000_000n - 400_000_000n;
    const top = [deployer, ...Array.from({ length: 9 }, (_, i) => BigInt(30 - i) * 1_000_000n)].reduce((x, y) => x + y, 0n);
    expect(await digestField(w, 'top10% (ex LP/burn/venues)')).toBe(`${((Number(top) / 1e9) * 100).toFixed(1)}%`);
    expect(await digestField(w, 'holders data')).toMatch(/^full history since block 1000010 · synced to 1030000/);
    expect(w.job.statusOf(W.cool).phase).toBe('synced');
  });

  it('RPC range errors are split, not skipped', async () => {
    const w = world();
    const inner = w.reader.getLogs.bind(w.reader);
    w.reader.getLogs = async (f: LogFilter) => {
      if (f.toBlock - f.fromBlock + 1n > 4000n) throw new Error('eth_getLogs is limited to a 4,000 range');
      return inner(f);
    };
    await w.job.pass();
    expect(w.pipeline.holders.get(W.cool)!.holderCount()).toBe(32);
  });

  it('live pipeline Transfers interleaved with the backfill are counted once', async () => {
    const w = world();
    // The exact on-chain pool transfer at BIRTH+28000, delivered live (same tx hash/logIndex) before the scan reaches it.
    const late = w.reader.chainLogs.find((l) => l.blockNumber === BIRTH + 28_000n)!;
    w.job['tracker'](W.cool).beginBackfill(BIRTH, BIRTH);
    await w.pipeline.enqueue([{ ...late, blockTimestamp: blockTs(BIRTH + 28_000n) }]);
    await w.job.pass();
    expect(w.pipeline.holders.get(W.cool)!.balanceOf(W.poolCool)).toBe(400_000_000n * E18);
  });

  it('restart resumes from the SQLite checkpoint instead of rescanning history', async () => {
    const store = new Store(':memory:');
    const first = world({}, store);
    await first.job.pass();
    const newer = [transfer(HEAD + 500n, holder(1), holder(99), 1n * E18)];
    const second = world({}, store, newer, HEAD + 1000n);
    second.job.restore();
    expect(second.pipeline.holders.get(W.cool)!.sinceBirth).toBe(true);
    await second.job.pass();
    expect(second.reader.getCodeAtCalls).toBe(0); // birth known
    expect(second.reader.getLogsCalls.map((c) => [c.from, c.to])).toEqual([[HEAD + 1n, HEAD + 1000n]]);
    expect(second.pipeline.holders.get(W.cool)!.holderCount()).toBe(33);
  });

  it('history deeper than HOLDERS_BACKFILL_MAX_BLOCKS → partial, top10% n/a, progress says capped', async () => {
    const w = world({ HOLDERS_BACKFILL_MAX_BLOCKS: '5000' });
    await w.job.pass();
    expect(w.pipeline.holders.get(W.cool)!.sinceBirth).toBe(false);
    expect(await digestField(w, 'top10% (ex LP/burn/venues)')).toBe('n/a');
    expect(await digestField(w, 'holders≈')).toBe('n/a');
    expect(await digestField(w, 'holders data')).toMatch(/capped: partial history/);
  });

  it('HOLDERS_BACKFILL=0 → digest says disabled, no RPC scan', async () => {
    const w = world({ HOLDERS_BACKFILL: '0' });
    w.job.start();
    expect(w.reader.getLogsCalls).toHaveLength(0);
    expect(await digestField(w, 'holders data')).toBe('backfill disabled (HOLDERS_BACKFILL=0)');
  });
});

describe('holders backfill: ordering, integrity, pool re-resolution', () => {
  it('head → birth shared chunks: a young token completes in the first chunk while an old one keeps scanning', async () => {
    const YOUNG_BIRTH = HEAD - 4_000n;
    const young = [
      transfer(YOUNG_BIRTH, Z, holder(50), 1_000_000_000n * E18),
      transfer(YOUNG_BIRTH + 100n, holder(50), holder(51), 10n * E18),
    ].map((l) => ({ ...l, address: W.architects }));
    const w = world({}, new Store(':memory:'), young as never);
    w.pipeline.missing.delete(W.architects);
    const chain = (w.reader as unknown as { f: ChainFixture }).f;
    chain.code.push(W.architects);
    chain.createdAt![W.architects] = YOUNG_BIRTH.toString();
    chain.tokens[W.architects] = { symbol: 'ARCH', decimals: 18, totalSupply: (1_000_000_000n * E18).toString() };
    const inner = w.reader.getLogs.bind(w.reader);
    let youngDoneAtCall = -1;
    w.reader.getLogs = async (f: LogFilter) => {
      const r = await inner(f);
      if (youngDoneAtCall < 0 && w.pipeline.holders.get(W.architects)?.sinceBirth) youngDoneAtCall = w.reader.getLogsCalls.length - 1;
      return r;
    };
    await w.job.pass();
    expect(youngDoneAtCall).toBe(1); // verified + authoritative right after the first backward chunk, while the old token still scans
    expect(w.pipeline.holders.get(W.architects)!.holderCount()).toBe(2);
    expect(w.pipeline.holders.get(W.cool)!.holderCount()).toBe(32);
    // shared chunks: ≈ (HEAD - oldest birth) / range calls, not one full scan per token
    expect(w.reader.getLogsCalls.length).toBe(Math.ceil(Number(HEAD - BIRTH + 1n) / 10_000));
  });

  it('restored complete history is verified at the start of the next pass (not after other tokens finish)', async () => {
    const store = new Store(':memory:');
    const first = world({}, store);
    await first.job.pass();
    // simulate a checkpoint written before verification (history complete, not yet authoritative)
    const snap = first.pipeline.holders.get(W.cool)!.snapshot();
    store.saveHolders(5042002, W.cool, [], { ...snap, complete: false });
    const second = world({}, store);
    second.job.restore();
    expect(second.pipeline.holders.get(W.cool)!.sinceBirth).toBe(false);
    let verifiedBeforeAnyLogs = false;
    const inner = second.reader.getLogs.bind(second.reader);
    second.reader.getLogs = async (f: LogFilter) => {
      verifiedBeforeAnyLogs ||= second.reader.getLogsCalls.length === 0 && second.pipeline.holders.get(W.cool)!.sinceBirth;
      return inner(f);
    };
    await second.job.pass();
    expect(second.pipeline.holders.get(W.cool)!.sinceBirth).toBe(true);
    expect(second.reader.getLogsCalls).toHaveLength(0); // nothing to scan: verified straight from the checkpoint
  });

  it('Σbalances ≠ totalSupply → not authoritative: top10% n/a and a clear warning', async () => {
    const w = world();
    (w.reader as unknown as { f: ChainFixture }).f.tokens[W.cool]!.totalSupply = (2_000_000_000n * E18).toString();
    await w.job.pass();
    expect(w.pipeline.holders.get(W.cool)!.sinceBirth).toBe(false);
    expect(w.job.statusOf(W.cool).phase).toBe('mismatch');
    expect(await digestField(w, 'top10% (ex LP/burn/venues)')).toBe('n/a');
    expect(await digestField(w, 'holders data')).toMatch(/^⚠ Σbalances ≠ totalSupply \(-50\.0000%\)/);
  });
});

describe('digest price source + LP integrity (mainnet lesson: dust pools & throttled reads)', () => {
  it('a throttled balanceOf on a trusted pool → lp n/a (never a partial sum), price still from the known deep pool', async () => {
    const w = world();
    await digestField(w, 'lp (USDC)'); // first refresh: all depths known
    const inner = w.reader.balanceOf.bind(w.reader);
    w.reader.balanceOf = async () => undefined; // RPC throttled from now on
    w.clock.advance(w.cfg.majorDepthRefreshSec * 3000 + 1); // cached depths go stale
    expect(await digestField(w, 'lp (USDC)')).toBe('n/a');
    w.reader.balanceOf = inner;
    expect(await digestField(w, 'lp (USDC)')).toBe('$101.60k');
  });
  it('only dust pools (< MAJOR_PRICE_MIN_LP_USD) → price n/a, no source', async () => {
    const w = world({ MAJOR_PRICE_MIN_LP_USD: '1000000' });
    expect(await digestField(w, 'price')).toBe('n/a');
    expect(w.pipeline.majors.get(W.cool)!.sourcePool).toBeUndefined();
  });
});

describe('digest windows: n/a until coverage spans them', () => {
  it('fresh boot (coverage < 1 min) → vol/ΔLP/buy-sell n/a; covered → values', async () => {
    const w = world();
    w.pipeline.coverageFromMs = w.clock.now() - 30_000;
    expect(await digestField(w, 'vol 1h')).toBe('n/a');
    expect(await digestField(w, 'ΔLP 1h')).toBe('n/a');
    expect(await digestField(w, 'buy/sell 1h')).toBe('n/a');
    w.pipeline.coverageFromMs = w.clock.now() - 2 * 3600_000;
    expect(await digestField(w, 'vol 1h')).toBe('$0'); // covered and genuinely no volume
    expect(await digestField(w, 'buy/sell 1h')).toBe('no trades');
  });
});
