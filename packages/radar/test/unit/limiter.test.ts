import { describe, expect, it } from 'vitest';
import { isTransient, withRetry } from '../../src/rpc/limiter.js';

describe('transient RPC errors (retried) vs range errors (split instead)', () => {
  it.each([
    'Request exceeds defined limit.\n\nURL: https://rpc.arc-scan.org', // viem -32005 (arc-scan rate limit)
    'An internal error was received.\n\nURL: https://rpc.arc-scan.org', // viem -32603 (arc-scan 503)
    'arc-scan.org could not complete this request. No answer was obtained',
    'HTTP request failed. Status: 429',
    'fetch failed',
    'The request timed out.',
  ])('transient: %s', (m) => expect(isTransient(new Error(m))).toBe(true));
  it.each(['eth_getLogs is limited to a 10,000 range', 'eth_getLogs is limited to a 5 range, upgrade from discover plan', 'execution reverted'])('not transient: %s', (m) =>
    expect(isTransient(new Error(m))).toBe(false),
  );
  it('withRetry retries transient errors with backoff, then succeeds', async () => {
    let n = 0;
    const v = await withRetry(async () => (++n < 3 ? Promise.reject(new Error('Request exceeds defined limit')) : 'ok'), 5, 1);
    expect([v, n]).toEqual(['ok', 3]);
  });
  it('withRetry does not retry range errors', async () => {
    let n = 0;
    await expect(withRetry(async () => (n++, Promise.reject(new Error('limited to a 10,000 range'))), 5, 1)).rejects.toThrow();
    expect(n).toBe(1);
  });
});
