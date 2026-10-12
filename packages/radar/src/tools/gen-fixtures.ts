/**
 * Generates ABI-realistic fixture scenarios (fixtures/chain.json + fixtures/events/*.json).
 * Logs are encoded with viem from the same ABIs the decoder uses. Re-run after changing scenarios:
 *   npm run fixtures:gen && npm run test:fixtures -- -u
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodeAbiParameters, encodeEventTopics, getAbiItem, keccak256, toHex, type Abi, type AbiEvent } from 'viem';
import { genericPadAbi } from '../abi/pads.js';
import { warpAbi } from '../abi/pads-mainnet.js';
import { univ2FactoryAbi, univ2PairAbi } from '../abi/univ2.js';
import { univ3FactoryAbi, univ3PoolAbi } from '../abi/univ3.js';
import type { ChainFixture } from '../testing/fake-reader.js';
import { FIXTURES_DIR, type Scenario, type Step } from '../testing/runner.js';
import { blockTs, GENESIS, W } from '../testing/world.js';

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const LAG_MS = 1500; // clock = block time + 1.5s → embeds show T+1.5s

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
/** sqrtPriceX96 for a pool with USDC as token0 (6 dec) and token1 at 18 dec, token price in USD. */
function sqrtPriceUsdcToken0(priceUsd: number): bigint {
  // token1 per token0 (raw) = (1/price) * 10^(18-6)
  const rawRatioE18 = (10n ** 12n * E18 * 10n ** 9n) / BigInt(Math.round(priceUsd * 1e9));
  return isqrt((rawRatioE18 << 192n) / E18);
}

let txSeq = 0;
function mkLog(abi: Abi, address: string, eventName: string, args: Record<string, unknown>, block: bigint, logIndex = 0, txHash?: string) {
  const ev = getAbiItem({ abi, name: eventName }) as AbiEvent;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as string[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name ?? '']) as never);
  return {
    address,
    topics,
    data,
    blockNumber: toHex(block),
    transactionHash: txHash ?? keccak256(toHex(`fixture-tx-${++txSeq}`)),
    logIndex: toHex(logIndex),
  };
}
type L = ReturnType<typeof mkLog>;

const clockAt = (block: bigint, extraMs = 0) => blockTs(block) * 1000 + LAG_MS + extraMs;
const logsStep = (logs: L[], extraMs = 0): Step => {
  const maxBlock = logs.reduce((m, l) => (BigInt(l.blockNumber) > m ? BigInt(l.blockNumber) : m), 0n);
  return { op: 'logs', clockMs: clockAt(maxBlock, extraMs), logs };
};

const MEME_PRICE = 0.00005;
const SQRT_MEME = sqrtPriceUsdcToken0(MEME_PRICE);

// ---- event builders ----
const v3PoolCreated = (factory: string, token1: string, pool: string, block: bigint) =>
  mkLog(univ3FactoryAbi, factory, 'PoolCreated', { token0: W.usdc, token1, fee: 10000, tickSpacing: 200, pool }, block);
const v2PairCreated = (token1: string, pair: string, block: bigint) =>
  mkLog(univ2FactoryAbi, W.fixtureDexFactory, 'PairCreated', { token0: W.usdc, token1, pair, allPairsLength: 1n }, block);
const v3Mint = (pool: string, usdc: number, token: bigint, block: bigint, txHash?: string) =>
  mkLog(univ3PoolAbi, pool, 'Mint', { sender: W.router, owner: W.lp, tickLower: -887200, tickUpper: 887200, amount: 10n ** 20n, amount0: BigInt(usdc) * E6, amount1: token }, block, 1, txHash);
const v3Burn = (pool: string, usdc: number, token: bigint, block: bigint) =>
  mkLog(univ3PoolAbi, pool, 'Burn', { owner: W.lp, tickLower: -887200, tickUpper: 887200, amount: 10n ** 19n, amount0: BigInt(usdc) * E6, amount1: token }, block, 1);
/** V3 swap on a USDC-token0 pool. buy: USDC in, tokens out. */
const v3Swap = (pool: string, side: 'buy' | 'sell', usdc: number, priceUsd: number, block: bigint, recipient: string = W.trader, logIndex = 2) => {
  const tokens = (BigInt(Math.round((usdc / priceUsd) * 1e6)) * E18) / E6;
  const a0 = BigInt(usdc) * E6;
  return mkLog(
    univ3PoolAbi,
    pool,
    'Swap',
    { sender: W.router, recipient, amount0: side === 'buy' ? a0 : -a0, amount1: side === 'buy' ? -tokens : tokens, sqrtPriceX96: sqrtPriceUsdcToken0(priceUsd), liquidity: 10n ** 24n, tick: 0 },
    block,
    logIndex,
  );
};
/** V2 swap + Sync on a USDC-token0 pair. Returns [Sync, Swap] like a real pair (Sync first). */
function v2SwapWithSync(pair: string, side: 'buy' | 'sell', usdc: number, reserves: { usdc: bigint; token: bigint }, block: bigint, to: string = W.trader): L[] {
  const usdcRaw = BigInt(usdc) * E6;
  // constant product, no fee (fixture): tokenOut = token * usdcIn / (usdc + usdcIn)
  if (side === 'buy') {
    const out = (reserves.token * usdcRaw) / (reserves.usdc + usdcRaw);
    reserves.usdc += usdcRaw;
    reserves.token -= out;
    const tx = keccak256(toHex(`fixture-tx-${++txSeq}`));
    return [
      mkLog(univ2PairAbi, pair, 'Sync', { reserve0: reserves.usdc, reserve1: reserves.token }, block, 0, tx),
      mkLog(univ2PairAbi, pair, 'Swap', { sender: W.router, amount0In: usdcRaw, amount1In: 0n, amount0Out: 0n, amount1Out: out, to }, block, 1, tx),
    ];
  }
  const tokenIn = (reserves.token * usdcRaw) / (reserves.usdc - usdcRaw);
  reserves.usdc -= usdcRaw;
  reserves.token += tokenIn;
  const tx = keccak256(toHex(`fixture-tx-${++txSeq}`));
  return [
    mkLog(univ2PairAbi, pair, 'Sync', { reserve0: reserves.usdc, reserve1: reserves.token }, block, 0, tx),
    mkLog(univ2PairAbi, pair, 'Swap', { sender: W.router, amount0In: 0n, amount1In: tokenIn, amount0Out: usdcRaw, amount1Out: 0n, to }, block, 1, tx),
  ];
}

const B = GENESIS.block + 1000n;
const scenarios: Scenario[] = [];

// 01 — new pad token create (Tolly V3 PoolCreated + generic pad TokenCreated) → #launchpads, no ping
scenarios.push({
  name: '01-pad-launch',
  description: 'TollyPad PoolCreated (MEME/USDC) and FixturePad TokenCreated → two NEW_LAUNCH posts in #launchpads, no ping.',
  steps: [
    logsStep([v3PoolCreated(W.tollyFactory, W.meme, W.poolMeme, B)]),
    logsStep([mkLog(genericPadAbi, W.fixturePadFactory, 'TokenCreated', { token: W.warpMeme, creator: W.creator, name: 'Warp Meme', symbol: 'WMEME' }, B + 4n)]),
    // Same TokenCreated topic from a non-allowlisted emitter must be ignored.
    logsStep([mkLog(genericPadAbi, W.rogueFactory, 'TokenCreated', { token: W.meme2, creator: W.creator, name: 'Fake', symbol: 'FAKE' }, B + 6n)]),
  ],
});

// 02 — swaps buy + sell, USDC-normalized; no posts beyond the launch
scenarios.push({
  name: '02-swaps',
  description: 'Buy $1200 then sell $800 on MEME/USDC (V3). USDC-normalized volume, no alert posts.',
  steps: [
    logsStep([v3PoolCreated(W.tollyFactory, W.meme, W.poolMeme, B)]),
    logsStep([v3Swap(W.poolMeme, 'buy', 1200, MEME_PRICE, B + 10n)]),
    logsStep([v3Swap(W.poolMeme, 'sell', 800, MEME_PRICE, B + 30n)]),
  ],
});

// 03 — LP add large → #alerts + ping
scenarios.push({
  name: '03-lp-surge',
  description: 'Mint adds $8000 USDC to a Tolly pool within the window (threshold $5000) → LP_SURGE in #alerts with ping.',
  steps: [logsStep([v3PoolCreated(W.tollyFactory, W.meme, W.poolMeme, B)]), logsStep([v3Mint(W.poolMeme, 8000, 160_000_000n * E18, B + 20n)])],
});

// 04 — LP add below surge then burn → specialty channel, no ping
scenarios.push({
  name: '04-lp-burn',
  description: 'Mint $3000 (LP_WATCH, #launchpads) then Burn $2500 two minutes later (LP_REMOVE, #launchpads). No ping.',
  steps: [
    logsStep([v3PoolCreated(W.tollyFactory, W.meme, W.poolMeme, B)]),
    logsStep([v3Mint(W.poolMeme, 3000, 60_000_000n * E18, B + 10n)]),
    logsStep([v3Burn(W.poolMeme, 2500, 50_000_000n * E18, B + 250n)]),
  ],
});

// 05 — pad Graduated + hot post-migrate volume → #alerts + ping
{
  const res = { usdc: 20_000n * E6, token: 200_000_000n * E18 };
  const s1 = v2SwapWithSync(W.poolGrad, 'buy', 4000, res, B + 40n);
  const s2 = v2SwapWithSync(W.poolGrad, 'buy', 5000, res, B + 160n);
  const s3 = v2SwapWithSync(W.poolGrad, 'sell', 3500, res, B + 320n);
  scenarios.push({
    name: '05-graduate-hot',
    description: 'FixturePad TokenCreated → PairCreated on FixtureDEX → Graduated → $12.5k swaps within 3 min → PAD_GRADUATED (#launchpads) + PAD_MIGRATE_HOT (#alerts, ping).',
    steps: [
      logsStep([mkLog(genericPadAbi, W.fixturePadFactory, 'TokenCreated', { token: W.warpMeme, creator: W.creator, name: 'Warp Meme', symbol: 'WMEME' }, B)]),
      logsStep([v2PairCreated(W.warpMeme, W.poolGrad, B + 20n), mkLog(genericPadAbi, W.fixturePadFactory, 'Graduated', { token: W.warpMeme, pool: W.poolGrad, quoteRaised: 20_000n * E6 }, B + 20n, 3)]),
      logsStep(s1),
      logsStep(s2),
      logsStep(s3),
    ],
  });
}

// 06 — watchlist wallet buys within N sec of pool birth (tx.from = wallet, recipient = router)
{
  const fast = v3Swap(W.poolMeme2, 'buy', 900, MEME_PRICE, B + 60n, W.router); // 30s after birth
  const late = v3Swap(W.poolMeme2, 'buy', 700, MEME_PRICE, B + 500n, W.wallet); // 250s after birth, recipient = wallet
  scenarios.push({
    name: '06-wallet-fast-buy',
    description: 'Labeled wallet (tx.from) buys $900 30s after Tolly pool birth → WATCHLIST_WALLET_FAST in #alerts with ping; a later buy (250s) → WALLET_ACTIVITY #smart-flow, no ping.',
    chainOverrides: { txFrom: { [fast.transactionHash]: W.wallet } },
    steps: [logsStep([v3PoolCreated(W.tollyFactory, W.meme2, W.poolMeme2, B)]), logsStep([fast]), logsStep([late])],
  });
}

// 07 — duplicate of (3) within 60s → suppressed
{
  const mint = v3Mint(W.poolMeme, 8000, 160_000_000n * E18, B + 20n);
  scenarios.push({
    name: '07-duplicate-surge',
    description: 'LP surge fires once; the exact same log replayed (WS+backfill overlap) is dropped; a second $8000 mint 20s later is suppressed by the 60s dedupe.',
    steps: [
      logsStep([v3PoolCreated(W.tollyFactory, W.meme, W.poolMeme, B)]),
      logsStep([mint]),
      logsStep([mint], 500),
      logsStep([v3Mint(W.poolMeme, 8000, 160_000_000n * E18, B + 60n)]),
    ],
  });
}

// 08 — LP surge below threshold → launchpads (pad pool) / major-coins (major token), no ping
scenarios.push({
  name: '08-below-threshold',
  description: '$2000 mint on a Tolly pool → LP_WATCH #launchpads; $2000 mint on COOL/USDC (FixtureDEX, COOL is a major) → LP_WATCH #major-coins. No ping.',
  steps: [
    logsStep([v3PoolCreated(W.tollyFactory, W.meme, W.poolMeme, B), v2PairCreated(W.cool, W.poolCool, B)]),
    logsStep([v3Mint(W.poolMeme, 2000, 40_000_000n * E18, B + 10n)]),
    logsStep([mkLog(univ2PairAbi, W.poolCool, 'Mint', { sender: W.router, amount0: 2000n * E6, amount1: 100_000n * E18 }, B + 12n, 1)]),
  ],
});

// 09 — missing getCode on boot → #alerts once, no ping; restart does not repost
scenarios.push({
  name: '09-missing-on-chain',
  description: 'Boot probe: Architects (critical major) and WARP pad token have no code → one aggregated MISSING_ON_CHAIN in #alerts, no ping. Restart with same DB → no repost.',
  steps: [
    { op: 'boot', clockMs: blockTs(B) * 1000 },
    { op: 'boot', clockMs: blockTs(B) * 1000 + 60_000, freshProcess: true },
  ],
});

// 10 — gap on WS reconnect backfills missed blocks without double-posting
{
  const created = v3PoolCreated(W.tollyFactory, W.meme, W.poolMeme, B);
  const swap = v3Swap(W.poolMeme, 'buy', 300, MEME_PRICE, B + 2n);
  const missedMint = v3Mint(W.poolMeme, 9000, 180_000_000n * E18, B + 17n);
  const missedSwap = v3Swap(W.poolMeme, 'buy', 250, MEME_PRICE, B + 23n);
  scenarios.push({
    name: '10-gap-backfill',
    description: 'WS delivers blocks ≤B+2, connection drops, reconnect at head B+24. Backfill [B+2, B+24] in 5-block chunks re-sees the B+2 swap (deduped) and the missed $9000 mint (one LP_SURGE). No double NEW_LAUNCH.',
    chainLogs: [created, swap, missedMint, missedSwap],
    steps: [
      { op: 'head', clockMs: clockAt(B), block: B.toString() },
      logsStep([created]),
      { op: 'head', clockMs: clockAt(B + 2n), block: (B + 2n).toString() },
      logsStep([swap]),
      { op: 'reconnect', clockMs: clockAt(B + 24n), head: (B + 24n).toString() },
      // Replay a head that skips ahead too (missed heads without reconnect): B+30 with nothing new.
      { op: 'head', clockMs: clockAt(B + 30n), block: (B + 30n).toString() },
    ],
  });
}

// 11 — MAJOR_ANOMALY: 60 min baseline of $100/min on COOL, then a spike
{
  const res = { usdc: 100_000n * E6, token: 5_000_000n * E18 };
  const steps: Step[] = [logsStep([v2PairCreated(W.cool, W.poolCool, B)])];
  for (let i = 1; i <= 60; i++) steps.push(logsStep(v2SwapWithSync(W.poolCool, i % 2 ? 'buy' : 'sell', 100, res, B + BigInt(i * 120))));
  for (let i = 0; i < 4; i++) steps.push(logsStep(v2SwapWithSync(W.poolCool, 'buy', 5000, res, B + 61n * 120n + BigInt(i * 20))));
  scenarios.push({
    name: '11-major-anomaly',
    description: 'COOL trades $100/min for 60 min, then 4×$5000 buys in 30s → one MAJOR_ANOMALY (5m vol z ≥ 5) in #alerts with ping; cooldown suppresses repeats.',
    steps,
  });
}

// 12 — spoofed pools: huge mints must never ping
scenarios.push({
  name: '12-spoofed-pool',
  description: 'Pool reporting a non-allowlisted factory, and a pool claiming TollyPad whose factory.getPool() does not round-trip, each mint $50k → no #alerts, no ping (logs only).',
  steps: [
    logsStep([v3Mint(W.poolSpoof, 50_000, 10n ** 27n, B + 10n)]),
    logsStep([v3Mint(W.poolSpoofTolly, 50_000, 10n ** 27n, B + 12n)]),
  ],
});

// 13 — major digest with live metrics (COOL) and explicit n/a
{
  const res = { usdc: 100_000n * E6, token: 5_000_000n * E18 };
  scenarios.push({
    name: '13-major-digest',
    description: 'COOL pair gets 3 swaps (radar history covers 2h, as after a warm start); digest posts COOL to #major-coins with price/mcap/vol/lp and explicit n/a where unknown (holders not backfilled). Architects is missing on chain → skipped.',
    coverageFromMs: blockTs(B) * 1000 - 2 * 3600_000,
    steps: [
      { op: 'boot', clockMs: blockTs(B) * 1000 },
      logsStep([v2PairCreated(W.cool, W.poolCool, B)]),
      logsStep(v2SwapWithSync(W.poolCool, 'buy', 1500, res, B + 100n)),
      logsStep(v2SwapWithSync(W.poolCool, 'sell', 400, res, B + 200n)),
      logsStep(v2SwapWithSync(W.poolCool, 'buy', 900, res, B + 300n)),
      { op: 'digest', clockMs: clockAt(B + 400n) },
    ],
  });
}

// 14 — pad leaderboard
{
  const res = { usdc: 20_000n * E6, token: 200_000_000n * E18 };
  scenarios.push({
    name: '14-pad-leaderboard',
    description: 'Tolly launches 2 pools with $1.5k vol; FixturePad launches 1 token that graduates → hourly leaderboard in #launchpads names the winning pad.',
    steps: [
      logsStep([v3PoolCreated(W.tollyFactory, W.meme, W.poolMeme, B), v3PoolCreated(W.tollyFactory, W.meme2, W.poolMeme2, B)]),
      logsStep([v3Swap(W.poolMeme, 'buy', 1000, MEME_PRICE, B + 50n)]),
      logsStep([v3Swap(W.poolMeme2, 'buy', 500, MEME_PRICE, B + 60n)]),
      logsStep([mkLog(genericPadAbi, W.fixturePadFactory, 'TokenCreated', { token: W.warpMeme, creator: W.creator, name: 'Warp Meme', symbol: 'WMEME' }, B + 70n)]),
      logsStep([v2PairCreated(W.warpMeme, W.poolGrad, B + 80n), mkLog(genericPadAbi, W.fixturePadFactory, 'Graduated', { token: W.warpMeme, pool: W.poolGrad, quoteRaised: 20_000n * E6 }, B + 80n, 3)]),
      logsStep(v2SwapWithSync(W.poolGrad, 'buy', 800, res, B + 90n)),
      { op: 'leaderboard', clockMs: clockAt(B + 200n) },
    ],
  });
}

// ---------------- MAINNET-shaped scenarios (real CAs, synthetic events) ----------------
const WARP_PROXY = '0x0dcad158e98bc24455f9e94f46709d8a5f6d1255';
const UNIV3_ARC = '0xf0db7b58379503491d857db50ac9ece64c653918';
const COOL_POOL_500 = '0x2f5f386526ee1be410c13fcb5b451ad4254ab7ba'; // real COOL/USDC 0.05% pool on UniV3-Arc (getPool verified)
const COOL_POOL_FAKE = '0x9bad00000000000000000000000000000000c001';
const WARP_TOKEN = '0xcccc00000000000000000000000000000000c0c0';
const WARP_CURVE = '0xc0c0000000000000000000000000000000000c01';
const OLD_CURVE = '0xc0c0000000000000000000000000000000000c02'; // created before boot; curveInfo() says Warp
const ROGUE_CURVE = '0xc0c0000000000000000000000000000000000bad';
const E18N = 10n ** 18n;
const warpTrade = (curve: string, trader: string, isBuy: boolean, usdc: number, block: bigint) =>
  mkLog(warpAbi, curve, 'Trade', { trader, isBuy, quoteAmount: BigInt(usdc) * E18N, tokenAmount: BigInt(usdc) * 10_000n * E18N, p2: 0n, p3: 0n }, block);

// 15 — mainnet: majors can ping once their pool's factory (canonical UniV3-Arc) is allowlisted
{
  const steps: Step[] = [];
  for (let i = 1; i <= 60; i++) steps.push(logsStep([v3Swap(COOL_POOL_500, i % 2 ? 'buy' : 'sell', 100, 0.02, B + BigInt(i * 120))]));
  for (let i = 0; i < 3; i++) steps.push(logsStep([v3Swap(COOL_POOL_500, 'buy', 6000, 0.021, B + 61n * 120n + BigInt(i * 20))]));
  scenarios.push({
    name: '15-mainnet-major-anomaly',
    description: 'ARC_NETWORK=mainnet with the REAL operator config/watchlists: COOL spikes on its real UniV3-Arc pool (factory allowlisted, getPool round-trip) → MAJOR_ANOMALY in #alerts with ping.',
    env: { ARC_NETWORK: 'mainnet' },
    watchlistDir: 'config/watchlists',
    chainOverrides: { pools: { [COOL_POOL_500]: { dex: 'univ3', factory: UNIV3_ARC, token0: W.usdc, token1: W.cool, fee: 500 } } },
    steps,
  });
}

// 16 — mainnet: identical spike on a pool that CLAIMS UniV3-Arc but fails getPool round-trip → never pings
{
  const steps: Step[] = [];
  for (let i = 1; i <= 60; i++) steps.push(logsStep([v3Swap(COOL_POOL_FAKE, i % 2 ? 'buy' : 'sell', 100, 0.02, B + BigInt(i * 120))]));
  for (let i = 0; i < 3; i++) steps.push(logsStep([v3Swap(COOL_POOL_FAKE, 'buy', 6000, 0.021, B + 61n * 120n + BigInt(i * 20))]));
  scenarios.push({
    name: '16-mainnet-spoofed-major-pool',
    description: 'Same COOL spike on a pool whose factory() says UniV3-Arc but UniV3-Arc.getPool() disagrees → downgraded to #major-coins, no ping.',
    env: { ARC_NETWORK: 'mainnet' },
    watchlistDir: 'config/watchlists',
    chainOverrides: { pools: { [COOL_POOL_FAKE]: { dex: 'univ3', factory: UNIV3_ARC, token0: W.usdc, token1: W.cool, fee: 3000, registered: false } } },
    steps,
  });
}

// 17 — mainnet Warp: launch → curve trust → wallet fast buy (native 18-dec USDC); spoofed curve / launcher ignored
{
  const fast = warpTrade(WARP_CURVE, W.wallet, true, 600, B + 40n);
  scenarios.push({
    name: '17-mainnet-warp-curve',
    description:
      'Warp TokenCreated from the real launch proxy registers a trusted curve; labeled wallet buys 600 native USDC (18 dec) 20s later → WATCHLIST_WALLET_FAST ping. ' +
      'Buy on a pre-boot curve (curveInfo → Warp) → WALLET_ACTIVITY #smart-flow (untrusted, no ping). Trade from a rogue curve and a Lift-topic launch from a rogue emitter are ignored.',
    env: { ARC_NETWORK: 'mainnet' },
    watchlistDir: 'fixtures/watchlists-mainnet',
    chainOverrides: {
      tokens: {
        [WARP_TOKEN]: { symbol: 'WTEST', decimals: 18, totalSupply: (10n ** 9n * E18N).toString() },
        '0xcccc00000000000000000000000000000000c0c1': { symbol: 'WOLD', decimals: 18, totalSupply: (10n ** 9n * E18N).toString() },
      },
      curves: {
        [OLD_CURVE]: { factory: WARP_PROXY, token: '0xcccc00000000000000000000000000000000c0c1' },
        [ROGUE_CURVE]: { factory: W.rogueFactory, token: WARP_TOKEN },
      },
    },
    steps: [
      logsStep([mkLog(warpAbi, WARP_PROXY, 'TokenCreated', { token: WARP_TOKEN, curve: WARP_CURVE, creator: W.creator, name: 'Warp Test', symbol: 'WTEST', metadata: '{}' }, B)]),
      logsStep([fast]),
      logsStep([warpTrade(OLD_CURVE, W.wallet, true, 700, B + 60n)]),
      logsStep([warpTrade(ROGUE_CURVE, W.wallet, true, 50_000, B + 62n)]),
      logsStep([mkLog(warpAbi, W.rogueFactory, 'TokenCreated', { token: W.meme2, curve: ROGUE_CURVE, creator: W.creator, name: 'Fake', symbol: 'FAKE', metadata: '{}' }, B + 64n)]),
    ],
  });
}

const chain: ChainFixture = {
  chainId: 5042002,
  head: (B + 10_000n).toString(),
  tokens: {
    [W.usdc]: { symbol: 'USDC', decimals: 6, totalSupply: (10n ** 9n * E6).toString() },
    [W.meme]: { symbol: 'MEME', decimals: 18, totalSupply: (10n ** 9n * E18).toString() },
    [W.meme2]: { symbol: 'MEME2', decimals: 18, totalSupply: (10n ** 9n * E18).toString() },
    [W.warpMeme]: { symbol: 'WMEME', decimals: 18, totalSupply: (10n ** 9n * E18).toString() },
    [W.cool]: { symbol: 'COOL', decimals: 18, totalSupply: (10n ** 9n * E18).toString() },
  },
  pools: {
    [W.poolMeme]: { dex: 'univ3', factory: W.tollyFactory, token0: W.usdc, token1: W.meme, fee: 10000 },
    [W.poolMeme2]: { dex: 'univ3', factory: W.tollyFactory, token0: W.usdc, token1: W.meme2, fee: 10000 },
    [W.poolCool]: { dex: 'univ2', factory: W.fixtureDexFactory, token0: W.usdc, token1: W.cool },
    [W.poolGrad]: { dex: 'univ2', factory: W.fixtureDexFactory, token0: W.usdc, token1: W.warpMeme },
    [W.poolSpoof]: { dex: 'univ3', factory: W.rogueFactory, token0: W.usdc, token1: W.meme, fee: 10000 },
    // Claims TollyPad via factory() but TollyPad.getPool(USDC, MEME, 3000) is not this address.
    [W.poolSpoofTolly]: { dex: 'univ3', factory: W.tollyFactory, token0: W.usdc, token1: W.meme, fee: 3000, registered: false },
  },
  code: [W.usdc, W.tollyFactory, W.fixturePadFactory, W.fixtureDexFactory, W.meme, W.meme2, W.warpMeme, W.cool, W.poolMeme, W.poolMeme2, W.poolCool, W.poolGrad],
  txFrom: {},
  balances: {
    [`${W.usdc}:${W.poolMeme}`]: (12_000n * E6).toString(),
    [`${W.usdc}:${W.poolCool}`]: (101_600n * E6).toString(),
    [`${W.usdc}:${W.poolGrad}`]: (32_500n * E6).toString(),
  },
  sqrtPrices: { [W.poolMeme]: SQRT_MEME.toString(), [W.poolMeme2]: SQRT_MEME.toString() },
};

const evDir = path.join(FIXTURES_DIR, 'events');
fs.mkdirSync(evDir, { recursive: true });
for (const f of fs.readdirSync(evDir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(evDir, f));
fs.writeFileSync(path.join(FIXTURES_DIR, 'chain.json'), JSON.stringify(chain, null, 2) + '\n');
for (const s of scenarios) fs.writeFileSync(path.join(evDir, `${s.name}.json`), JSON.stringify(s, null, 2) + '\n');
console.log(`wrote chain.json + ${scenarios.length} scenarios to ${evDir}`);
