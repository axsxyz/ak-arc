import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { FakeClock } from '../clock.js';
import { loadConfig, type Config } from '../config/env.js';
import { loadWatchlists } from '../config/watchlists.js';
import { parseRpcLog } from '../decode/index.js';
import { MemorySink } from '../discord/client.js';
import { Router, type RouteResult } from '../discord/router.js';
import { HeadTracker } from '../ingest/heads.js';
import { runBootProbe } from '../jobs/boot-probe.js';
import { majorDigest, padLeaderboard } from '../jobs/digests.js';
import { Pipeline } from '../pipeline.js';
import { Store } from '../store/sqlite.js';
import { FakeChainReader, type ChainFixture } from './fake-reader.js';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');

type RpcLogJson = Parameters<typeof parseRpcLog>[0];

export type Step =
  | { op: 'logs'; clockMs: number; logs: RpcLogJson[] }
  | { op: 'head'; clockMs: number; block: string }
  | { op: 'reconnect'; clockMs: number; head: string }
  | { op: 'boot'; clockMs: number; freshProcess?: boolean }
  | { op: 'digest'; clockMs: number }
  | { op: 'leaderboard'; clockMs: number };

export interface Scenario {
  name: string;
  description: string;
  env?: Record<string, string>;
  chainOverrides?: Partial<ChainFixture>;
  chainLogs?: RpcLogJson[];
  /** Simulate a warm start: in-memory windows complete from this time (default = first step). */
  coverageFromMs?: number;
  /** Watchlist dir relative to the repo root (default fixtures/watchlists). `config/watchlists` = real operator lists. */
  watchlistDir?: string;
  steps: Step[];
}

/** Base env for every fixture run. Thresholds pinned here so snapshots don't drift with .env. */
export const FIXTURE_ENV: Record<string, string> = {
  ARC_NETWORK: 'testnet',
  DISCORD_DRY_RUN: '1',
  ALERTS_PING_ENABLED: '1',
  ALERT_LP_USD: '5000',
  ALERT_LP_WATCH_USD: '1000',
  ALERT_LP_WINDOW_SEC: '120',
  ALERT_MIGRATE_VOL_USD: '10000',
  ALERT_MIGRATE_WINDOW_SEC: '300',
  ALERT_WALLET_AGE_SEC: '120',
  ALERT_WALLET_BUY_USD: '500',
  ALERT_ANOMALY_Z: '5',
  ALERT_ANOMALY_PCT: '100',
  ALERT_ANOMALY_MIN_SAMPLES: '30',
  ALERT_ANOMALY_MIN_VOL_USD: '1000',
  EARLY_BUYER_BLOCKS: '20',
  EARLY_BUYER_MIN_COUNT: '8',
  DEDUPE_SEC: '60',
  RPC_GETLOGS_MAX_RANGE: '5',
  BACKFILL_MAX_BLOCKS: '2400',
  DB_PATH: ':memory:',
};

export const FIXTURES_ENV_FOR_TESTS = FIXTURE_ENV;

export function loadScenario(name: string): Scenario {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'events', `${name}.json`), 'utf8'));
}

export function listScenarios(): string[] {
  return fs
    .readdirSync(path.join(FIXTURES_DIR, 'events'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export interface ScenarioRun {
  cfg: Config;
  sink: MemorySink;
  results: RouteResult[];
  pipeline: Pipeline;
  reader: FakeChainReader;
  tracker: HeadTracker;
  store: Store;
}

export async function runScenario(s: Scenario): Promise<ScenarioRun> {
  const chain: ChainFixture = {
    ...(JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'chain.json'), 'utf8')) as ChainFixture),
    ...s.chainOverrides,
  };
  const env = { ...FIXTURE_ENV, ...s.env, WATCHLIST_DIR: path.join(REPO_ROOT, s.watchlistDir ?? 'fixtures/watchlists') };
  const cfg = loadConfig(env as NodeJS.ProcessEnv, { cwd: FIXTURES_DIR });
  cfg.dbPath = ':memory:';
  const log = pino({ level: 'silent' });
  const clock = new FakeClock(s.steps[0]?.clockMs ?? 0);
  const reader = new FakeChainReader(
    { ...chain, pools: { ...chain.pools, ...s.chainOverrides?.pools }, tokens: { ...chain.tokens, ...s.chainOverrides?.tokens } },
    s.chainLogs ?? [],
  );
  const sink = new MemorySink();
  const store = new Store(':memory:');
  const results: RouteResult[] = [];

  const build = () => {
    const router = new Router(cfg, sink, clock, log);
    const pipeline = new Pipeline({ cfg, watchlists: loadWatchlists(cfg.watchlistDir, cfg.network.name), reader, router, clock, log });
    const tracker = new HeadTracker(cfg, reader, pipeline, clock, log);
    if (s.coverageFromMs !== undefined) pipeline.coverageFromMs = s.coverageFromMs;
    return { pipeline, tracker };
  };
  let { pipeline, tracker } = build();
  await pipeline.init();
  const collect = () => {
    for (const r of pipeline.results.splice(0)) results.push(r);
  };

  for (const step of s.steps) {
    clock.set(step.clockMs);
    switch (step.op) {
      case 'logs':
        await tracker.onLogs(step.logs.map(parseRpcLog));
        break;
      case 'head':
        await tracker.onHead(BigInt(step.block), Math.floor(step.clockMs / 1000));
        await tracker.idle();
        break;
      case 'reconnect':
        reader.head = BigInt(step.head);
        await tracker.onReconnect();
        await tracker.idle();
        break;
      case 'boot':
        if (step.freshProcess) {
          collect();
          ({ pipeline, tracker } = build()); // same store: simulates a restart
          await pipeline.init();
        }
        await runBootProbe({ cfg, reader, pipeline, store, clock, log });
        break;
      case 'digest':
        await majorDigest(pipeline, reader, cfg, clock.now());
        break;
      case 'leaderboard':
        await padLeaderboard(pipeline, cfg, clock.now());
        break;
    }
    await pipeline.idle();
    collect();
  }
  return { cfg, sink, results, pipeline, reader, tracker, store };
}

/** Stable JSON summary used for file snapshots. */
export function summarize(run: ScenarioRun) {
  return {
    posts: run.sink.posts,
    decisions: run.results.map((r) => ({
      type: r.signal.type,
      channel: r.decision.channel ?? null,
      ping: r.decision.ping_everyone,
      reason: r.decision.reason,
      suppressed: r.suppressed ?? null,
      usd: r.signal.usd ?? null,
    })),
    getLogsRanges: run.reader.getLogsCalls.map((c) => [c.from.toString(), c.to.toString()]),
  };
}
