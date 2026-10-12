import { zeroAddress, type Address } from 'viem';

export interface TransferEntry {
  id: string; // txHash:logIndex
  block: bigint;
  from: Address;
  to: Address;
  value: bigint;
}

export interface HolderSnapshot {
  birthBlock?: string;
  startBlock?: string;
  coveredFrom?: string;
  syncedTo: string;
  complete: boolean;
  capped: boolean;
  recentIds: string[];
}

/**
 * Per-token holder state.
 *
 * holders≈ and top10% are only authoritative once `sinceBirth` is true, i.e. every Transfer from the token's creation
 * block up to `syncedTo` has been applied (birth backfill completed, or tracking literally started at birth).
 * Until then: holders≈ falls back to "unique participants in the last 24h" and top10% is undefined (digest: n/a).
 *
 * Coverage is one contiguous RPC-complete block interval [coveredFrom, syncedTo]:
 *  - applyBackward(entries, from): history below coveredFrom (backfill runs head → birth, so young tokens finish first)
 *  - applyRange(entries, to): new blocks above syncedTo (periodic sync)
 *  - onTransfer(..., id, block): live pipeline events (anywhere outside coverage)
 * Dedupe rule: a log is applied at most once — skipped if its block is inside coverage or its id is in `recent`
 * (applied live outside coverage). Additions commute, so the order of feeds doesn't matter.
 */
export class HolderTracker {
  private lastSeen = new Map<Address, number>();
  private balances = new Map<Address, bigint>();
  private recent = new Map<string, bigint>();
  /** Addresses whose balance changed since the last checkpoint. */
  readonly dirty = new Set<Address>();
  private _sinceBirth: boolean;
  /** Balances are being maintained (backfill started or tracking from birth). */
  live: boolean;
  syncedTo = -1n;
  /** Lower bound of coverage; coverage is empty while coveredFrom > syncedTo. */
  coveredFrom = 0n;
  birthBlock?: bigint;
  startBlock?: bigint;
  /** Scan could not start at birth (BACKFILL cap): balances are partial, never authoritative. */
  capped = false;

  constructor(
    sinceBirth = false,
    private readonly windowMs = 24 * 3600_000,
  ) {
    this._sinceBirth = sinceBirth;
    this.live = sinceBirth;
  }

  get sinceBirth() {
    return this._sinceBirth;
  }

  /** Live event from the pipeline. `id`/`block` enable dedupe against historical ranges. */
  onTransfer(t: number, from: Address, to: Address, value: bigint, id?: string, block?: bigint) {
    for (const a of [from, to]) if (a !== zeroAddress) this.lastSeen.set(a, t);
    if (this.lastSeen.size > 200_000) this.gc(t);
    if (!this.live) return;
    if (id !== undefined && block !== undefined) {
      if (this.covers(block) || this.recent.has(id)) return;
      this.recent.set(id, block);
    }
    this.apply(from, to, value);
  }

  covers(block: bigint) {
    return block >= this.coveredFrom && block <= this.syncedTo;
  }

  get hasCoverage() {
    return this.coveredFrom <= this.syncedTo;
  }

  /** Apply an RPC-complete range [syncedTo+1, toBlock] (entries may be unsorted); advances syncedTo. */
  applyRange(entries: TransferEntry[], toBlock: bigint) {
    for (const e of entries) {
      if (this.covers(e.block) || this.recent.has(e.id)) continue;
      this.apply(e.from, e.to, e.value);
    }
    if (toBlock > this.syncedTo) this.syncedTo = toBlock;
    this.prune();
  }

  /** Apply an RPC-complete range [fromBlock, coveredFrom-1]; lowers coveredFrom (never below startBlock). */
  applyBackward(entries: TransferEntry[], fromBlock: bigint) {
    const floor = this.startBlock ?? 0n;
    for (const e of entries) {
      if (e.block < floor || this.covers(e.block) || this.recent.has(e.id)) continue;
      this.apply(e.from, e.to, e.value);
    }
    const nf = fromBlock > floor ? fromBlock : floor;
    if (nf < this.coveredFrom) this.coveredFrom = nf;
    this.prune();
  }

  private prune() {
    for (const [id, b] of this.recent) if (this.covers(b)) this.recent.delete(id);
  }

  /**
   * Start maintaining balances from `startBlock` (= birth unless capped). Coverage starts empty at startBlock, so a
   * forward scan works as-is; call anchor(head) to scan backwards instead.
   */
  beginBackfill(birthBlock: bigint, startBlock: bigint) {
    this.birthBlock = birthBlock;
    this.startBlock = startBlock;
    this.capped = startBlock > birthBlock;
    if (!this.hasCoverage) {
      this.coveredFrom = startBlock;
      this.syncedTo = startBlock - 1n;
    }
    this.live = true;
  }

  /** Re-anchor empty coverage at `head` for a head → birth backward scan. */
  anchor(head: bigint) {
    if (this.hasCoverage) return;
    this.coveredFrom = head + 1n;
    this.syncedTo = head;
    this.prune();
  }

  /** History fully covered from start (birth) upward. */
  get historyComplete() {
    return this.startBlock !== undefined && this.hasCoverage && this.coveredFrom <= this.startBlock;
  }

  /**
   * Called when syncedTo reached the chain head after a scan that started at birth.
   * Integrity gate: if `totalSupply` is given, Σ balances must equal it exactly (standard ERC-20: every mint/burn is a
   * Transfer from/to 0x0). A mismatch means missed history (e.g. a pruned RPC backend answered for the birth search)
   * or a non-standard token — balances then stay non-authoritative (top10% n/a).
   */
  markSinceBirth(totalSupply?: bigint) {
    if (this.capped || this.birthBlock === undefined || !this.historyComplete) return false;
    if (totalSupply !== undefined) {
      const sum = this.sumBalances();
      this.supplyMismatch = sum === totalSupply ? undefined : { sum, supply: totalSupply };
      if (this.supplyMismatch) return false;
    }
    this._sinceBirth = true;
    return true;
  }

  /** Re-verification failed later (rebase, missed range): balances are no longer authoritative. */
  revoke(sum: bigint, supply: bigint) {
    this.supplyMismatch = { sum, supply };
    this._sinceBirth = false;
  }

  /** Set when Σ balances != totalSupply at the last verification. */
  supplyMismatch?: { sum: bigint; supply: bigint };

  /** Negative balances right now. Transient while backfilling (a live sell can precede its historic buy); after full history, >0 means a non-standard token or missed logs. */
  get negatives(): number {
    let n = 0;
    for (const b of this.balances.values()) if (b < 0n) n++;
    return n;
  }

  sumBalances(): bigint {
    let s = 0n;
    for (const b of this.balances.values()) s += b;
    return s;
  }

  private apply(from: Address, to: Address, value: bigint) {
    if (from !== zeroAddress) {
      const nb = (this.balances.get(from) ?? 0n) - value;
      this.balances.set(from, nb);
      this.dirty.add(from);
    }
    if (to !== zeroAddress) {
      this.balances.set(to, (this.balances.get(to) ?? 0n) + value);
      this.dirty.add(to);
    }
  }

  /** Unique non-zero Transfer participants in the last 24h (fallback metric). */
  approxHolders(nowMs: number): number {
    let n = 0;
    for (const t of this.lastSeen.values()) if (nowMs - t <= this.windowMs) n++;
    return n;
  }

  /** Addresses with a positive balance — only when sinceBirth, else undefined. */
  holderCount(): number | undefined {
    if (!this._sinceBirth) return undefined;
    let n = 0;
    for (const b of this.balances.values()) if (b > 0n) n++;
    return n;
  }

  /** Largest positive balances, excluding `exclude` (lowercase addresses). */
  topHolders(n: number, exclude: Set<string> = new Set()): [Address, bigint][] {
    return [...this.balances.entries()]
      .filter(([a, b]) => b > 0n && !exclude.has(a))
      .sort((x, y) => (x[1] > y[1] ? -1 : x[1] < y[1] ? 1 : 0))
      .slice(0, n);
  }

  /** Share of supply held by the 10 largest balances (0..1), excluding `exclude` (pools/pad contracts/burn). */
  top10Share(totalSupply: bigint | undefined, exclude: Set<string> = new Set()): number | undefined {
    if (!this._sinceBirth || !totalSupply || totalSupply === 0n) return undefined;
    const sum = this.topHolders(10, exclude).reduce((a, [, b]) => a + b, 0n);
    return Number((sum * 1_000_000n) / totalSupply) / 1_000_000;
  }

  balanceOf(a: Address) {
    return this.balances.get(a);
  }

  snapshot(): HolderSnapshot {
    return {
      birthBlock: this.birthBlock?.toString(),
      startBlock: this.startBlock?.toString(),
      coveredFrom: this.coveredFrom.toString(),
      syncedTo: this.syncedTo.toString(),
      complete: this._sinceBirth,
      capped: this.capped,
      recentIds: [...this.recent.entries()].map(([id, b]) => `${id}@${b}`),
    };
  }

  /** Changed balances since last checkpoint; clears the dirty set. */
  takeDirty(): [Address, bigint][] {
    const out = [...this.dirty].map((a) => [a, this.balances.get(a) ?? 0n] as [Address, bigint]);
    this.dirty.clear();
    return out;
  }

  /** Returns false for snapshots from an older format (caller should discard them and rescan). */
  restore(s: HolderSnapshot, balances: Iterable<[Address, bigint]>): boolean {
    if (s.coveredFrom === undefined) return false;
    this.balances = new Map(balances);
    this.coveredFrom = BigInt(s.coveredFrom);
    this.startBlock = s.startBlock !== undefined ? BigInt(s.startBlock) : undefined;
    this.birthBlock = s.birthBlock !== undefined ? BigInt(s.birthBlock) : undefined;
    this.syncedTo = BigInt(s.syncedTo);
    this.capped = s.capped;
    this._sinceBirth = s.complete;
    this.recent = new Map(
      s.recentIds.map((x) => {
        const i = x.lastIndexOf('@');
        return [x.slice(0, i), BigInt(x.slice(i + 1))];
      }),
    );
    this.live = true;
    this.dirty.clear();
    return true;
  }

  private gc(now: number) {
    for (const [a, t] of this.lastSeen) if (now - t > this.windowMs) this.lastSeen.delete(a);
  }
}
