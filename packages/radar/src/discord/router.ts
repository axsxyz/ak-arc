import type { Clock } from '../clock.js';
import type { Config } from '../config/env.js';
import type { Logger } from '../log.js';
import { decide, type Decision } from '../score/gate.js';
import type { Signal } from '../score/types.js';
import { makePayload, type DiscordSink, type Post } from './client.js';
import { buildEmbed } from './embeds.js';

export interface RouteResult {
  signal: Signal;
  decision: Decision;
  post?: Post;
  suppressed?: 'dedupe' | 'warm';
}

type FireListener = (s: Signal, d: Decision) => void;

/** Signal → dedupe → gate → embed → sink. */
export class Router {
  private seen = new Map<string, { t: number; rank: number }>(); // dedupeKey -> last post time + severity rank
  private listeners: FireListener[] = [];
  /** Signals about events older than this (warm-start history, pre-boot catch-up) update state but never post. */
  private liveFromMs?: number;
  mutedCount = 0;

  constructor(
    private readonly cfg: Config,
    private readonly sink: DiscordSink,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  setLiveFrom(ms: number) {
    this.liveFromMs = ms;
  }

  onFire(fn: FireListener) {
    this.listeners.push(fn);
  }

  async route(s: Signal): Promise<RouteResult> {
    const windowMs = this.cfg.thresholds.dedupeSec * 1000;
    const last = this.seen.get(s.dedupeKey);
    const rank = signalRank(s);
    // Same subject within the window is suppressed unless it escalates (e.g. LP_WATCH -> LP_SURGE).
    if (last !== undefined && Math.abs(s.eventTimeMs - last.t) < windowMs && rank <= last.rank) {
      this.log.debug({ key: s.dedupeKey, type: s.type }, 'suppressed duplicate');
      return { signal: s, decision: { channel: undefined, ping_everyone: false, reason: 'dedupe' }, suppressed: 'dedupe' };
    }
    const decision = decide(s, this.cfg.pingEnabled);
    this.seen.set(s.dedupeKey, { t: s.eventTimeMs, rank });
    this.gc(s.eventTimeMs, windowMs);
    if (this.liveFromMs !== undefined && s.eventTimeMs < this.liveFromMs) {
      this.mutedCount++;
      this.log.debug({ type: s.type, key: s.dedupeKey, channel: decision.channel }, 'historic signal muted (warm start)');
      return { signal: s, decision, suppressed: 'warm' };
    }
    if (!decision.channel) {
      this.log.info({ type: s.type, key: s.dedupeKey, reason: decision.reason, usd: s.usd }, 'signal (logs only)');
      return { signal: s, decision };
    }
    const embed = buildEmbed(s, this.cfg.network, this.clock.now());
    const post: Post = { channel: decision.channel, payload: makePayload(decision.channel, embed, decision, this.cfg.discordUsername) };
    this.log.info({ type: s.type, channel: decision.channel, ping: decision.ping_everyone, reason: decision.reason }, 'signal routed');
    for (const l of this.listeners) l(s, decision);
    await this.sink.send(post);
    return { signal: s, decision, post };
  }

  private gc(nowMs: number, windowMs: number) {
    if (this.seen.size < 5000) return;
    for (const [k, v] of this.seen) if (nowMs - v.t > windowMs * 2) this.seen.delete(k);
  }
}

const SEVERITY_RANK = { info: 0, watch: 1, alert: 2 } as const;
function signalRank(s: Signal): number {
  return SEVERITY_RANK[s.severity] + (s.hardRule ? 1 : 0);
}
