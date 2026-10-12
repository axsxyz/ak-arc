import { describe, expect, it } from 'vitest';
import type { Channel } from '../../src/config/env.js';
import { loadScenario, runScenario, type ScenarioRun } from '../../src/testing/runner.js';

const title = (p: ScenarioRun['sink']['posts'][number]) => p.payload.embeds[0]!.title;
const pinged = (run: ScenarioRun) => run.sink.posts.filter((p) => p.payload.content === '@everyone');
const postsOf = (run: ScenarioRun, type: string) => run.sink.posts.filter((p) => title(p).startsWith(type));

function expectOnly(run: ScenarioRun, type: string, channel: Channel, ping: boolean, count = 1) {
  const posts = postsOf(run, type);
  expect(posts, `${type} posts`).toHaveLength(count);
  for (const p of posts) {
    expect(p.channel).toBe(channel);
    expect(p.payload.content === '@everyone').toBe(ping);
    expect(p.payload.allowed_mentions.parse.includes('everyone')).toBe(ping);
  }
}

describe('alert matrix (ping / no-ping)', () => {
  it('LP surge ≥ threshold → #alerts, @everyone', async () => {
    const run = await runScenario(loadScenario('03-lp-surge'));
    expectOnly(run, 'LP_SURGE', 'alerts', true);
    expect(pinged(run)).toHaveLength(1);
  });

  it('LP surge below threshold → #launchpads (pad pool) or #major-coins (major), no ping', async () => {
    const run = await runScenario(loadScenario('08-below-threshold'));
    const watch = postsOf(run, 'LP_WATCH');
    expect(watch.map((p) => p.channel).sort()).toEqual(['launchpads', 'major-coins']);
    expect(pinged(run)).toHaveLength(0);
    expect(run.sink.posts.some((p) => p.channel === 'alerts')).toBe(false);
  });

  it('LP remove → specialty channel, no ping', async () => {
    const run = await runScenario(loadScenario('04-lp-burn'));
    expectOnly(run, 'LP_REMOVE', 'launchpads', false);
    expect(pinged(run)).toHaveLength(0);
  });

  it('new pad token create → #launchpads, no ping; spoofed TokenCreated emitter ignored', async () => {
    const run = await runScenario(loadScenario('01-pad-launch'));
    expectOnly(run, 'NEW_LAUNCH', 'launchpads', false, 2);
    expect(pinged(run)).toHaveLength(0);
    expect(run.sink.posts.some((p) => JSON.stringify(p).includes('FAKE'))).toBe(false);
  });

  it('migrate + hot vol → #alerts, @everyone (graduation itself → #launchpads, no ping)', async () => {
    const run = await runScenario(loadScenario('05-graduate-hot'));
    expectOnly(run, 'PAD_MIGRATE_HOT', 'alerts', true);
    expectOnly(run, 'PAD_GRADUATED', 'launchpads', false);
    expect(pinged(run)).toHaveLength(1);
  });

  it('watchlist wallet fast buy → #alerts, @everyone; slow buy → #smart-flow, no ping', async () => {
    const run = await runScenario(loadScenario('06-wallet-fast-buy'));
    expectOnly(run, 'WATCHLIST_WALLET_FAST', 'alerts', true);
    expectOnly(run, 'WALLET_ACTIVITY', 'smart-flow', false);
    expect(pinged(run)).toHaveLength(1);
  });

  it('missing getCode on boot → #alerts once, no ping; restart does not repost', async () => {
    const run = await runScenario(loadScenario('09-missing-on-chain'));
    expectOnly(run, 'MISSING_ON_CHAIN', 'alerts', false);
    const body = JSON.stringify(postsOf(run, 'MISSING_ON_CHAIN')[0]);
    expect(body).toContain('Architects');
    expect(body).toContain('WARP');
    expect(body).not.toContain('COOL'); // has code in the fixture chain
    expect(run.pipeline.missing.has('0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0')).toBe(true);
  });

  it('duplicate surge → suppressed (exact replay dropped, second surge within 60s deduped)', async () => {
    const run = await runScenario(loadScenario('07-duplicate-surge'));
    expectOnly(run, 'LP_SURGE', 'alerts', true, 1);
    expect(run.results.filter((r) => r.signal.type === 'LP_SURGE')).toHaveLength(2); // replayed log never reached scoring
    expect(run.results.filter((r) => r.suppressed === 'dedupe')).toHaveLength(1);
    expect(pinged(run)).toHaveLength(1);
  });

  it('major anomaly → #alerts, @everyone, once (cooldown)', async () => {
    const run = await runScenario(loadScenario('11-major-anomaly'));
    expectOnly(run, 'MAJOR_ANOMALY', 'alerts', true);
  });

  it('spoofed pools (rogue factory / unproven factory claim) never ping and never reach #alerts', async () => {
    const run = await runScenario(loadScenario('12-spoofed-pool'));
    expect(run.sink.posts).toHaveLength(0);
    expect(run.results.map((r) => r.decision.reason)).toEqual([
      'downgraded: usdCertain=true trusted=false',
      'downgraded: usdCertain=true trusted=false',
    ]);
  });
});

describe('mainnet allowlist (config/watchlists networks.mainnet)', () => {
  it('major on canonical UniV3-Arc pool → MAJOR_ANOMALY #alerts with ping', async () => {
    const run = await runScenario(loadScenario('15-mainnet-major-anomaly'));
    expectOnly(run, 'MAJOR_ANOMALY', 'alerts', true);
    expect(postsOf(run, 'MAJOR_ANOMALY')[0]!.payload.embeds[0]!.fields.find((f) => f.name === 'venue/pad')!.value).toBe('UniswapV3-Arc');
    expect(postsOf(run, 'MAJOR_ANOMALY')[0]!.payload.embeds[0]!.footer.text).toBe('arc-mainnet | radar v1');
  });
  it('pool claiming UniV3-Arc without getPool round-trip → #major-coins, no ping', async () => {
    const run = await runScenario(loadScenario('16-mainnet-spoofed-major-pool'));
    expectOnly(run, 'MAJOR_ANOMALY', 'major-coins', false);
    expect(pinged(run)).toHaveLength(0);
  });
  it('Warp curve: trusted curve wallet fast buy pings; pre-boot curve downgrades; rogue curve/launcher ignored', async () => {
    const run = await runScenario(loadScenario('17-mainnet-warp-curve'));
    expectOnly(run, 'NEW_LAUNCH', 'launchpads', false, 1);
    expectOnly(run, 'WATCHLIST_WALLET_FAST', 'alerts', true);
    expectOnly(run, 'WALLET_ACTIVITY', 'smart-flow', false);
    expect(postsOf(run, 'WATCHLIST_WALLET_FAST')[0]!.payload.embeds[0]!.fields.find((f) => f.name === 'usd')!.value).toBe('$600.00');
    expect(JSON.stringify(run.sink.posts)).not.toContain('FAKE');
    expect(pinged(run)).toHaveLength(1);
  });
});

describe('gap on reconnect backfills without double-posting', () => {
  it('10-gap-backfill', async () => {
    const run = await runScenario(loadScenario('10-gap-backfill'));
    expectOnly(run, 'NEW_LAUNCH', 'launchpads', false, 1);
    expectOnly(run, 'LP_SURGE', 'alerts', true, 1);
    const pool = run.pipeline.pools.get('0x9001000000000000000000000000000000009001')!;
    expect(pool.usdInSinceBirth).toBe(300 + 250); // B+2 swap counted once, missed swap backfilled
    for (const c of run.reader.getLogsCalls) expect(c.to - c.from + 1n).toBeLessThanOrEqual(5n); // QuickNode 5-block cap
    const covered = new Set<bigint>();
    for (const c of run.reader.getLogsCalls) for (let b = c.from; b <= c.to; b++) covered.add(b);
    for (let b = 1_001_002n; b <= 1_001_024n; b++) expect(covered.has(b)).toBe(true);
    expect(run.tracker.gapsDetected).toBeGreaterThanOrEqual(2);
  });
});

describe('acceptance: major digest on schedule with non-null fields or explicit n/a', () => {
  it('13-major-digest', async () => {
    const run = await runScenario(loadScenario('13-major-digest'));
    expectOnly(run, 'MAJOR_DIGEST', 'major-coins', false);
    const e = postsOf(run, 'MAJOR_DIGEST')[0]!.payload.embeds[0]!;
    expect(e.title).toBe('MAJOR_DIGEST · COOL'); // Architects missing on chain → skipped
    for (const f of e.fields) expect(f.value, f.name).toMatch(/\S/);
    const get = (n: string) => e.fields.find((f) => f.name === n)!.value;
    expect(get('price')).toMatch(/^\$0\.02/);
    expect(get('mcap')).toMatch(/^\$20\.\d\dM$/);
    expect(get('vol 1h')).toBe('$2.80k');
    expect(get('lp (USDC)')).toBe('$101.60k');
    expect(get('top10% (ex LP/burn/venues)')).toBe('n/a'); // holders not backfilled in this scenario
    expect(get('holders≈')).toBe('n/a');
    expect(get('price')).toMatch(/^\$0\.02\d+ · pool reserves · \$101\.60k pool$/); // source = deepest trusted pool
  });
  it('pad leaderboard names the winning pad', async () => {
    const run = await runScenario(loadScenario('14-pad-leaderboard'));
    const e = postsOf(run, 'PAD_LEADERBOARD')[0]!.payload.embeds[0]!;
    expect(e.title).toBe('PAD_LEADERBOARD · winning pad: Tolly');
    expect(e.fields.find((f) => f.name === 'FixturePad')!.value).toContain('1 grad (100.0%)');
  });
});

describe('embed contract', () => {
  it('fields, colors, footer, links, T+Xs', async () => {
    const run = await runScenario(loadScenario('03-lp-surge'));
    const e = postsOf(run, 'LP_SURGE')[0]!.payload.embeds[0]!;
    expect(e.fields.slice(0, 8).map((f) => f.name)).toEqual(['token', 'venue/pad', 'usd', 'velocity', 'lp', 'mcap', 'tx', 'T+Xs']);
    expect(e.color).toBe(0xe74c3c);
    expect(e.footer.text).toBe('arc-testnet | radar v1');
    expect(e.fields.find((f) => f.name === 'T+Xs')!.value).toBe('T+1.5s');
    expect(e.fields.find((f) => f.name === 'tx')!.value).toContain('https://testnet.arcscan.app/tx/0x');
    expect(e.fields.find((f) => f.name === 'data')!.value).toBe('testnet plumbing — not market intel');
    expect(postsOf(run, 'NEW_LAUNCH')[0]!.payload.embeds[0]!.color).toBe(0x3498db);
  });
});
