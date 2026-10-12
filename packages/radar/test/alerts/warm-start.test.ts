import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { FakeClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config/env.js';
import { loadWatchlists } from '../../src/config/watchlists.js';
import { parseRpcLog } from '../../src/decode/index.js';
import { MemorySink } from '../../src/discord/client.js';
import { Router } from '../../src/discord/router.js';
import { backfill } from '../../src/ingest/backfill.js';
import { HeadTracker } from '../../src/ingest/heads.js';
import { warmStart } from '../../src/ingest/warm-start.js';
import { Pipeline } from '../../src/pipeline.js';
import { FakeChainReader, type ChainFixture } from '../../src/testing/fake-reader.js';
import { FIXTURES_ENV_FOR_TESTS, FIXTURES_DIR, loadScenario } from '../../src/testing/runner.js';
import { blockTs, GENESIS } from '../../src/testing/world.js';
import type { LogFilter } from '../../src/rpc/reader.js';

const log = pino({ level: 'silent' });
const B = GENESIS.block + 1000n;

function setup(opts: { warmStartHours: number; head: bigint }) {
  const history = loadScenario('03-lp-surge').steps.flatMap((s) => (s.op === 'logs' ? s.logs : [])); // PoolCreated + $8000 mint
  const chain = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'chain.json'), 'utf8')) as ChainFixture;
  const reader = new FakeChainReader(chain, history);
  reader.head = opts.head;
  const cfg = loadConfig({ ...FIXTURES_ENV_FOR_TESTS, WARM_START_HOURS: String(opts.warmStartHours), WATCHLIST_DIR: path.join(FIXTURES_DIR, 'watchlists') } as NodeJS.ProcessEnv, { cwd: FIXTURES_DIR });
  const clock = new FakeClock(blockTs(opts.head) * 1000 + 1500);
  const sink = new MemorySink();
  const router = new Router(cfg, sink, clock, log);
  const pipeline = new Pipeline({ cfg, watchlists: loadWatchlists(cfg.watchlistDir, 'testnet'), reader, router, clock, log });
  const tracker = new HeadTracker(cfg, reader, pipeline, clock, log);
  return { cfg, reader, clock, sink, router, pipeline, tracker, log };
}

describe('warm start (history replay, Discord muted)', () => {
  it('replays history into state without posting; live events after boot post normally', async () => {
    const t = setup({ warmStartHours: 0.1, head: B + 100n }); // 0.1h ≈ 720 blocks covers the surge at B+20
    await t.pipeline.init();
    t.router.setLiveFrom(t.clock.now());
    const head = await warmStart(t);
    expect(head).toBe(B + 100n);
    expect(t.sink.posts).toEqual([]); // NEW_LAUNCH + LP_SURGE from history: muted
    expect(t.router.mutedCount).toBe(2);
    const pool = t.pipeline.pools.get('0x9001000000000000000000000000000000009001')!;
    expect(pool).toMatchObject({ trusted: true, padName: 'Tolly' }); // state seeded
    expect(t.pipeline.pads.get('Tolly')!.launches).toHaveLength(1);
    expect(t.tracker.lastHead).toBe(B + 100n);

    // Live: a new $9000 mint 5 minutes later (outside surge window) → real #alerts post with ping.
    const liveMint = loadScenario('03-lp-surge').steps[1] as { logs: Parameters<typeof parseRpcLog>[0][] };
    const l = { ...liveMint.logs[0]!, blockNumber: `0x${(B + 700n).toString(16)}`, transactionHash: `0x${'ab'.repeat(32)}` };
    t.clock.set(blockTs(B + 700n) * 1000 + 1500);
    await t.pipeline.enqueue([parseRpcLog(l)]);
    expect(t.sink.posts.map((p) => [p.channel, p.payload.content ?? ''])).toEqual([['alerts', '@everyone']]);
  });

  it('disabled when WARM_START_HOURS=0', async () => {
    const t = setup({ warmStartHours: 0, head: B + 100n });
    expect(await warmStart(t)).toBeUndefined();
    expect(t.reader.getLogsCalls).toHaveLength(0);
  });
});

describe('backfill splits failing ranges instead of dropping logs', () => {
  it('halves ranges the RPC rejects until they succeed; all logs delivered once, in order', async () => {
    const history = loadScenario('10-gap-backfill').chainLogs!;
    const chain = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'chain.json'), 'utf8')) as ChainFixture;
    const reader = new FakeChainReader(chain, history);
    const inner = reader.getLogs.bind(reader);
    reader.getLogs = async (f: LogFilter) => {
      if (f.toBlock - f.fromBlock + 1n > 8n) throw new Error('HTTP 503 (range too large)');
      return inner(f);
    };
    const got: string[] = [];
    const res = await backfill(reader, { from: B, to: B + 40n, skipped: 0n }, [{ topics: [null] }], 41, async (logs) => void got.push(...logs.map((l) => `${l.blockNumber}:${l.logIndex}`)), log);
    expect(res.splits).toBeGreaterThan(0);
    expect(res.logs).toBe(history.length);
    expect(got).toEqual([...got].sort((a, b) => (BigInt(a.split(':')[0]!) < BigInt(b.split(':')[0]!) ? -1 : 1)));
  });
  it('a single block that keeps failing still throws (surfaced as backfill failed, never silent)', async () => {
    const chain = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'chain.json'), 'utf8')) as ChainFixture;
    const reader = new FakeChainReader(chain, []);
    reader.getLogs = async () => {
      throw new Error('boom');
    };
    await expect(backfill(reader, { from: B, to: B + 3n, skipped: 0n }, [{ topics: [null] }], 4, async () => undefined, log)).rejects.toThrow('boom');
  });
});
