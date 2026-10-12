import type { Channel } from '../config/env.js';
import type { Logger } from '../log.js';
import type { Decision } from '../score/gate.js';
import type { Embed, WebhookPayload } from './embeds.js';

export interface Post {
  channel: Channel;
  payload: WebhookPayload;
}

export interface DiscordSink {
  send(post: Post): Promise<void>;
}

/** Only this function may attach @everyone, and only when the gate said so for #alerts. */
export function makePayload(channel: Channel, embed: Embed, decision: Decision, username?: string): WebhookPayload {
  const ping = decision.ping_everyone === true && channel === 'alerts';
  if (decision.ping_everyone && channel !== 'alerts') {
    throw new Error(`P0: ping_everyone requested for #${channel}`);
  }
  return ping
    ? { username, content: '@everyone', embeds: [embed], allowed_mentions: { parse: ['everyone'] } }
    : { username, embeds: [embed], allowed_mentions: { parse: [] } };
}

export function assertPayloadSafe(post: Post) {
  const hasPing = (post.payload.content ?? '').includes('@everyone') || post.payload.allowed_mentions.parse.includes('everyone');
  if (hasPing && post.channel !== 'alerts') throw new Error(`P0: @everyone outside #alerts (#${post.channel})`);
}

/** Collects posts in memory (tests, fixtures). */
export class MemorySink implements DiscordSink {
  posts: Post[] = [];
  async send(post: Post) {
    assertPayloadSafe(post);
    this.posts.push(post);
  }
}

/** Real webhook client: per-channel serial queue, 429 retry_after, dry-run kill-switch. */
export class WebhookSink implements DiscordSink {
  private chains = new Map<Channel, Promise<void>>();

  constructor(
    private readonly webhooks: Partial<Record<Channel, string>>,
    private readonly dryRun: boolean,
    private readonly log: Logger,
  ) {}

  send(post: Post): Promise<void> {
    assertPayloadSafe(post);
    const prev = this.chains.get(post.channel) ?? Promise.resolve();
    const next = prev.then(() => this.deliver(post)).catch((e) => this.log.error({ err: String(e), channel: post.channel }, 'discord send failed'));
    this.chains.set(post.channel, next);
    return next;
  }

  private async deliver(post: Post, attempt = 0): Promise<void> {
    if (this.dryRun) {
      this.log.info({ channel: post.channel, dryRun: true, payload: post.payload }, 'discord (dry-run)');
      return;
    }
    const url = this.webhooks[post.channel];
    if (!url) {
      this.log.warn({ channel: post.channel }, 'no webhook configured; dropping');
      return;
    }
    const res = await fetch(`${url}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(post.payload),
    });
    if (res.status === 429 && attempt < 5) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 50;
      this.log.warn({ channel: post.channel, waitMs }, 'discord 429; backing off');
      await new Promise((r) => setTimeout(r, waitMs));
      return this.deliver(post, attempt + 1);
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.deliver(post, attempt + 1);
    }
    if (!res.ok) throw new Error(`discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
