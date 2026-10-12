import { describe, expect, it, vi } from 'vitest';
import { EVENTS, type EventName } from '../../src/config.js';
import { COLORS, embed, Notifier } from '../../src/notify.js';

const enabled = Object.fromEntries(EVENTS.map((e) => [e, true])) as Record<EventName, boolean>;
const e = () => embed({ title: 't', color: COLORS.info, fields: [{ name: 'a', value: 'b' }], elapsedMs: 12 });

describe('notify: dry-run default, queue, 429, never throws', () => {
  it('dry-run logs and never calls fetch; payload carries no mentions', async () => {
    const fetchFn = vi.fn();
    const logs: string[] = [];
    const n = new Notifier({ dryRun: true, enabled, fetchFn: fetchFn as unknown as typeof fetch, logFn: (m) => logs.push(m) });
    await n.emit('trade.fill', e());
    expect(fetchFn).not.toHaveBeenCalled();
    expect(n.emitted).toHaveLength(1);
    expect(n.emitted[0]!.payload.allowed_mentions).toEqual({ parse: [] });
    expect('content' in n.emitted[0]!.payload).toBe(false);
    expect(logs.some((l) => l.includes('dry-run'))).toBe(true);
  });
  it('disabled events are dropped before the queue', async () => {
    const n = new Notifier({ dryRun: true, enabled: { ...enabled, 'trade.preflight': false } });
    await n.emit('trade.preflight', e());
    expect(n.emitted).toHaveLength(0);
  });
  it('429 honours retry_after then retries; posts are serial', async () => {
    const calls: number[] = [];
    const waits: number[] = [];
    const fetchFn = vi.fn(async () => {
      calls.push(Date.now());
      if (calls.length === 1) return new Response(JSON.stringify({ retry_after: 0.25 }), { status: 429 });
      return new Response('{}', { status: 200 });
    });
    const n = new Notifier({ dryRun: false, webhook: 'https://discord.com/api/webhooks/1/x', enabled, fetchFn: fetchFn as unknown as typeof fetch, sleepFn: async (ms) => void waits.push(ms), logFn: () => undefined });
    await n.emit('trade.fill', e());
    await n.emit('trade.sell', e());
    await n.flush();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([300]);
  });
  it('a throwing fetch never rejects emit (a webhook failure must not block a trade)', async () => {
    const n = new Notifier({ dryRun: false, webhook: 'https://discord.com/api/webhooks/1/x', enabled, fetchFn: (async () => { throw new Error('boom'); }) as unknown as typeof fetch, logFn: () => undefined });
    await expect(n.emit('error.abort', e())).resolves.toBeUndefined();
    await expect(n.emit('trade.fill', e())).resolves.toBeUndefined();
  });
  it('unset webhook in live mode drops with a log, no throw', async () => {
    const logs: string[] = [];
    const n = new Notifier({ dryRun: false, enabled, logFn: (m) => logs.push(m) });
    await n.emit('trade.fill', e());
    expect(logs.join()).toMatch(/DISCORD_WH_EXECUTOR unset/);
  });
});
