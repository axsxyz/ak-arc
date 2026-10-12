import type { Clock } from '../clock.js';
import type { Config } from '../config/env.js';
import { CCTP_TOPICS, DEX_TOPICS, TOPICS } from '../decode/index.js';
import type { RawLog } from '../decode/types.js';
import type { Logger } from '../log.js';
import type { Pipeline } from '../pipeline.js';
import type { ChainReader, LogFilter } from '../rpc/reader.js';
import { backfill, planBackfill } from './backfill.js';

/**
 * Head tracking + gap detection. On any gap (reconnect, missed heads, restart from persisted cursor)
 * it backfills [last, head] in RPC-sized chunks through the same pipeline; log-id dedupe prevents double posts.
 */
export class HeadTracker {
  lastHead?: bigint;
  lastHeadTs?: number;
  private backfilling: Promise<void> = Promise.resolve();
  private lastHeartbeat = 0;
  gapsDetected = 0;
  /** true when there is no WSS: heads are polled and logs fetched per block range. */
  pollMode = false;

  constructor(
    private readonly cfg: Config,
    private readonly reader: ChainReader,
    private readonly pipeline: Pipeline,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly persist?: (block: bigint) => void,
  ) {}

  filters(): Omit<LogFilter, 'fromBlock' | 'toBlock'>[] {
    const f: Omit<LogFilter, 'fromBlock' | 'toBlock'>[] = [{ topics: [DEX_TOPICS] }];
    const transfers = this.pipeline.transferAddresses();
    if (transfers.length) f.push({ address: transfers, topics: [TOPICS.transfer] });
    const cctp = this.pipeline.cctpAddresses();
    if (cctp.length) f.push({ address: cctp, topics: [CCTP_TOPICS] });
    return f;
  }

  /** Resume cursor (e.g. from SQLite) — the first head will backfill from here. */
  resumeFrom(block: bigint) {
    this.lastHead = block;
  }

  onHead(n: bigint, tsSec: number): Promise<void> {
    const prev = this.lastHead;
    if (prev !== undefined && n <= prev) return this.backfilling; // duplicate/out-of-order head
    this.lastHead = n;
    this.lastHeadTs = tsSec;
    const now = this.clock.now();
    if (now - this.lastHeartbeat >= 60_000) {
      this.lastHeartbeat = now;
      this.log.info({ head: n.toString(), lag_ms: now - tsSec * 1000, pools: this.pipeline.pools.all().length, ...memMb(), ...this.pipeline.stats }, 'heartbeat'); // logs only, never Discord
    }
    this.persist?.(n);
    if (prev === undefined) return this.backfilling;
    if (this.pollMode) return this.schedule(prev + 1n, n, false); // HTTP polling: every new block is fetched
    if (n > prev + 1n) {
      this.gapsDetected++;
      return this.schedule(prev, n, true);
    }
    return this.backfilling;
  }

  /** After a WS reconnect: always re-fetch [lastHead, chainHead] (lastHead may be partially delivered). */
  async onReconnect(): Promise<void> {
    if (this.lastHead === undefined) return;
    const head = await this.reader.blockNumber();
    const from = this.lastHead;
    if (head > from) {
      this.lastHead = head;
      this.persist?.(head);
    }
    this.gapsDetected++;
    await this.schedule(from, head > from ? head : from, true);
  }

  private schedule(from: bigint, to: bigint, isGap: boolean): Promise<void> {
    const plan = planBackfill(from, to, this.cfg.rpc.backfillMaxBlocks);
    if (!plan) return this.backfilling;
    if (isGap) this.log.warn({ from: plan.from.toString(), to: plan.to.toString() }, 'gap detected; backfilling');
    this.backfilling = this.backfilling.then(() =>
      backfill(this.reader, plan, this.filters(), this.cfg.rpc.getLogsMaxRange, (logs) => this.pipeline.enqueue(logs), isGap ? this.log : quiet(this.log))
        .then(() => undefined)
        .catch((e) => this.log.error({ err: String(e) }, 'backfill failed')),
    );
    return this.backfilling;
  }

  onLogs(logs: RawLog[]) {
    return this.pipeline.enqueue(logs);
  }

  idle() {
    return this.backfilling.then(() => this.pipeline.idle());
  }
}

function quiet(log: Logger): Logger {
  return { ...log, info: () => undefined, warn: log.warn.bind(log) } as unknown as Logger;
}

function memMb() {
  const m = process.memoryUsage();
  return { rss_mb: Math.round(m.rss / 1048576), heap_mb: Math.round(m.heapUsed / 1048576) };
}
