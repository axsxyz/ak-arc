import type { Address } from 'viem';
import type { Clock } from '../clock.js';
import type { Config } from '../config/env.js';
import { TOPICS } from '../decode/index.js';
import { HolderTracker, type HolderSnapshot, type TransferEntry } from '../features/holders.js';
import { fetchSplitting } from '../ingest/backfill.js';
import type { Logger } from '../log.js';
import type { Pipeline } from '../pipeline.js';
import type { ChainReader } from '../rpc/reader.js';
import type { Store } from '../store/sqlite.js';

export type HolderPhase = 'disabled' | 'pending' | 'birth-search' | 'backfilling' | 'synced' | 'mismatch' | 'error';

export interface HolderStatus {
  phase: HolderPhase;
  birthBlock?: bigint;
  startBlock?: bigint;
  syncedTo?: bigint;
  head?: bigint;
  pct?: number;
  capped?: boolean;
  /** Σ balances vs totalSupply when they disagree (percent of supply). */
  mismatchPct?: number;
  error?: string;
}

const TRANSFER = TOPICS.transfer;

/**
 * Background job (never on the alert hot path; own RPC reader + rate limit):
 *  1. restore(): load checkpoints from SQLite into pipeline.holders (call BEFORE warm start so replayed
 *     Transfers dedupe against the saved cursor).
 *  2. run(): per on-chain major find the creation block (YAML created_block, else archive binary search on getCode),
 *     scan Transfer logs birth → head in HOLDERS_BACKFILL_RANGE chunks (failing ranges split), checkpoint regularly,
 *     mark sinceBirth when caught up, then keep syncing every HOLDERS_SYNC_SEC.
 * Restarts resume from the checkpointed cursor instead of rescanning history.
 */
export class HoldersBackfill {
  private readonly status = new Map<string, HolderStatus>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private lastCheckpoint = 0;
  private sleepResolve?: () => void;

  constructor(
    private readonly d: { cfg: Config; reader: ChainReader; pipeline: Pipeline; store: Store; clock: Clock; log: Logger },
  ) {}

  statusOf(token: string): HolderStatus {
    if (!this.d.cfg.holders.enabled) return { phase: 'disabled' };
    return this.status.get(token.toLowerCase()) ?? { phase: 'pending' };
  }

  private majors() {
    return this.d.pipeline.watchlists.majors.filter((m) => !this.d.pipeline.missing.has(m.address));
  }

  private tracker(token: Address): HolderTracker {
    let t = this.d.pipeline.holders.get(token);
    if (!t) {
      t = new HolderTracker(false);
      this.d.pipeline.holders.set(token, t);
    }
    return t;
  }

  /** Load checkpoints (synchronous, fast). */
  restore() {
    const chainId = this.d.cfg.network.chainId;
    for (const m of this.majors()) {
      const { snapshot, balances } = this.d.store.loadHolders(chainId, m.address);
      if (!snapshot) continue;
      const t = this.tracker(m.address);
      if (!t.restore(snapshot as HolderSnapshot, balances as [Address, bigint][])) {
        this.d.store.clearHolders(chainId, m.address);
        this.d.log.warn({ token: m.symbol }, 'holders: old checkpoint format discarded; rescanning');
        this.pipeline_resetTracker(m.address);
        continue;
      }
      this.status.set(m.address, {
        phase: t.sinceBirth ? 'synced' : 'backfilling',
        birthBlock: t.birthBlock,
        syncedTo: t.syncedTo,
        capped: t.capped,
      });
      this.d.log.info({ token: m.symbol, syncedTo: t.syncedTo.toString(), holders: balances.length, complete: t.sinceBirth }, 'holders: checkpoint restored');
    }
  }

  private pipeline_resetTracker(token: Address) {
    this.d.pipeline.holders.set(token, new HolderTracker(false));
  }

  /** Fire-and-forget loop. */
  start() {
    if (!this.d.cfg.holders.enabled) {
      this.d.log.info('holders backfill disabled (HOLDERS_BACKFILL=0): top10% stays n/a');
      return;
    }
    void this.loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.sleepResolve?.();
    try {
      this.checkpoint(true);
    } catch (e) {
      this.d.log.warn({ err: String(e) }, 'holders: final checkpoint failed');
    }
  }

  private async loop() {
    let backoff = 5_000;
    while (!this.stopped) {
      try {
        await this.pass();
        backoff = 5_000;
        await this.sleep(this.d.cfg.holders.syncSec * 1000);
      } catch (e) {
        this.d.log.warn({ err: String((e as Error).message ?? e).slice(0, 200), retryInSec: backoff / 1000 }, 'holders: pass failed; will resume from checkpoint');
        for (const [k, s] of this.status) if (s.phase !== 'synced') this.status.set(k, { ...s, phase: 'error', error: String((e as Error).message ?? e).slice(0, 80) });
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 300_000);
      }
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => {
      this.sleepResolve = r;
      this.timer = setTimeout(r, ms);
    });
  }

  /** One pass: ensure birth blocks, scan every live tracker up to head, mark complete, checkpoint. Exported for tests. */
  async pass(): Promise<void> {
    const { reader, cfg, log } = this.d;
    const head = await reader.blockNumber();
    // 1) births (failed ones are retried inside the scan loop too)
    await this.ensureBirths(head);
    this.lastBirthRetry = this.d.clock.now();

    // 2a) forward catch-up: new blocks above each tracker's syncedTo (restored checkpoints, periodic sync)
    const range = BigInt(cfg.holders.range);
    for (;;) {
      if (this.stopped) return;
      const behind = this.liveTrackers().filter((x) => x.t.hasCoverage && x.t.syncedTo < head);
      if (!behind.length) break;
      const cursor = behind.reduce((a, x) => (x.t.syncedTo < a ? x.t.syncedTo : a), head);
      const from = cursor + 1n;
      const to = from + range - 1n > head ? head : from + range - 1n;
      const tokens = behind.filter((x) => x.t.syncedTo < to);
      const byToken = await this.fetchTransfers(tokens.map((x) => x.m.address), from, to);
      for (const { m, t } of tokens) t.applyRange(byToken.get(m.address) ?? [], to);
      await this.maybeCheckpoint(head);
    }

    // Restored / already-complete histories are verified now, not after the (possibly hour-long) backward scan below.
    for (const { m, t } of this.liveTrackers()) if (t.historyComplete) await this.verify(m, t, head);

    // 2b) history: head → birth with shared chunks (youngest tokens complete first, minimal calls)
    const lastPct = new Map<string, number>();
    for (;;) {
      if (this.stopped) return;
      const pending = this.liveTrackers().filter((x) => !x.t.historyComplete);
      for (const x of pending) x.t.anchor(head); // new trackers start empty at their birth; re-anchor at head
      if (!pending.length) break;
      const to = pending.reduce((a, x) => (x.t.coveredFrom - 1n > a ? x.t.coveredFrom - 1n : a), -1n);
      const minStart = pending.reduce((a, x) => ((x.t.startBlock ?? 0n) < a ? x.t.startBlock ?? 0n : a), to);
      const from = to - range + 1n > minStart ? to - range + 1n : minStart;
      const tokens = pending.filter((x) => x.t.coveredFrom - 1n >= from);
      const byToken = await this.fetchTransfers(tokens.map((x) => x.m.address), from, to);
      for (const { m, t } of tokens) {
        t.applyBackward(byToken.get(m.address) ?? [], from);
        const start = t.startBlock ?? 0n;
        const pct = t.syncedTo >= start ? Math.min(100, Number(((t.syncedTo - t.coveredFrom + 1n) * 1000n) / (t.syncedTo - start + 1n)) / 10) : 100;
        const st = this.status.get(m.address) ?? { phase: 'backfilling' as HolderPhase };
        this.status.set(m.address, { ...st, phase: 'backfilling', syncedTo: t.syncedTo, head, pct, error: undefined });
        const prev = lastPct.get(m.address) ?? -10;
        if (pct - prev >= 10 || (t.historyComplete && prev < 100)) {
          lastPct.set(m.address, pct);
          log.info(
            { token: m.symbol, pct: Math.floor(pct), coveredFrom: t.coveredFrom.toString(), birthBlock: t.birthBlock?.toString(), transfersInChunk: byToken.get(m.address)?.length ?? 0, rss_mb: Math.round(process.memoryUsage().rss / 1048576) },
            'holders: backfill progress',
          );
        }
      }
      for (const { m, t } of tokens) if (t.historyComplete && !t.sinceBirth && !t.supplyMismatch) await this.verify(m, t, head); // young tokens go live early
      await this.maybeCheckpoint(head);
    }

    // 3) completion for anything not verified inside the scan (restored checkpoints, periodic re-verification)
    for (const m of this.majors()) await this.verify(m, this.tracker(m.address), head);
    this.checkpoint(true);
  }

  /** Σbalances == totalSupply gate; flips sinceBirth (or flags mismatch). Called as soon as a token's history completes. */
  private async verify(m: { address: Address; symbol: string }, t: HolderTracker, head: bigint) {
    const { reader, log } = this.d;
    if (!t.live || t.capped || !t.historyComplete || t.syncedTo < head) return;
    const supply = await reader.totalSupply(m.address);
    if (supply === undefined) return; // can't verify yet; retry next pass
    const wasComplete = t.sinceBirth;
    if (t.sinceBirth) {
      // Re-verify every pass; a later mismatch (rebase, missed range) revokes authority.
      const sum = t.sumBalances();
      if (sum === supply) return;
      t.revoke(sum, supply);
    } else {
      t.markSinceBirth(supply);
    }
    if (t.sinceBirth) {
      this.status.set(m.address, { ...(this.status.get(m.address) ?? { phase: 'synced' }), phase: 'synced', syncedTo: t.syncedTo, pct: 100, mismatchPct: undefined });
      log.info({ token: m.symbol, holders: t.holderCount(), negatives: t.negatives, syncedTo: t.syncedTo.toString() }, 'holders: synced since birth, Σbalances == totalSupply — holders≈ / top10% now authoritative');
      this.checkpoint(true);
    } else if (t.supplyMismatch) {
      const mm = t.supplyMismatch;
      const pct = mm.supply > 0n ? Number(((mm.sum - mm.supply) * 1_000_000n) / mm.supply) / 10_000 : 0;
      this.status.set(m.address, { ...(this.status.get(m.address) ?? { phase: 'mismatch' }), phase: 'mismatch', syncedTo: t.syncedTo, mismatchPct: pct });
      log.warn(
        { token: m.symbol, sum: mm.sum.toString(), totalSupply: mm.supply.toString(), diffPct: pct, birthBlock: t.birthBlock?.toString(), wasComplete },
        'holders: Σbalances != totalSupply — history incomplete (RPC answered pruned state?) or non-standard token; top10% stays n/a (set created_block to force the correct birth)',
      );
    }
  }

  private liveTrackers() {
    return this.majors()
      .map((m) => ({ m, t: this.tracker(m.address) }))
      .filter((x) => x.t.live && x.t.startBlock !== undefined);
  }

  private async fetchTransfers(addresses: Address[], from: bigint, to: bigint): Promise<Map<string, TransferEntry[]>> {
    const stats = { splits: 0 };
    const logs = await fetchSplitting(this.d.reader, { address: addresses, topics: [TRANSFER] }, from, to, stats);
    const byToken = new Map<string, TransferEntry[]>();
    for (const l of logs) {
      if (l.topics.length !== 3 || l.removed) continue;
      const list = byToken.get(l.address) ?? [];
      list.push({ id: `${l.transactionHash}:${l.logIndex}`, block: l.blockNumber, from: `0x${l.topics[1]!.slice(26)}` as Address, to: `0x${l.topics[2]!.slice(26)}` as Address, value: BigInt(l.data === '0x' ? 0 : l.data) });
      byToken.set(l.address, list);
    }
    return byToken;
  }

  private lastBirthRetry = 0;
  private async maybeCheckpoint(head: bigint) {
    if (this.d.clock.now() - this.lastCheckpoint <= this.d.cfg.holders.checkpointSec * 1000) return;
    this.checkpoint();
    // Tokens whose birth search failed (throttling) join the running scan (anchored at head).
    if (this.d.clock.now() - this.lastBirthRetry > this.d.cfg.holders.checkpointSec * 1000 && this.majors().some((m) => !this.tracker(m.address).live)) {
      this.lastBirthRetry = this.d.clock.now();
      await this.ensureBirths(head);
    }
  }

  /** Find creation blocks for majors not yet backfilling. Per-token failures don't block others. */
  private async ensureBirths(head: bigint) {
    const { cfg, log } = this.d;
    for (const m of this.majors()) {
      const t = this.tracker(m.address);
      if (t.live && t.birthBlock !== undefined) continue;
      this.status.set(m.address, { phase: 'birth-search' });
      let birth: bigint;
      try {
        birth = m.created_block !== undefined ? BigInt(m.created_block) : await this.findBirth(m.address, head);
      } catch (e) {
        // One token's failure (non-archive RPC, throttling) must not stall the others; retried next pass.
        this.status.set(m.address, { phase: 'error', error: `birth search: ${String((e as Error).message ?? e).slice(0, 60)}` });
        log.warn({ token: m.symbol, err: String((e as Error).message ?? e).slice(0, 160) }, 'holders: birth search failed (set created_block in major-coins.yaml to skip it)');
        continue;
      }
      const start = cfg.holders.maxBlocks > 0 && head - birth + 1n > BigInt(cfg.holders.maxBlocks) ? head - BigInt(cfg.holders.maxBlocks) + 1n : birth;
      t.beginBackfill(birth, start);
      this.status.set(m.address, { phase: 'backfilling', birthBlock: birth, startBlock: start, syncedTo: t.syncedTo, capped: t.capped, head, pct: 0 });
      log.info(
        { token: m.symbol, birthBlock: birth.toString(), startBlock: start.toString(), blocksToScan: (head - start + 1n).toString(), capped: t.capped },
        t.capped ? 'holders: history deeper than HOLDERS_BACKFILL_MAX_BLOCKS — partial scan, top10% will stay n/a' : 'holders: birth found, backfilling',
      );
    }

    this.checkpoint(true); // persist birth blocks immediately
  }

  /** Earliest block where getCode(token) != 0x (archive binary search, ~log2(head) calls). */
  async findBirth(token: Address, head: bigint): Promise<bigint> {
    let lo = 0n;
    let hi = head;
    const has = async (b: bigint) => (await this.d.reader.getCodeAt(token, b)) !== '0x';
    if (!(await has(head))) throw new Error(`no code at head for ${token}`);
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (await has(mid)) hi = mid;
      else lo = mid + 1n;
    }
    return lo;
  }

  checkpoint(force = false) {
    if (!force && this.d.clock.now() - this.lastCheckpoint < this.d.cfg.holders.checkpointSec * 1000) return;
    this.lastCheckpoint = this.d.clock.now();
    for (const m of this.majors()) {
      const t = this.d.pipeline.holders.get(m.address);
      if (!t?.live) continue;
      const dirty = [...t.dirty].map((a) => [a, t.balanceOf(a) ?? 0n] as [string, bigint]);
      this.d.store.saveHolders(this.d.cfg.network.chainId, m.address, dirty, t.snapshot());
      for (const [a] of dirty) t.dirty.delete(a as Address);
    }
  }
}
