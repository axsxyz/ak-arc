/**
 * pool — resolve a token's DEEPEST TRUSTED USDC pool on the allowlisted
 * UniV3 factories, with the guards that actually stop money:
 *
 *   1. provenance: every candidate comes from factory.getPool and is
 *      round-tripped through the radar's PoolRegistry (factory() must agree)
 *   2. per-token depth floor (trade.tokens[addr].minPoolDepthUsd, else
 *      trade.defaultMinPoolDepthUsd)
 *   3. dominance: the deepest tier must be >= dominanceRatio × the runner-up.
 *      This is the primary dust-pool guard: a fresh pool and a dust pool can
 *      both be small in absolute terms, but two comparable pools mean split
 *      liquidity and the operator must choose explicitly.
 *   4. expectedFeeTier (optional, per token): the deepest tier must match it.
 *
 * The full tier table is logged and shipped in trade.preflight so the
 * choice is auditable afterwards. A failed RPC read is never a zero.
 */

import { getAddress, type Address } from 'viem';
import { PoolRegistry, type FactoryInfo } from '../../radar/src/features/pools.js';
import { v3TokenPriceUsd } from '../../radar/src/math/price.js';
import { toNumber } from '../../radar/src/math/units.js';
import type { ChainReader } from '../../radar/src/rpc/reader.js';
import { univ3FactoryAbi, univ3PoolAbi } from '../../radar/src/abi/univ3.js';
import { classifyError, ERC20, POOL_ABI, rpc, RpcExhausted, USDC_ARC, USDC_DECIMALS, type Pub } from './chain.js';
import type { Config } from './config.js';
import { C, die, log, sleep } from './log.js';
import type { Field } from './notify.js';

export interface Tier {
  fee: number;
  pool: Address;
  factory: Address;
  trusted: boolean;
  usdcSide?: 0 | 1;
  usdcDepth?: number;
  liquidity?: bigint;
  sqrtPriceX96?: bigint;
  spotUsd?: number;
  readError?: string;
}

export interface Choice {
  chosen: Tier;
  runnerUp?: Tier;
  /** chosen depth / runner-up depth (Infinity when the runner-up is empty or absent). */
  dominance: number;
}

export type ChoiceResult = ({ ok: true } & Choice) | { ok: false; reason: string };

/** Pure ranking + guards. `tiers` in any order. */
export function chooseDeepest(tiers: Tier[], g: { minDepthUsd: number; dominanceRatio: number; expectedFeeTier?: number }): ChoiceResult {
  if (!tiers.length) return { ok: false, reason: 'no USDC pool exists for this token on any allowlisted factory' };
  const unreadable = tiers.filter((t) => t.readError || t.usdcDepth === undefined);
  if (unreadable.length) {
    return { ok: false, reason: `depth unreadable for ${unreadable.map((t) => `fee ${t.fee} (${t.readError ?? 'no value'})`).join(', ')}. A failed read is not a zero; retry.` };
  }
  const untrusted = tiers.filter((t) => !t.trusted);
  if (untrusted.length) return { ok: false, reason: `pool(s) failed the factory round-trip: ${untrusted.map((t) => `${t.pool} fee ${t.fee}`).join(', ')}` };
  const ranked = [...tiers].sort((a, b) => b.usdcDepth! - a.usdcDepth!);
  const chosen = ranked[0]!;
  const runnerUp = ranked[1];
  if (chosen.usdcSide === undefined) return { ok: false, reason: `deepest pool ${chosen.pool} has no USDC side` };
  if (chosen.usdcDepth! < g.minDepthUsd) {
    return { ok: false, reason: `deepest pool holds $${chosen.usdcDepth!.toFixed(2)} USDC, below the floor $${g.minDepthUsd} for this token` };
  }
  const dominance = runnerUp && runnerUp.usdcDepth! > 0 ? chosen.usdcDepth! / runnerUp.usdcDepth! : Infinity;
  if (dominance < g.dominanceRatio) {
    return {
      ok: false,
      reason:
        `liquidity is split: fee ${chosen.fee} holds $${chosen.usdcDepth!.toFixed(0)} vs fee ${runnerUp!.fee} $${runnerUp!.usdcDepth!.toFixed(0)} ` +
        `(ratio ${dominance.toFixed(1)} < dominanceRatio ${g.dominanceRatio}). Choose a tier explicitly (trade.tokens[token].expectedFeeTier) after looking.`,
    };
  }
  if (g.expectedFeeTier !== undefined && chosen.fee !== g.expectedFeeTier) {
    return { ok: false, reason: `deepest tier is ${chosen.fee} but config expects ${g.expectedFeeTier}. Liquidity moved; update trade.tokens[token].expectedFeeTier consciously.` };
  }
  return { ok: true, chosen, runnerUp, dominance };
}

export interface ResolvedPool extends Choice {
  token: Address;
  symbol: string;
  tokenDecimals: number;
  tiers: Tier[];
}

export function factoriesMap(cfg: Config): Map<string, FactoryInfo> {
  return new Map(cfg.trade.factories.map((f) => [f.toLowerCase(), { name: 'UniV3-allowlisted', kind: 'univ3', role: 'amm' } as FactoryInfo]));
}

export interface Enumerated {
  token: Address;
  symbol: string;
  tokenDecimals: number;
  tiers: Tier[];
}

/**
 * Enumerate `fees` on every allowlisted factory (factory.getPool is the
 * provenance root; zero address = no pool at that tier) and read each tier
 * sequentially (the public RPC throttles bursts). A throttled tier is re-read
 * on a later pass with a fresh registry (PoolRegistry's own retry window is
 * 60s); it is never ranked as zero. Up to 3 passes.
 */
export async function enumerateTiers(r: { reader: ChainReader; client: Pub }, cfg: Config, token: Address, fees: number[]): Promise<Enumerated> {
  const tokenLc = token.toLowerCase() as Address;
  const usdc = USDC_ARC.toLowerCase() as Address;
  const tokenDecimals = Number(await readOrDie('token.decimals()', () => r.client.readContract({ address: getAddress(tokenLc), abi: ERC20, functionName: 'decimals' }), (d) => `${token} is not an ERC-20: decimals() answered "${d}"`));
  const symbol = await rpc(() => r.client.readContract({ address: getAddress(tokenLc), abi: ERC20, functionName: 'symbol' }), 'token.symbol()').catch(() => '?');
  const [t0, t1] = tokenLc < usdc ? [tokenLc, usdc] : [usdc, tokenLc];

  const candidates: { factory: Address; fee: number; pool: Address }[] = [];
  for (const factory of cfg.trade.factories) {
    for (const fee of fees) {
      let pool: Address | undefined;
      try {
        pool = await r.reader.factoryLookup(factory, 'univ3', t0, t1, fee);
      } catch (e) {
        die(`factory.getPool(${fee}) failed on ${factory}: ${(e as Error).message.split('\n')[0]}`);
      }
      if (pool) candidates.push({ factory, fee, pool });
    }
  }

  const readTier = async (reg: PoolRegistry, c: { factory: Address; fee: number; pool: Address }): Promise<Tier> => {
    const st = await reg.ensure(c.pool, 'univ3');
    const tier: Tier = { fee: c.fee, pool: c.pool, factory: c.factory, trusted: st.trusted, usdcSide: st.usdcSide };
    if (st.resolveIncomplete) tier.readError = 'pool metadata throttled';
    const bal = await r.reader.balanceOf(usdc, c.pool);
    if (bal === undefined) tier.readError = 'balanceOf failed';
    else tier.usdcDepth = toNumber(bal, USDC_DECIMALS);
    const sqrt = await r.reader.v3SqrtPrice(c.pool);
    try {
      tier.liquidity = await rpc(() => r.client.readContract({ address: c.pool, abi: POOL_ABI, functionName: 'liquidity' }));
    } catch (e) {
      tier.readError = `liquidity() failed: ${(e as Error).message.split('\n')[0]!.slice(0, 80)}`;
    }
    if (sqrt !== undefined && st.usdcSide !== undefined) {
      tier.sqrtPriceX96 = sqrt;
      const dec0 = st.usdcSide === 0 ? USDC_DECIMALS : tokenDecimals;
      const dec1 = st.usdcSide === 1 ? USDC_DECIMALS : tokenDecimals;
      tier.spotUsd = v3TokenPriceUsd(sqrt, dec0, dec1, st.usdcSide === 0);
    }
    return tier;
  };
  const tiers: Tier[] = [];
  let reg = new PoolRegistry(r.reader, factoriesMap(cfg), usdc, () => USDC_DECIMALS, 600_000);
  let todo = candidates;
  for (let pass = 1; pass <= 3 && todo.length; pass += 1) {
    if (pass > 1) {
      log(C.yellow(`pass ${pass}: re-reading ${todo.length} throttled tier(s) after a pause`));
      await sleep(2000 * pass);
      reg = new PoolRegistry(r.reader, factoriesMap(cfg), usdc, () => USDC_DECIMALS, 600_000);
    }
    const retry: typeof todo = [];
    for (const c of todo) {
      const t = await readTier(reg, c);
      const i = tiers.findIndex((x) => x.pool === c.pool);
      if (i >= 0) tiers[i] = t;
      else tiers.push(t);
      if (t.readError) retry.push(c);
    }
    todo = retry;
  }
  return { token: tokenLc, symbol, tokenDecimals, tiers: [...tiers].sort((a, b) => (b.usdcDepth ?? -1) - (a.usdcDepth ?? -1)) };
}

/** Enumerate every allowlisted factory × fee tier, read depth/price/liquidity, and choose. Aborts on any guard. */
export async function resolveDeepestPool(r: { reader: ChainReader; client: Pub }, cfg: Config, token: Address): Promise<ResolvedPool> {
  const e = await enumerateTiers(r, cfg, token, cfg.trade.feeTiers);
  console.log(`\n${C.bold(`tier table for ${e.symbol} ${getAddress(token)}`)}\n${tierTable(e.tiers)}`);
  const choice = chooseDeepest(e.tiers, { minDepthUsd: cfg.minPoolDepthFor(token), dominanceRatio: cfg.trade.dominanceRatio, expectedFeeTier: cfg.expectedFeeTierFor(token) });
  if (!choice.ok) die(`pool guard: ${choice.reason}`);
  log(`deepest trusted pool: fee ${choice.chosen.fee} ${choice.chosen.pool} depth $${choice.chosen.usdcDepth!.toFixed(2)} dominance ${fmtDom(choice.dominance)}`);
  return { ...e, chosen: choice.chosen, runnerUp: choice.runnerUp, dominance: choice.dominance };
}

/**
 * Fast path (sell TUI): resolve ONLY the configured expectedFeeTier
 * (getPool + trust round-trip + depth, ~10 reads) so the hotkeys arm in
 * seconds. Trust and the depth floor still abort; the dominance audit runs
 * later via `auditTiers` because the exit must not wait for the dust tiers.
 */
export async function resolveSingleTier(r: { reader: ChainReader; client: Pub }, cfg: Config, token: Address, fee: number): Promise<ResolvedPool> {
  const e = await enumerateTiers(r, cfg, token, [fee]);
  const t = e.tiers[0];
  if (!t) die(`no pool at fee ${fee} for ${token} on any allowlisted factory`);
  if (t.readError || t.usdcDepth === undefined) die(`fee ${fee} pool ${t.pool}: ${t.readError ?? 'depth unreadable'}. A failed read is not a zero; retry.`);
  if (!t.trusted) die(`fee ${fee} pool ${t.pool} failed the factory round-trip`);
  if (t.usdcSide === undefined) die(`fee ${fee} pool ${t.pool} has no USDC side`);
  const floor = cfg.minPoolDepthFor(token);
  if (t.usdcDepth < floor) die(`fee ${fee} pool ${t.pool} holds $${t.usdcDepth.toFixed(2)} USDC, below the floor $${floor}`);
  log(`fast-arm pool: fee ${t.fee} ${t.pool} depth $${t.usdcDepth.toFixed(2)} (single tier; full table audits in the background)`);
  return { ...e, chosen: t, runnerUp: undefined, dominance: Infinity };
}

/**
 * A read whose failure could otherwise be mistaken for chain state. Transport,
 * quota and unknown failures are retried across every endpoint by rpc(); if
 * they all fail the abort says so ("all N endpoints failed"), never "bad
 * pool". Only an on-chain answer (revert / no data) reaches `onchain`.
 */
export async function readOrDie<T>(what: string, fn: () => Promise<T>, onchain: (detail: string) => string): Promise<T> {
  try {
    return await rpc(fn, what);
  } catch (e) {
    if (e instanceof RpcExhausted) die(e.message);
    const k = classifyError(e);
    if (k.kind === 'onchain') die(onchain(k.detail));
    die(`${what}: ${k.kind} error, not retried further (${k.detail}). Nothing about chain state should be assumed.`);
  }
}

export interface CachedPoolObs {
  factory: Address;
  token0: Address;
  token1: Address;
  fee: number;
  usdcDepth: number;
  /** factory.getPool(token0, token1, fee) as answered by the factory itself. */
  roundTrip?: Address;
}

/** Pure: every assertion a cached pool must pass. A wrong cached pool must NEVER fall back to discovery silently. */
export function checkCachedPool(o: CachedPoolObs, e: { pool: Address; token: Address; factories: Address[]; expectedFeeTier: number | undefined; minDepthUsd: number }): { ok: true; usdcSide: 0 | 1 } | { ok: false; reason: string } {
  const lc = (a: string) => a.toLowerCase();
  const usdc = lc(USDC_ARC);
  if (e.expectedFeeTier === undefined) return { ok: false, reason: 'cached pool requires trade.tokens[token].expectedFeeTier' };
  if (!e.factories.map(lc).includes(lc(o.factory))) return { ok: false, reason: `factory() ${o.factory} is not allowlisted` };
  const pair = [lc(o.token0), lc(o.token1)];
  if (!pair.includes(usdc) || !pair.includes(lc(e.token))) return { ok: false, reason: `token0/token1 ${o.token0}/${o.token1} are not ${e.token}/USDC` };
  if (o.fee !== e.expectedFeeTier) return { ok: false, reason: `fee() ${o.fee} != expectedFeeTier ${e.expectedFeeTier}` };
  if (o.roundTrip !== undefined && lc(o.roundTrip) !== lc(e.pool)) return { ok: false, reason: `factory.getPool returns ${o.roundTrip}, not the cached ${e.pool}` };
  if (o.usdcDepth < e.minDepthUsd) return { ok: false, reason: `depth $${o.usdcDepth.toFixed(2)} below the floor $${e.minDepthUsd}` };
  return { ok: true, usdcSide: lc(o.token0) === usdc ? 0 : 1 };
}

/**
 * Cached-pool path (trade.tokens[addr].pool): no discovery. Read the ONE
 * address and assert factory (allowlisted, and the factory's own getPool
 * agrees), tokens, fee and depth. Any mismatch aborts loudly.
 */
export async function resolveCachedPool(r: { reader: ChainReader; client: Pub }, cfg: Config, token: Address, pool: Address): Promise<ResolvedPool> {
  const t0 = Date.now();
  const tokenLc = token.toLowerCase() as Address;
  // Every read below goes through rpc(): transport/quota/unknown failures retry across the pool and, if all endpoints
  // fail, abort as an RPC failure. Only an on-chain answer (revert / no data) may say "this is not a pool".
  const notPool = (fnName: string) => (detail: string) => `cached pool ${pool} is NOT the pool we expected: ${fnName}() answered with "${detail}" (no such function at that address?). Fix trade.tokens[${tokenLc}].pool or remove it to re-discover.`;
  const factory = (await readOrDie('pool.factory()', () => r.client.readContract({ address: pool, abi: univ3PoolAbi, functionName: 'factory' }), notPool('factory'))).toLowerCase() as Address;
  const token0 = (await readOrDie('pool.token0()', () => r.client.readContract({ address: pool, abi: univ3PoolAbi, functionName: 'token0' }), notPool('token0'))).toLowerCase() as Address;
  const token1 = (await readOrDie('pool.token1()', () => r.client.readContract({ address: pool, abi: univ3PoolAbi, functionName: 'token1' }), notPool('token1'))).toLowerCase() as Address;
  const fee = Number(await readOrDie('pool.fee()', () => r.client.readContract({ address: pool, abi: univ3PoolAbi, functionName: 'fee' }), notPool('fee')));
  const decimals = Number(await readOrDie('token.decimals()', () => r.client.readContract({ address: getAddress(tokenLc), abi: ERC20, functionName: 'decimals' }), (d) => `${token} is not an ERC-20: decimals() answered "${d}"`));
  const symbol = await rpc(() => r.client.readContract({ address: getAddress(tokenLc), abi: ERC20, functionName: 'symbol' }), 'token.symbol()').catch(() => '?');
  // The factory's own registry must agree (factory() is self-reported). A revert here is an answer: not that factory's pool.
  const roundTrip = (await readOrDie('factory.getPool()', () => r.client.readContract({ address: getAddress(factory), abi: univ3FactoryAbi, functionName: 'getPool', args: [getAddress(token0), getAddress(token1), fee] }), (d) => `cached pool ${pool}: its factory() ${factory} does not answer getPool ("${d}"): not an allowlisted UniV3 factory`)).toLowerCase() as Address;
  const bal = await readOrDie('pool USDC balance', () => r.client.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [pool] }), (d) => `USDC balanceOf(${pool}) reverted ("${d}")`);
  const usdcDepth = toNumber(bal, USDC_DECIMALS);
  const verdict = checkCachedPool(
    { factory, token0, token1, fee, usdcDepth, roundTrip },
    { pool, token: tokenLc, factories: cfg.trade.factories, expectedFeeTier: cfg.expectedFeeTierFor(token), minDepthUsd: cfg.minPoolDepthFor(token) },
  );
  if (!verdict.ok) die(`cached pool ${pool} is NOT the pool we expected: ${verdict.reason}. Fix trade.tokens[${tokenLc}].pool or remove it to re-discover.`);
  const slot0 = await readOrDie('pool.slot0()', () => r.client.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' }), notPool('slot0'));
  const liquidity = await readOrDie('pool.liquidity()', () => r.client.readContract({ address: pool, abi: POOL_ABI, functionName: 'liquidity' }), notPool('liquidity'));
  const dec0 = verdict.usdcSide === 0 ? USDC_DECIMALS : decimals;
  const dec1 = verdict.usdcSide === 1 ? USDC_DECIMALS : decimals;
  const tier: Tier = { fee, pool, factory, trusted: true, usdcSide: verdict.usdcSide, usdcDepth, liquidity, sqrtPriceX96: slot0[0], spotUsd: v3TokenPriceUsd(slot0[0], dec0, dec1, verdict.usdcSide === 0) };
  log(`cached pool OK (${Date.now() - t0} ms): ${pool} factory ${factory} fee ${fee} depth $${usdcDepth.toFixed(2)} (asserted, not discovered; full table audits in the background)`);
  return { token: tokenLc, symbol, tokenDecimals: decimals, tiers: [tier], chosen: tier, runnerUp: undefined, dominance: Infinity };
}

/** Background audit after a fast arm: full table + dominance verdict, printed when it lands. Never aborts a running exit. */
export async function auditTiers(r: { reader: ChainReader; client: Pub }, cfg: Config, chosen: ResolvedPool): Promise<void> {
  const t0 = Date.now();
  const e = await enumerateTiers(r, cfg, chosen.token, cfg.trade.feeTiers);
  console.log(`\n${C.bold(`tier table for ${e.symbol} ${getAddress(chosen.token)} (background audit, ${Date.now() - t0} ms)`)}\n${tierTable(e.tiers)}`);
  const choice = chooseDeepest(e.tiers, { minDepthUsd: cfg.minPoolDepthFor(chosen.token), dominanceRatio: cfg.trade.dominanceRatio, expectedFeeTier: cfg.expectedFeeTierFor(chosen.token) });
  if (!choice.ok) log(C.red(`AUDIT WARNING: ${choice.reason} (this run used fee ${chosen.chosen.fee} ${chosen.chosen.pool}; review before the next entry)`));
  else if (choice.chosen.pool.toLowerCase() !== chosen.chosen.pool.toLowerCase()) log(C.red(`AUDIT WARNING: a deeper trusted tier exists: fee ${choice.chosen.fee} ${choice.chosen.pool} ($${choice.chosen.usdcDepth!.toFixed(0)}) vs the used fee ${chosen.chosen.fee} ${chosen.chosen.pool} ($${chosen.chosen.usdcDepth!.toFixed(0)}). Update trade.tokens[token].pool/expectedFeeTier.`));
  else log(`audit: used pool is the deepest trusted tier, dominance ${fmtDom(choice.dominance)}`);
}

/**
 * Re-read ONLY the chosen pool's depth and spot (two reads), right before
 * signing. The full table + guards ran earlier (before the mint) so the
 * ~20s enumeration never sits on the post-mint critical path. Re-asserts
 * the depth floor on the fresh value; aborts on an unreadable value.
 */
export async function refreshChosen(r: { reader: ChainReader; client: Pub }, cfg: Config, p: ResolvedPool): Promise<ResolvedPool> {
  const t = p.chosen;
  const bal = await readOrDie('pool USDC balance', () => r.client.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [t.pool] }), (d) => `USDC balanceOf(${t.pool}) reverted ("${d}")`);
  const slot0 = await readOrDie('pool.slot0()', () => r.client.readContract({ address: t.pool, abi: POOL_ABI, functionName: 'slot0' }), (d) => `${t.pool} slot0() answered "${d}": not a UniV3 pool`);
  const depth = toNumber(bal, USDC_DECIMALS);
  const floor = cfg.minPoolDepthFor(p.token);
  if (depth < floor) die(`pool guard (fresh read): ${t.pool} holds $${depth.toFixed(2)} USDC, below the floor $${floor}`);
  const dec0 = t.usdcSide === 0 ? USDC_DECIMALS : p.tokenDecimals;
  const dec1 = t.usdcSide === 1 ? USDC_DECIMALS : p.tokenDecimals;
  const spot = v3TokenPriceUsd(slot0[0], dec0, dec1, t.usdcSide === 0);
  log(`fresh read: depth $${depth.toFixed(2)} (was $${t.usdcDepth!.toFixed(2)}), spot ${spot?.toPrecision(6) ?? '?'}`);
  const chosen: Tier = { ...t, usdcDepth: depth, sqrtPriceX96: slot0[0], spotUsd: spot };
  return { ...p, chosen, tiers: p.tiers.map((x) => (x.pool === t.pool ? chosen : x)) };
}

const fmtDepth = (d: number) => (d >= 1 ? `$${d.toFixed(2)}` : d === 0 ? '$0' : `$${d.toPrecision(3)}`);

const fmtDom = (d: number) => (Number.isFinite(d) ? `${d.toFixed(1)}×` : '∞');

export function tierTable(tiers: Tier[]): string {
  const rows = tiers.map((t) => [
    String(t.fee).padStart(6),
    t.pool,
    t.usdcDepth === undefined ? 'ERR'.padStart(14) : fmtDepth(t.usdcDepth).padStart(14),
    (t.liquidity ?? 'ERR').toString().padStart(24),
    t.trusted ? 'trusted' : 'UNTRUSTED',
    t.readError ?? '',
  ]);
  return ['   fee  pool                                        USDC depth               liquidity  trust', ...rows.map((r) => '  ' + r.join('  '))].join('\n');
}

export function tierFields(r: ResolvedPool): Field[] {
  return [
    {
      name: `tiers (${r.symbol})`,
      value: r.tiers.map((t) => `${t.fee === r.chosen.fee ? '**' : ''}fee ${t.fee} · ${t.pool.slice(0, 8)}… · ${t.usdcDepth === undefined ? 'ERR' : fmtDepth(t.usdcDepth)} · L=${t.liquidity ?? '?'}${t.fee === r.chosen.fee ? '**' : ''}`).join('\n').slice(0, 1000),
    },
    { name: 'dominance', value: r.tiers.length === 1 && !Number.isFinite(r.dominance) ? 'single tier (full table audits in background)' : fmtDom(r.dominance), inline: true },
  ];
}
