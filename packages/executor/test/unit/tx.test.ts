import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from 'viem';
import { quoteAtSpot, swapAmounts, swapCalldata } from '../../src/buy.js';
import { NonceTracker, POOL_ABI, pollState } from '../../src/chain.js';
import { finalityFields } from '../../src/mint-watch.js';

const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;

describe('buy: quote + calldata', () => {
  it('quoteAtSpot: $100 at 0.0026 → 38461.53… tokens, minOut 3% lower', () => {
    const q = quoteAtSpot({ amountIn: 100_000_000n, spotUsd: 0.0026, tokenDecimals: 18, slippageBps: 300 });
    expect(q.expectedOut / 10n ** 14n).toBe(384615384n); // 38461.5384 tokens
    expect(q.minOut).toBe((q.expectedOut * 9700n) / 10_000n);
  });
  it('swapCalldata is SwapRouter02-shaped: multicall(deadline) wrapping exactInputSingle', () => {
    const { data, deadline } = swapCalldata({ router: A, tokenIn: A, tokenOut: B, fee: 10000, recipient: A, amountIn: 1n, minOut: 1n, deadlineSec: 60, nowMs: 1_700_000_000_000 });
    expect(data.slice(0, 10)).toBe('0x5ae401dc');
    expect(data).toContain('04e45aaf');
    expect(deadline).toBe(1_700_000_060n);
  });
  it('swapAmounts sums the pool Swap events and ignores other logs', () => {
    const abi = parseAbi(['event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)']);
    const topics = encodeEventTopics({ abi, eventName: 'Swap', args: { sender: A, recipient: B } }) as [Hex, ...Hex[]];
    const data = encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [1_000_000n, -5n * 10n ** 18n, 1n, 1n, 0]);
    const r = swapAmounts({ logs: [{ address: B, data: '0x', topics: [] }, { address: A, data, topics }] }, A);
    expect(r).toEqual({ amount0: 1_000_000n, amount1: -5n * 10n ** 18n });
    expect(swapAmounts({ logs: [] }, A)).toBeUndefined();
  });
  it('POOL_ABI exposes the Swap event used for realised fills', () => {
    expect(POOL_ABI.some((x) => x.type === 'event' && x.name === 'Swap')).toBe(true);
  });
});

describe('chain: nonce counter and state polling', () => {
  it('NonceTracker increments locally, once per reservation', () => {
    const n = NonceTracker.fixed(5, A);
    expect(n.peek()).toBe(5);
    expect(n.next()).toBe(5);
    expect(n.next()).toBe(6);
    expect(n.peek()).toBe(7);
  });
  it('pollState: an RPC error is never returned as a value', async () => {
    let i = 0;
    const v = await pollState(async () => { i += 1; if (i < 3) throw new Error('429'); return 42n; }, (x) => x === 42n, { intervalMs: 1, maxMs: 2000 });
    expect(v).toBe(42n);
    const none = await pollState(async () => { throw new Error('503'); }, () => true, { intervalMs: 1, maxMs: 10 });
    expect(none).toBeUndefined();
  });
});

describe('mint-watch: finality field discovery', () => {
  it('lists every key path containing "finality"', () => {
    const m = { status: 'complete', decodedMessage: { finalityThresholdExecuted: 1000, decodedMessageBody: { minFinalityThreshold: 1000 } } };
    expect(finalityFields(m)).toEqual(['decodedMessage.finalityThresholdExecuted=1000', 'decodedMessage.decodedMessageBody.minFinalityThreshold=1000']);
  });
});

describe('gas floor: never spend the USDC that funds the exit', () => {
  const load = async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { loadConfig } = await import('../../src/config.js');
    const root = path.resolve(import.meta.dirname, '../..');
    return loadConfig({ argv: [], env: { PRIVATE_KEY: 'ab'.repeat(32) }, dotenvText: null, jsonText: fs.readFileSync(path.join(root, 'config', 'executor.json'), 'utf8') });
  };
  const GWEI = 1_000_000_000n;
  it('0.5 USDC, buy 0.3 with 2 own txs at 21 Gwei leaves 0.1874 ≥ reserve 0.0378 (6 × 300k × 21 Gwei)', async () => {
    const { gasFloorCheck } = await import('../../src/chain.js');
    const g = gasFloorCheck(await load(), { native18: 5n * 10n ** 17n, spend6: 300_000n, ownTxs: 2, gasPriceWei: 21n * GWEI });
    expect(g.reserve).toBe(6n * 300_000n * 21n * GWEI);
    expect(g.remaining).toBe(5n * 10n ** 17n - 3n * 10n ** 17n - 2n * 300_000n * 21n * GWEI);
    expect(g.ok).toBe(true);
  });
  it('spending 0.48 of 0.5 leaves less than 6 txs of gas: refused', async () => {
    const { gasFloorCheck } = await import('../../src/chain.js');
    expect(gasFloorCheck(await load(), { native18: 5n * 10n ** 17n, spend6: 480_000n, ownTxs: 2, gasPriceWei: 21n * GWEI }).ok).toBe(false);
  });
  it('the reserve scales with the live gas price, not the maxFee cap', async () => {
    const { gasFloorCheck } = await import('../../src/chain.js');
    const cfg = await load();
    expect(gasFloorCheck(cfg, { native18: 5n * 10n ** 17n, spend6: 300_000n, ownTxs: 2, gasPriceWei: 101n * GWEI }).ok).toBe(false);
    expect(gasFloorCheck(cfg, { native18: 5n * 10n ** 17n, spend6: 0n, ownTxs: 0, gasPriceWei: 101n * GWEI }).ok).toBe(true);
  });
});
