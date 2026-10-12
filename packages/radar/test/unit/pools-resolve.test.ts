import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { PoolRegistry } from '../../src/features/pools.js';
import type { ChainReader } from '../../src/rpc/reader.js';

const USDC = '0x3600000000000000000000000000000000000000' as Address;
const TOKEN = '0xaaaa00000000000000000000000000000000a001' as Address;
const POOL = '0x9001000000000000000000000000000000009001' as Address;
const FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918' as Address;

afterEach(() => vi.restoreAllMocks());

describe('PoolRegistry: a throttled resolution never leaves a real pool permanently untrusted', () => {
  it('incomplete result → retried after 60s → trusted', async () => {
    let throttled = true;
    const reader = {
      poolOnchain: async () => (throttled ? { incomplete: true } : { factory: FACTORY, token0: USDC, token1: TOKEN, fee: 10000 }),
      erc20Meta: async () => ({ decimals: 18 }),
      factoryLookup: async () => POOL,
    } as unknown as ChainReader;
    const reg = new PoolRegistry(reader, new Map([[FACTORY, { name: 'UniswapV3-Arc', kind: 'univ3', role: 'amm' }]]), USDC, () => 6, 600_000);
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = await reg.ensure(POOL, 'univ3');
    expect(first).toMatchObject({ trusted: false, resolveIncomplete: true });
    throttled = false;
    now += 10_000;
    expect((await reg.ensure(POOL, 'univ3')).trusted).toBe(false); // not before the retry interval
    now += 60_000;
    expect(await reg.ensure(POOL, 'univ3')).toMatchObject({ trusted: true, usdcSide: 0, tokenDecimals: 18, resolveIncomplete: undefined });
  });

  it('genuinely foreign pool (factory lookup disagrees) stays untrusted', async () => {
    const reader = {
      poolOnchain: async () => ({ factory: FACTORY, token0: USDC, token1: TOKEN, fee: 3000 }),
      erc20Meta: async () => ({ decimals: 18 }),
      factoryLookup: async () => '0x9bad00000000000000000000000000000000c001' as Address,
    } as unknown as ChainReader;
    const reg = new PoolRegistry(reader, new Map([[FACTORY, { name: 'UniswapV3-Arc', kind: 'univ3', role: 'amm' }]]), USDC, () => 6, 600_000);
    expect(await reg.ensure(POOL, 'univ3')).toMatchObject({ trusted: false });
  });
});
