/**
 * notify — single-webhook Discord client for the executor.
 *
 *   - serial queue, 429 retry_after honoured, 5xx retried, then logged
 *   - DISCORD_DRY_RUN=1 (default): payloads logged, never POSTed
 *   - per-event enable flags from config/executor.json `notify`
 *   - NEVER throws into the caller: a webhook failure must not block a trade
 *
 * This module never pings. No mentions of any kind are attached, and
 * allowed_mentions.parse is always empty. Enforced by test/unit/no-ping.test.ts.
 */

import type { EventName } from './config.js';
import { C, log } from './log.js';

export interface Field {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title: string;
  description?: string;
  color: number;
  fields: Field[];
  footer: { text: string };
  timestamp: string;
  url?: string;
}

export interface Payload {
  username?: string;
  embeds: Embed[];
  allowed_mentions: { parse: [] };
}

export const COLORS = { info: 0x3498db, ok: 0x2ecc71, warn: 0xe67e22, error: 0xe74c3c } as const;

export const BASE_EXPLORER = 'https://basescan.org';
export const ARC_EXPLORER = 'https://www.arcexplorer.org';

export const short = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);
export const baseTx = (hash: string) => `[${short(hash)}](${BASE_EXPLORER}/tx/${hash})`;
export const arcTx = (hash: string) => `[${short(hash)}](${ARC_EXPLORER}/tx/${hash})`;
export const arcAddr = (a: string, label?: string) => `[${label ?? short(a)}](${ARC_EXPLORER}/address/${a})`;

export function embed(o: { title: string; color: number; fields: Field[]; description?: string; url?: string; elapsedMs?: number }): Embed {
  const fields = [...o.fields];
  if (o.elapsedMs !== undefined) fields.push({ name: 'elapsed', value: `${o.elapsedMs} ms`, inline: true });
  return {
    title: o.title,
    description: o.description,
    color: o.color,
    fields,
    footer: { text: 'ak-arc executor | never pings' },
    timestamp: new Date().toISOString(),
    url: o.url,
  };
}

export interface NotifierOptions {
  webhook?: string;
  dryRun: boolean;
  enabled: Record<EventName, boolean>;
  username?: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  logFn?: (msg: string) => void;
}

export class Notifier {
  /** Every payload that passed the enable flag, dry-run or not (dry-run summary, tests). */
  readonly emitted: { event: EventName; payload: Payload }[] = [];
  private chain: Promise<void> = Promise.resolve();
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly logFn: (msg: string) => void;

  constructor(private readonly o: NotifierOptions) {
    this.fetchFn = o.fetchFn ?? ((input, init) => fetch(input, init));
    this.sleepFn = o.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logFn = o.logFn ?? log;
  }

  /** Enqueue. Resolves when delivered, dropped, or failed — never rejects. */
  emit(event: EventName, e: Embed): Promise<void> {
    if (!this.o.enabled[event]) return Promise.resolve();
    // Unset by default: let the webhook use the name/avatar configured for it on Discord.
    const payload: Payload = { username: this.o.username, embeds: [e], allowed_mentions: { parse: [] } };
    this.emitted.push({ event, payload });
    const next = this.chain.then(() => this.deliver(event, payload)).catch((err) => this.logFn(C.red(`discord ${event} failed: ${String((err as Error)?.message ?? err)}`)));
    this.chain = next;
    return next;
  }

  /** Wait for the queue to drain (bounded by the caller). */
  flush(): Promise<void> {
    return this.chain;
  }

  private async deliver(event: EventName, payload: Payload, attempt = 0): Promise<void> {
    if (this.o.dryRun) {
      this.logFn(`${C.dim('discord (dry-run)')} ${event} ${C.dim(JSON.stringify(payload))}`);
      return;
    }
    if (!this.o.webhook) {
      this.logFn(C.yellow(`discord ${event}: DISCORD_WH_EXECUTOR unset; dropping`));
      return;
    }
    const res = await this.fetchFn(`${this.o.webhook}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 429 && attempt < 5) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 50;
      this.logFn(C.yellow(`discord 429; backing off ${waitMs} ms`));
      await this.sleepFn(waitMs);
      return this.deliver(event, payload, attempt + 1);
    }
    if (res.status >= 500 && attempt < 3) {
      await this.sleepFn(1000 * 2 ** attempt);
      return this.deliver(event, payload, attempt + 1);
    }
    if (!res.ok) throw new Error(`discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
    this.logFn(`${C.dim('discord')} ${event} posted`);
  }
}
