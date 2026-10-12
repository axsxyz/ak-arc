import type { Logger } from '../log.js';
import type { RawLog } from '../decode/types.js';
import type { ChainReader, LogFilter } from '../rpc/reader.js';

export interface BackfillPlan {
  from: bigint;
  to: bigint;
  skipped: bigint; // blocks dropped because the gap exceeded BACKFILL_MAX_BLOCKS
}

export function planBackfill(lastProcessed: bigint, head: bigint, maxBlocks: number): BackfillPlan | undefined {
  // Re-fetch lastProcessed itself: a disconnect mid-block may have lost part of its logs (dedupe drops repeats).
  const from = lastProcessed;
  const to = head;
  if (to < from) return undefined;
  const span = to - from + 1n;
  const max = BigInt(maxBlocks);
  if (span <= max) return { from, to, skipped: 0n };
  return { from: to - max + 1n, to, skipped: span - max };
}

/** Chunked eth_getLogs (QuickNode Discover caps range at 5 blocks). Calls sink per chunk in block order. */
export async function backfill(
  reader: ChainReader,
  plan: BackfillPlan,
  filters: Omit<LogFilter, 'fromBlock' | 'toBlock'>[],
  chunk: number,
  sink: (logs: RawLog[]) => Promise<void>,
  log: Logger,
  onProgress?: (doneBlocks: bigint, totalBlocks: bigint, logs: number) => void,
): Promise<{ chunks: number; logs: number; splits: number }> {
  if (plan.skipped > 0n) log.warn({ skipped: plan.skipped.toString(), from: plan.from.toString() }, 'GAP_TOO_LARGE: backfilling tail only');
  let chunks = 0;
  let total = 0;
  const stats = { splits: 0 };
  const totalBlocks = plan.to - plan.from + 1n;
  for (let start = plan.from; start <= plan.to; start += BigInt(chunk)) {
    const end = start + BigInt(chunk) - 1n > plan.to ? plan.to : start + BigInt(chunk) - 1n;
    const batch: RawLog[] = [];
    for (const f of filters) {
      if (f.address && f.address.length === 0) continue;
      batch.push(...(await fetchSplitting(reader, f, start, end, stats)));
    }
    batch.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    await sink(batch);
    chunks++;
    total += batch.length;
    onProgress?.(end - plan.from + 1n, totalBlocks, total);
  }
  log.info({ from: plan.from.toString(), to: plan.to.toString(), chunks, logs: total, splits: stats.splits }, 'backfill complete');
  return { chunks, logs: total, splits: stats.splits };
}

/**
 * getLogs with halving on failure (range too large, too many results, 503…) down to a single block,
 * so an oversized range never silently drops logs. A single failing block still throws.
 */
export async function fetchSplitting(
  reader: ChainReader,
  f: Omit<LogFilter, 'fromBlock' | 'toBlock'>,
  from: bigint,
  to: bigint,
  stats: { splits: number },
): Promise<RawLog[]> {
  try {
    return await reader.getLogs({ ...f, fromBlock: from, toBlock: to });
  } catch (e) {
    if (from >= to) throw e;
    stats.splits++;
    const mid = from + (to - from) / 2n;
    return [...(await fetchSplitting(reader, f, from, mid, stats)), ...(await fetchSplitting(reader, f, mid + 1n, to, stats))];
  }
}
