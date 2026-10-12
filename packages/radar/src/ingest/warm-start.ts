import type { Clock } from '../clock.js';
import type { Config } from '../config/env.js';
import type { Router } from '../discord/router.js';
import type { Logger } from '../log.js';
import type { Pipeline } from '../pipeline.js';
import type { ChainReader } from '../rpc/reader.js';
import { backfill } from './backfill.js';
import type { HeadTracker } from './heads.js';

/**
 * Warm start: replay the last WARM_START_HOURS of chain history through the normal pipeline with Discord MUTED
 * (router.setLiveFrom(boot) must already be set). Seeds in-memory state that would otherwise be empty on boot:
 * pool registry + trust, pad launches/volume, Warp curves (trusted only if their TokenCreated is in the window),
 * major volume/price baselines (MAJOR_ANOMALY needs >= ALERT_ANOMALY_MIN_SAMPLES minutes), holders≈.
 * Returns the last replayed block; live ingest continues from there (the gap produced meanwhile is backfilled,
 * and anything older than boot stays muted).
 */
export async function warmStart(d: {
  cfg: Config;
  reader: ChainReader;
  pipeline: Pipeline;
  tracker: HeadTracker;
  router: Router;
  clock: Clock;
  log: Logger;
}): Promise<bigint | undefined> {
  const { cfg, reader, pipeline, tracker, router, clock, log } = d;
  if (!(cfg.warmStartHours > 0)) return undefined;
  const head = await reader.blockNumber();
  const sample = head > 20_000n ? 20_000n : head;
  const [tsHead, tsOld] = await Promise.all([reader.blockTimestamp(head), reader.blockTimestamp(head - sample)]);
  const blocksPerSec = tsHead !== undefined && tsOld !== undefined && tsHead > tsOld ? Number(sample) / (tsHead - tsOld) : 2;
  const span = BigInt(Math.ceil(cfg.warmStartHours * 3600 * blocksPerSec));
  const from = head > span ? head - span + 1n : 0n;
  const started = clock.now();
  const fromTs = await reader.blockTimestamp(from);
  if (fromTs !== undefined) pipeline.coverageFromMs = Math.min(pipeline.coverageFromMs, fromTs * 1000);
  log.info(
    { hours: cfg.warmStartHours, from: from.toString(), to: head.toString(), blocks: (head - from + 1n).toString(), blocksPerSec: +blocksPerSec.toFixed(3) },
    'warm start: replaying history (Discord muted for events before boot)',
  );
  let lastPct = -1;
  const res = await backfill(reader, { from, to: head, skipped: 0n }, tracker.filters(), cfg.rpc.getLogsMaxRange, (logs) => pipeline.enqueue(logs), log, (done, total, logs) => {
    const pct = Number((done * 100n) / total);
    if (pct >= lastPct + 10 || pct === 100) {
      lastPct = pct;
      log.info({ pct, logs, pools: pipeline.pools.all().length, elapsedSec: Math.round((clock.now() - started) / 1000) }, 'warm start progress');
    }
  });
  await pipeline.idle();
  tracker.resumeFrom(head);
  const pads = Object.fromEntries([...pipeline.pads.entries()].map(([n, p]) => [n, p.window(clock.now(), cfg.warmStartHours * 3600_000).launched]));
  log.info(
    { logs: res.logs, splits: res.splits, pools: pipeline.pools.all().length, mutedSignals: router.mutedCount, launchesByPad: pads, elapsedSec: Math.round((clock.now() - started) / 1000) },
    'warm start complete; going live',
  );
  return head;
}
