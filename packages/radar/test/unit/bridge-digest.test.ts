import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { bridgeFlowDigest } from '../../src/jobs/digests.js';
import type { Pipeline } from '../../src/pipeline.js';

function fakePipeline(windows: { in5?: number; in60?: number; out5?: number; out60?: number }) {
  const publish = vi.fn(async (s: unknown) => s);
  const p = {
    bridgeInflowWindow: (_now: number, minutes: number) => (minutes === 5 ? (windows.in5 ?? 0) : (windows.in60 ?? 0)),
    bridgeOutflowWindow: (_now: number, minutes: number) => (minutes === 5 ? (windows.out5 ?? 0) : (windows.out60 ?? 0)),
    publish,
  } as unknown as Pipeline;
  return { p, publish };
}

const cfg = { bridgeDigestSec: 300 } as Config;

describe('bridgeFlowDigest: skip spam on a quiet corridor', () => {
  it('posts nothing when both windows are flat', async () => {
    const { p, publish } = fakePipeline({});
    const r = await bridgeFlowDigest(p, cfg, 1_000_000);
    expect(r).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });
  it('posts a compact BRIDGE_NET_FLOW with in/out/net when there is flow', async () => {
    const { p, publish } = fakePipeline({ in5: 10_000, in60: 40_000, out5: 0, out60: 15_000 });
    await bridgeFlowDigest(p, cfg, 1_000_000);
    expect(publish).toHaveBeenCalledTimes(1);
    const s = publish.mock.calls[0]![0] as { type: string; compact: boolean; extraFields: { name: string; value: string }[] };
    expect(s.type).toBe('BRIDGE_NET_FLOW');
    expect(s.compact).toBe(true);
    expect(s.extraFields.find((f) => f.name === 'net 1h')?.value).toBe('$25.00k');
  });
});
