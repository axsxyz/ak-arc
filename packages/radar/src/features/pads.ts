import type { Address } from 'viem';
import { migrateRatio } from '../math/price.js';
import { MinuteBuckets } from './volume.js';

interface Launch {
  t: number;
  token: Address;
}

export class PadStats {
  launches: Launch[] = [];
  graduations: Launch[] = [];
  vol = new MinuteBuckets();
  /** token -> launch time, and ms to reach the $X mcap mark. */
  launchTime = new Map<string, number>();
  timeToX = new Map<string, number>();

  constructor(readonly name: string) {}

  onLaunch(t: number, token: Address) {
    if (this.launchTime.has(token)) return;
    this.launchTime.set(token, t);
    this.launches.push({ t, token });
    this.prune(t);
  }

  onGraduate(t: number, token: Address) {
    if (this.graduations.some((g) => g.token === token)) return;
    this.graduations.push({ t, token });
  }

  onMcap(t: number, token: Address, mcapUsd: number, markUsd: number) {
    const lt = this.launchTime.get(token);
    if (lt === undefined || this.timeToX.has(token) || mcapUsd < markUsd) return;
    this.timeToX.set(token, t - lt);
  }

  window(nowMs: number, ms: number) {
    const launched = this.launches.filter((l) => nowMs - l.t <= ms).length;
    const graduated = this.graduations.filter((l) => nowMs - l.t <= ms).length;
    const inWindow = this.launches.filter((l) => nowMs - l.t <= ms).map((l) => this.timeToX.get(l.token));
    const ttx = inWindow.filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    const median = ttx.length ? (ttx.length % 2 ? ttx[(ttx.length - 1) / 2]! : (ttx[ttx.length / 2 - 1]! + ttx[ttx.length / 2]!) / 2) : undefined;
    return {
      launched,
      graduated,
      migrateRatio: migrateRatio(graduated, launched),
      volUsd: this.vol.sumWindow(nowMs, Math.round(ms / 60_000)),
      medianTimeToXMs: median,
    };
  }

  private prune(now: number) {
    const cutoff = now - 48 * 3600_000;
    while (this.launches.length && this.launches[0]!.t < cutoff) this.launches.shift();
    while (this.graduations.length && this.graduations[0]!.t < cutoff) this.graduations.shift();
  }
}
