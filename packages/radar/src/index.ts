import { loadedProfile } from './config/load-env.js'; // must stay first: env precedence shell > profile > .env
import { hexToBigInt, type Hex } from 'viem';
import { systemClock } from './clock.js';
import { ConfigError, loadConfig } from './config/env.js';
import { loadWatchlists, watchWatchlists } from './config/watchlists.js';
import { CCTP_TOPICS, DEX_TOPICS, logId, parseRpcLog, TOPICS } from './decode/index.js';
import { WebhookSink } from './discord/client.js';
import { Router } from './discord/router.js';
import { HeadTracker } from './ingest/heads.js';
import { warmStart } from './ingest/warm-start.js';
import { WsRpc } from './ingest/ws.js';
import { runBootProbe } from './jobs/boot-probe.js';
import { bridgeFlowDigest, majorDigest, padLeaderboard, refreshMajorDepths } from './jobs/digests.js';
import { HoldersBackfill } from './jobs/holders-backfill.js';
import { attachPrecision, attachSignalScoring, samplePrecision, sampleSignals } from './jobs/precision.js';
import { log } from './log.js';
import { Pipeline } from './pipeline.js';
import { RpcChainReader } from './rpc/clients.js';
import { assertChain, ChainMismatchError } from './rpc/probe.js';
import { Store } from './store/sqlite.js';

async function main() {
  const cfg = loadConfig(process.env, { requireRpc: true, requireWssOnMainnet: true });
  const clock = systemClock;
  log.info(
    {
      network: cfg.network.name,
      chainId: cfg.network.chainId,
      profile: loadedProfile ? cfg.profile : undefined,
      ingest: cfg.wssUrl ? 'wss' : 'http-poll',
      rpcHost: new URL(cfg.httpUrl!).host,
      dryRun: cfg.discordDryRun,
      ping: cfg.pingEnabled,
      warmStartHours: cfg.warmStartHours,
    },
    'arc-radar starting',
  );
  if (cfg.network.name === 'mainnet' && !cfg.wssUrl) {
    log.warn({ pollIntervalMs: cfg.rpc.pollIntervalMs }, 'mainnet HTTP polling (ALLOW_MAINNET_HTTP_POLLING=1): ~2-3s behind chain, public RPC has no SLA — switch to WSS when available');
  }
  if (cfg.network.name === 'testnet') log.warn('ARC_NETWORK=testnet: plumbing mode — ecosystem tokens and launchpads live on mainnet; output is not market data');

  const reader = new RpcChainReader(cfg.httpUrl!, cfg.rpc.maxRps);
  await assertChain(reader, cfg);
  log.info({ chainId: cfg.network.chainId }, 'chainId assertion passed');

  const store = new Store(cfg.dbPath);
  const sink = new WebhookSink(cfg.webhooks, cfg.discordDryRun, log);
  const router = new Router(cfg, sink, clock, log);
  const chainId = cfg.network.chainId;
  const pipeline = new Pipeline({
    cfg,
    watchlists: loadWatchlists(cfg.watchlistDir, cfg.network.name),
    reader,
    router,
    clock,
    log,
    onRawEvent: (ev, t) =>
      setImmediate(() => {
        try {
          const { raw, ...rest } = ev;
          store.insertEvent(chainId, logId(raw), ev.kind, raw.blockNumber, t, ev.emitter, JSON.stringify(rest, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
        } catch (e) {
          log.warn({ err: String(e) }, 'cold store write failed');
        }
      }),
    onPoolResolved: (p) => {
      const row = { pool: p.pool, dex: p.dex, token0: p.token0, token1: p.token1, fee: p.fee, factory: p.factory, trusted: p.trusted, usdcSide: p.usdcSide, usdcDepth: p.usdcDepth };
      setImmediate(() => {
        try {
          store.upsertPoolMeta(chainId, row, Date.now());
        } catch (e) {
          log.warn({ err: String(e) }, 'pool_meta write failed');
        }
      });
    },
  });
  const usdcDec = await pipeline.init();
  log.info({ usdcDecimals: usdcDec }, 'USDC mirror decimals confirmed');
  attachPrecision(router, pipeline, store, cfg, () => clock.now());
  attachSignalScoring(router, pipeline, store, cfg, () => clock.now(), log); // edge scorecard (paper, cold path)

  await runBootProbe({ cfg, reader, pipeline, store, clock, log });
  // Anything that happened before this instant is history: it updates state but never posts to Discord.
  router.setLiveFrom(clock.now());

  const cursorKey = `lastBlock:${chainId}`;
  let lastPersist = 0;
  const tracker = new HeadTracker(cfg, reader, pipeline, clock, log, (b) => {
    if (Date.now() - lastPersist > 5000) {
      lastPersist = Date.now();
      store.setKv(cursorKey, b.toString());
    }
  });
  // Holder balances: restore checkpoints BEFORE warm start (replayed Transfers dedupe against the saved cursor).
  // The job uses its own reader + rate limit (optionally another RPC) so it never competes with the alert path.
  let holdersReader = reader;
  if (cfg.holders.enabled && cfg.holders.rpcUrl && cfg.holders.rpcUrl !== cfg.httpUrl) {
    holdersReader = new RpcChainReader(cfg.holders.rpcUrl, cfg.holders.maxRps, { attempts: 7, baseMs: 1000 });
    await assertChain(holdersReader, cfg);
  } else if (cfg.holders.enabled) {
    holdersReader = new RpcChainReader(cfg.httpUrl!, cfg.holders.maxRps, { attempts: 7, baseMs: 1000 });
  }
  const holdersJob = new HoldersBackfill({ cfg, reader: holdersReader, pipeline, store, clock, log });
  holdersJob.restore();

  // Pick each major's price source (deepest trusted pool) BEFORE warm start so replayed swaps build a clean price series.
  await refreshMajorDepths(pipeline, reader, cfg, clock.now()).catch((e) => log.warn({ err: String(e) }, 'major depth refresh failed'));
  const warmHead = await warmStart({ cfg, reader, pipeline, tracker, router, clock, log });
  holdersJob.start(); // async, after warm start
  const saved = store.getKv(cursorKey);
  if (warmHead === undefined && saved) {
    tracker.resumeFrom(BigInt(saved));
    log.info({ from: saved }, 'resuming from persisted cursor (gap will be backfilled, bounded)');
  }

  const timers: NodeJS.Timeout[] = [];
  let pollTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let ws: WsRpc | undefined;
  if (cfg.wssUrl) {
    ws = new WsRpc(cfg.wssUrl, log, cfg.rpc.headStallSec * 1000);
    ws.subscribe({
      kind: 'newHeads',
      onData: (h) => {
        const head = h as { number: Hex; timestamp: Hex };
        const n = hexToBigInt(head.number);
        const ts = Number(hexToBigInt(head.timestamp));
        reader.primeTimestamp(n, ts);
        void tracker.onHead(n, ts);
      },
    });
    ws.subscribe({ kind: 'logs', params: { topics: [DEX_TOPICS] }, onData: (l) => void tracker.onLogs([parseRpcLog(l as never)]) });
    ws.subscribe({
      kind: 'logs',
      // Evaluated at (re)subscribe time so watchlist reloads + boot probe results apply after a reconnect.
      params: () => {
        const addrs = pipeline.transferAddresses();
        return { address: addrs.length ? addrs : ['0x000000000000000000000000000000000000dEaD'], topics: [TOPICS.transfer] };
      },
      onData: (l) => void tracker.onLogs([parseRpcLog(l as never)]),
    });
    ws.subscribe({
      kind: 'logs',
      params: () => {
        const addrs = pipeline.cctpAddresses();
        return { address: addrs.length ? addrs : ['0x000000000000000000000000000000000000dEaD'], topics: [CCTP_TOPICS] };
      },
      onData: (l) => void tracker.onLogs([parseRpcLog(l as never)]),
    });
    ws.on('reconnected', () => void tracker.onReconnect().catch((e) => log.error({ err: String(e) }, 'reconnect backfill failed')));
    ws.start();
    // Chaos test (ops): drop the socket once after N seconds to exercise reconnect + gap backfill live.
    const chaos = Number(process.env.CHAOS_WS_DROP_SEC ?? 0);
    if (chaos > 0) timers.push(setTimeout(() => (log.warn({ chaos }, 'CHAOS: dropping ws'), ws!.drop()), chaos * 1000));
  } else {
    log.warn({ pollIntervalMs: cfg.rpc.pollIntervalMs }, 'no WSS URL: HTTP head polling');
    tracker.pollMode = true;
    let failures = 0;
    // Sequential loop: the next poll is scheduled only after this one (incl. its getLogs + processing) finished.
    const poll = async () => {
      if (stopping) return;
      try {
        const n = await reader.blockNumber();
        const ts = (await reader.blockTimestamp(n)) ?? Math.floor(Date.now() / 1000);
        await tracker.onHead(n, ts);
        if (failures) log.info({ failures }, 'poll recovered');
        failures = 0;
      } catch (e) {
        failures++;
        log.warn({ err: String(e).slice(0, 200), failures }, 'poll failed; will retry (missed blocks are backfilled on recovery)');
      }
      if (!stopping) pollTimer = setTimeout(poll, failures ? Math.min(30_000, cfg.rpc.pollIntervalMs * 2 ** Math.min(failures, 5)) : cfg.rpc.pollIntervalMs);
    };
    void poll();
  }

  const stopWatch = watchWatchlists(
    cfg.watchlistDir,
    cfg.network.name,
    async (w) => {
      pipeline.applyWatchlists(w);
      log.info({ majors: w.majors.length, pads: w.pads.length, wallets: w.wallets.length }, 'watchlists hot-reloaded');
      await runBootProbe({ cfg, reader, pipeline, store, clock, log });
      ws?.drop(); // resubscribe with the new address set; reconnect backfill covers the blip
    },
    (e) => log.error({ err: String(e) }, 'watchlist reload rejected; keeping previous lists'),
  );

  timers.push(
    setInterval(() => void majorDigest(pipeline, reader, cfg, clock.now(), log, holdersJob).catch((e) => log.error({ err: String(e) }, 'major digest failed')), cfg.majorDigestSec * 1000),
    setInterval(() => void refreshMajorDepths(pipeline, reader, cfg, clock.now()).catch((e) => log.warn({ err: String(e) }, 'major depth refresh failed')), cfg.majorDepthRefreshSec * 1000),
    setInterval(() => void padLeaderboard(pipeline, cfg, clock.now()).catch((e) => log.error({ err: String(e) }, 'pad leaderboard failed')), cfg.padLeaderboardSec * 1000),
    setInterval(() => void bridgeFlowDigest(pipeline, cfg, clock.now()).catch((e) => log.error({ err: String(e) }, 'bridge flow digest failed')), cfg.bridgeDigestSec * 1000),
    setInterval(() => void samplePrecision(pipeline, reader, store, cfg, clock.now(), log).catch((e) => log.error({ err: String(e) }, 'precision failed')), 30_000),
    setInterval(() => {
      try {
        sampleSignals(pipeline, store, clock.now(), log);
      } catch (e) {
        log.error({ err: String(e) }, 'signal sampling failed');
      }
    }, 30_000),
  );

  const shutdown = (sig: string) => {
    log.info({ sig }, 'shutting down');
    stopping = true;
    clearTimeout(pollTimer);
    holdersJob.stop(); // final holder checkpoint
    ws?.stop();
    stopWatch();
    timers.forEach(clearInterval);
    if (tracker.lastHead !== undefined) store.setKv(cursorKey, tracker.lastHead.toString());
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  if (e instanceof ConfigError || e instanceof ChainMismatchError) {
    log.fatal(e.message);
    process.exit(2);
  }
  log.fatal({ err: String((e as Error).stack ?? e) }, 'fatal');
  process.exit(1);
});
