/** Time-stamped values with a bounded horizon. */
export class RollingEvents {
  private items: { t: number; v: number }[] = [];
  constructor(private readonly horizonMs: number) {}

  push(t: number, v: number) {
    this.items.push({ t, v });
    // Events arrive mostly ordered; keep sorted for backfill stragglers.
    if (this.items.length > 1 && this.items[this.items.length - 2]!.t > t) this.items.sort((a, b) => a.t - b.t);
    this.prune(t);
  }

  /** Sum of values with fromMs < t <= toMs (fromMs exclusive). */
  sum(fromMs: number, toMs: number, predicate?: (v: number) => boolean): number {
    let s = 0;
    for (const it of this.items) if (it.t > fromMs && it.t <= toMs && (!predicate || predicate(it.v))) s += it.v;
    return s;
  }

  firstTime(fromMs: number): number | undefined {
    return this.items.find((i) => i.t > fromMs)?.t;
  }

  private prune(now: number) {
    const cutoff = now - this.horizonMs;
    let i = 0;
    while (i < this.items.length && this.items[i]!.t < cutoff) i++;
    if (i) this.items.splice(0, i);
  }
}

export const minuteOf = (ms: number) => Math.floor(ms / 60_000);

/** Per-minute USD buckets, retaining `keepMinutes`. */
export class MinuteBuckets {
  private buckets = new Map<number, number>();
  firstMinute?: number;
  constructor(private readonly keepMinutes = 24 * 60 + 5) {}

  add(ms: number, v: number) {
    const m = minuteOf(ms);
    this.buckets.set(m, (this.buckets.get(m) ?? 0) + v);
    if (this.firstMinute === undefined || m < this.firstMinute) this.firstMinute = m;
    if (this.buckets.size > this.keepMinutes + 60) {
      const cutoff = m - this.keepMinutes;
      for (const k of this.buckets.keys()) if (k < cutoff) this.buckets.delete(k);
    }
  }

  /** Sum of minutes in [fromMinute, toMinute]. */
  sumMinutes(fromMinute: number, toMinute: number): number {
    let s = 0;
    for (let m = fromMinute; m <= toMinute; m++) s += this.buckets.get(m) ?? 0;
    return s;
  }

  /** Sum over the trailing window ending at `nowMs` (inclusive of current minute). */
  sumWindow(nowMs: number, minutes: number): number {
    const m = minuteOf(nowMs);
    return this.sumMinutes(m - minutes + 1, m);
  }

  /** Per-minute values for [fromMinute, toMinute], clipped to minutes since first observation. */
  series(fromMinute: number, toMinute: number): number[] {
    const start = Math.max(fromMinute, this.firstMinute ?? toMinute + 1);
    const out: number[] = [];
    for (let m = start; m <= toMinute; m++) out.push(this.buckets.get(m) ?? 0);
    return out;
  }
}

/** Last observed value per minute (e.g. price), for "value N minutes ago". */
export class MinuteLast {
  private points: { m: number; v: number }[] = [];
  constructor(private readonly keepMinutes = 180) {}

  set(ms: number, v: number) {
    const m = minuteOf(ms);
    const last = this.points[this.points.length - 1];
    if (last && last.m === m) last.v = v;
    else if (!last || last.m < m) this.points.push({ m, v });
    const cutoff = m - this.keepMinutes;
    while (this.points.length && this.points[0]!.m < cutoff) this.points.shift();
  }

  /** Last value at or before minute m. */
  at(m: number): number | undefined {
    for (let i = this.points.length - 1; i >= 0; i--) if (this.points[i]!.m <= m) return this.points[i]!.v;
    return undefined;
  }

  get first() {
    return this.points[0];
  }
}

export function meanStd(xs: number[]): { mean: number; std: number } {
  if (!xs.length) return { mean: 0, std: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { mean, std: Math.sqrt(variance) };
}
