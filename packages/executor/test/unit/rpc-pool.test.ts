import { describe, expect, it } from 'vitest';
import type { Chain } from 'viem';
import { RpcPool, type Pub } from '../../src/rpc-pool.js';

const chain = { id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['http://a'] } } } as Chain;
const transient = () => Object.assign(new Error('An internal error was received. could not complete this request'), { code: -32603 });
const rejection = () => new Error('nonce too low');

/** Fake endpoint: scripted chainId and a queue of behaviours for sendRawTransaction / getTransaction. */
function fake(url: string, o: { chainId?: number; fails?: number; rejects?: boolean }) {
  let failsLeft = o.fails ?? 0;
  const sent: string[] = [];
  const client = {
    getChainId: async () => o.chainId ?? 5042,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => {
      if (o.rejects) throw rejection();
      if (failsLeft > 0) {
        failsLeft -= 1;
        throw transient();
      }
      sent.push(serializedTransaction);
      return `0xhash-${url}`;
    },
    getTransaction: async () => {
      throw new Error('Transaction could not be found');
    },
    readContract: async () => {
      if (failsLeft > 0) {
        failsLeft -= 1;
        throw transient();
      }
      return 42n;
    },
  } as unknown as Pub;
  return { client, sent, url };
}

function pool(endpoints: ReturnType<typeof fake>[], rotateAfter = 3, logs: string[] = []) {
  const byUrl = new Map(endpoints.map((e) => [e.url, e.client]));
  return new RpcPool({ urls: endpoints.map((e) => e.url), chainId: 5042, rotateAfter, readerRps: 5, readerRetryBaseMs: 1, chain, makeClient: (u) => byUrl.get(u)!, logFn: (m) => logs.push(m) });
}

describe('rpc pool: rotation on consecutive transport failures only', () => {
  it('starts on the first endpoint and rotates after N consecutive transport failures, visibly', async () => {
    const logs: string[] = [];
    const a = fake('http://a', { fails: 3 });
    const b = fake('http://b', {});
    const p = pool([a, b], 3, logs);
    expect(p.activeHost).toBe('a');
    const v = await p.call('read', (c) => c.readContract({} as never), 5, 1);
    expect(v).toBe(42n);
    expect(p.activeHost).toBe('b');
    expect(p.changed).toBe(true);
    expect(logs.some((l) => /RPC rotate: a -> b .*3 consecutive failures/.test(l.replace(/\x1b\[[0-9;]*m/g, '')))).toBe(true);
    expect(p.describe()).toBe('b* (2/2)');
  });
  it('two failures then a success reset the counter: no rotation', async () => {
    const a = fake('http://a', { fails: 2 });
    const b = fake('http://b', {});
    const p = pool([a, b], 3);
    await p.call('read', (c) => c.readContract({} as never), 5, 1);
    expect(p.activeHost).toBe('a');
    expect(p.changed).toBe(false);
  });
  it('a node rejection is thrown immediately, never counted, never rotated', async () => {
    const a = fake('http://a', { rejects: true });
    const b = fake('http://b', {});
    const p = pool([a, b], 1);
    await expect(p.once('broadcast', (c) => c.sendRawTransaction({ serializedTransaction: '0x01' }))).rejects.toThrow(/nonce too low/);
    expect(p.activeHost).toBe('a');
    expect(a.sent).toEqual([]);
  });
  it('a wrong-chain endpoint is dropped from the pool, not skipped once', async () => {
    const logs: string[] = [];
    const wrong = fake('http://wrong', { chainId: 5042002 });
    const ok = fake('http://ok', {});
    const p = pool([wrong, ok], 3, logs);
    await p.call('read', (c) => c.readContract({} as never));
    expect(p.activeHost).toBe('ok');
    expect(p.alive).toBe(1);
    expect(logs.some((l) => /RPC DROPPED wrong: chainId 5042002/.test(l.replace(/\x1b\[[0-9;]*m/g, '')))).toBe(true);
    // a later failure streak on "ok" cannot rotate back to the dropped endpoint
    for (let i = 0; i < 5; i += 1) p.noteFailure('x');
    expect(p.activeHost).toBe('ok');
  });
  it('the same signed bytes are re-sent after a rotation (broadcast invariant at the pool level)', async () => {
    const a = fake('http://a', { fails: 1 });
    const b = fake('http://b', {});
    const p = pool([a, b], 1);
    const raw = '0x02deadbeef';
    await expect(p.once('broadcast', (c) => c.sendRawTransaction({ serializedTransaction: raw }))).rejects.toThrow(/internal error/);
    expect(p.activeHost).toBe('b');
    const h = await p.once('broadcast', (c) => c.sendRawTransaction({ serializedTransaction: raw }));
    expect(h).toBe('0xhash-http://b');
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([raw]);
  });
  it('single endpoint: failures never rotate away, the endpoint stays', async () => {
    const a = fake('http://a', { fails: 4 });
    const p = pool([a], 3);
    await p.call('read', (c) => c.readContract({} as never), 6, 1);
    expect(p.activeHost).toBe('a');
    expect(p.describe()).toBe('a');
  });
});

describe('rpc pool: the reader is chainId-gated and rotates too', () => {
  it('a wrong-chain endpoint listed first is never read; the reader delegates to the verified one', async () => {
    const wrong = fake('http://wrong', { chainId: 8453 });
    const ok = fake('http://ok', {});
    const calls: string[] = [];
    const byUrl = new Map([wrong, ok].map((e) => [e.url, e.client]));
    const p = new RpcPool({
      urls: [wrong.url, ok.url], chainId: 5042, rotateAfter: 3, readerRps: 5, readerRetryBaseMs: 1, chain,
      makeClient: (u) => byUrl.get(u)!,
      makeReader: (u) => ({ erc20Meta: async () => { calls.push(u); return { decimals: 18, symbol: 'X' }; } }) as never,
      logFn: () => undefined,
    });
    const m = await p.reader.erc20Meta('0x0000000000000000000000000000000000000001');
    expect(m.decimals).toBe(18);
    expect(calls).toEqual(['http://ok']);
    expect(p.activeHost).toBe('ok');
  });
  it('throttled reader results (incomplete) count toward rotation', async () => {
    const a = fake('http://a', {});
    const b = fake('http://b', {});
    const byUrl = new Map([a, b].map((e) => [e.url, e.client]));
    const p = new RpcPool({
      urls: [a.url, b.url], chainId: 5042, rotateAfter: 2, readerRps: 5, readerRetryBaseMs: 1, chain,
      makeClient: (u) => byUrl.get(u)!,
      makeReader: (u) => ({ poolOnchain: async () => (u === 'http://a' ? { incomplete: true } : { factory: '0xf', token0: '0x1', token1: '0x2', fee: 100 }) }) as never,
      logFn: () => undefined,
    });
    expect((await p.reader.poolOnchain('0x0000000000000000000000000000000000000009', 'univ3')).incomplete).toBe(true);
    expect((await p.reader.poolOnchain('0x0000000000000000000000000000000000000009', 'univ3')).incomplete).toBe(true);
    expect(p.activeHost).toBe('b');
    expect((await p.reader.poolOnchain('0x0000000000000000000000000000000000000009', 'univ3')).fee).toBe(100);
  });
});

import { classifyError, RpcExhausted } from '../../src/rpc-pool.js';

const httpErr = (status: number, body: string) => Object.assign(new Error(`HTTP request failed. Status: ${status} Details: ${body}`), { status, name: 'HttpRequestError' });

describe('error classification: transport vs quota vs on-chain answer vs node rejection', () => {
  it('classifies the live repro shapes', () => {
    expect(classifyError(transient()).kind).toBe('transient');
    expect(classifyError(httpErr(503, 'Service Unavailable')).kind).toBe('transient');
    expect(classifyError(httpErr(429, 'Too Many Requests')).kind).toBe('transient'); // a burst, not a quota
    expect(classifyError(httpErr(429, '{"error":"daily request count exceeded, request rate limited"}')).kind).toBe('quota');
    expect(classifyError(httpErr(402, 'payment required')).kind).toBe('quota');
    expect(classifyError(httpErr(403, 'invalid project id')).kind).toBe('quota');
    expect(classifyError(new Error('The contract function "factory" returned no data ("0x").')).kind).toBe('onchain');
    expect(classifyError(new Error('execution reverted')).kind).toBe('onchain');
    expect(classifyError(rejection()).kind).toBe('rejected');
    expect(classifyError(new Error('replacement transaction underpriced')).kind).toBe('rejected');
    expect(classifyError(new Error('something odd')).kind).toBe('unknown');
  });
  it('walks viem cause chains', () => {
    const inner = httpErr(402, 'quota exceeded');
    const outer = Object.assign(new Error('ContractFunctionExecutionError: call failed'), { cause: Object.assign(new Error('rpc'), { cause: inner }) });
    expect(classifyError(outer).kind).toBe('quota');
  });
});

describe('rpc pool: reads are never interpreted as data', () => {
  function scripted(url: string, answers: Array<() => Promise<unknown>>, chainId = 5042) {
    let i = 0;
    const client = { getChainId: async () => chainId, readContract: async () => (answers[Math.min(i++, answers.length - 1)]!)() } as unknown as Pub;
    return { url, client, sent: [] as string[] };
  }
  const mk = (eps: ReturnType<typeof scripted>[], rotateAfter = 2, logs: string[] = []) =>
    new RpcPool({ urls: eps.map((e) => e.url), chainId: 5042, rotateAfter, readerRps: 5, readerRetryBaseMs: 1, chain, makeClient: (u) => new Map(eps.map((e) => [e.url, e.client])).get(u)!, logFn: (m) => logs.push(m.replace(/\x1b\[[0-9;]*m/g, '')) });
  it('a quota-refusing endpoint is DROPPED and the read is answered by the next endpoint', async () => {
    const logs: string[] = [];
    const quota = scripted('http://infura', [() => Promise.reject(httpErr(429, 'daily request count exceeded, request rate limited'))]);
    const ok = scripted('http://ok', [async () => 'factory-address']);
    const p = mk([quota, ok], 3, logs);
    const v = await p.call('pool.factory()', (c) => c.readContract({} as never), 4, 1);
    expect(v).toBe('factory-address');
    expect(p.alive).toBe(1);
    expect(logs.some((l) => /RPC DROPPED infura: quota\/auth on pool\.factory\(\)/.test(l))).toBe(true);
  });
  it('when every endpoint fails on transport, RpcExhausted names the count and says it is not chain data', async () => {
    const a = scripted('http://a', [() => Promise.reject(transient())]);
    const b = scripted('http://b', [() => Promise.reject(httpErr(503, 'bad gateway'))]);
    const p = mk([a, b], 2);
    let err: unknown;
    try { await p.call('pool.factory()', (c) => c.readContract({} as never), 4, 1); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RpcExhausted);
    expect((err as Error).message).toMatch(/^all 2\/2 endpoints failed to read pool\.factory\(\)/);
    expect((err as Error).message).toContain('not on-chain data');
  });
  it('an on-chain answer (returned no data) is thrown immediately, never retried, never rotates', async () => {
    const a = scripted('http://a', [() => Promise.reject(new Error('The contract function "factory" returned no data ("0x").'))]);
    const b = scripted('http://b', [async () => 'never']);
    const p = mk([a, b], 1);
    await expect(p.call('pool.factory()', (c) => c.readContract({} as never), 4, 1)).rejects.toThrow(/returned no data/);
    expect(p.activeHost).toBe('a');
    expect(p.changed).toBe(false);
  });
  it('an unknown error is retried like transport and never becomes data', async () => {
    const a = scripted('http://a', [() => Promise.reject(new Error('weird')), async () => 7n]);
    const p = mk([a], 3);
    expect(await p.call('read', (c) => c.readContract({} as never), 4, 1)).toBe(7n);
  });
});

describe('error classification: viem wrappers around a throttling node', () => {
  it('a ContractFunctionRevertedError with an empty reason over a -32603 internal error is TRANSPORT, not on-chain (live shape)', () => {
    const rpcErr = Object.assign(new Error('An internal error was received.'), { code: -32603, name: 'InternalRpcError', details: 'arc-scan.org could not complete this request. No answer was obtained, so nothing about the result should be assumed.' });
    const reverted = Object.assign(new Error('The contract function "token0" reverted with the following reason:\nAn internal error was received.'), { name: 'ContractFunctionRevertedError', cause: rpcErr });
    const outer = Object.assign(new Error('The contract function "token0" reverted with the following reason:\nAn internal error was received.\n\nContract Call: …'), { name: 'ContractFunctionExecutionError', cause: reverted });
    expect(classifyError(outer).kind).toBe('transient');
  });
  it('a real revert with a reason, a custom error, or "returned no data" stays on-chain', () => {
    expect(classifyError(new Error('The contract function "swap" reverted with the following reason:\nSTF')).kind).toBe('onchain');
    expect(classifyError(new Error('The contract function "getPool" reverted with custom error "Locked()"')).kind).toBe('onchain');
    expect(classifyError(Object.assign(new Error('The contract function "factory" returned no data ("0x").'), { name: 'ContractFunctionZeroDataError' })).kind).toBe('onchain');
    expect(classifyError(new Error('execution reverted')).kind).toBe('onchain');
  });
});
