/**
 * buy — swap USDC for the target in its DEEPEST TRUSTED pool only.
 *
 *   npx tsx src/buy.ts --amount 100                      dry run (default)
 *   npx tsx src/buy.ts --live --amount 5000 [--slippage-bps 250] [--token 0x…]
 *
 * Guards that abort (exit 2): pool not on an allowlisted factory, depth
 * below the per-token floor, split liquidity (dominance), expectedFeeTier
 * mismatch, chainId mismatch, route unwired, zero gas, amount above
 * maxNotionalUsd (fat-finger cap), USDC not readable on Arc.
 *
 * Impact is INFORMATIONAL: paper.ts's round-trip model is computed at the
 * real size and reported in trade.preflight and trade.fill (realised vs
 * predicted). It never blocks. The only on-chain guard is minOut from
 * slippageBps, which the operator sets (CLI > json).
 */

import { decodeEventLog, encodeFunctionData, formatUnits, getAddress, maxUint256, parseUnits, type Address, type Hex } from 'viem';
import { toNumber } from '../../radar/src/math/units.js';
import { boot, printDryRunPayloads, type Boot } from './boot.js';
import { assertGasFloor, broadcast, ERC20, gasParams, NonceTracker, POOL_ABI, pollState, preflight, readHandle, ROUTER02_ABI, rpc, signTx, USDC_ARC, USDC_DECIMALS, waitReceipt } from './chain.js';
import { impactBps, realisedLegBps, type ImpactBreakdown } from './impact.js';
import { C, die, log } from './log.js';
import { arcAddr, arcTx, COLORS, embed } from './notify.js';
import { auditTiers, refreshChosen, resolveCachedPool, resolveDeepestPool, resolveSingleTier, tierFields, type ResolvedPool } from './pool.js';

export interface Quote {
  pool: ResolvedPool;
  amountIn: bigint;
  sizeUsd: number;
  spotUsd: number;
  /** tokens at spot, raw units */
  expectedOut: bigint;
  minOut: bigint;
  slippageBps: number;
  predicted: ImpactBreakdown;
  /** Background full-table audit (cached / single-tier paths); awaited before the process ends. */
  audit?: Promise<void>;
}

/** Pure sizing at spot: expectedOut = usd / spot; minOut = expectedOut × (1 − slippage). */
export function quoteAtSpot(o: { amountIn: bigint; spotUsd: number; tokenDecimals: number; slippageBps: number }): { expectedOut: bigint; minOut: bigint } {
  const usd = toNumber(o.amountIn, USDC_DECIMALS);
  if (!(o.spotUsd > 0)) throw new Error('spot price unavailable');
  const tokens = usd / o.spotUsd;
  const expectedOut = parseUnits(tokens.toFixed(Math.min(o.tokenDecimals, 18)), o.tokenDecimals);
  const minOut = (expectedOut * BigInt(10_000 - o.slippageBps)) / 10_000n;
  return { expectedOut, minOut };
}

export function swapCalldata(o: { router: Address; tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint; minOut: bigint; deadlineSec: number; nowMs?: number }): { data: Hex; deadline: bigint } {
  const inner = encodeFunctionData({
    abi: ROUTER02_ABI,
    functionName: 'exactInputSingle',
    args: [{ tokenIn: o.tokenIn, tokenOut: o.tokenOut, fee: o.fee, recipient: o.recipient, amountIn: o.amountIn, amountOutMinimum: o.minOut, sqrtPriceLimitX96: 0n }],
  });
  const deadline = BigInt(Math.floor((o.nowMs ?? Date.now()) / 1000) + o.deadlineSec);
  return { data: encodeFunctionData({ abi: ROUTER02_ABI, functionName: 'multicall', args: [deadline, [inner]] }), deadline };
}

/** Sum of the pool's Swap events in a receipt, from the pool's perspective. */
export function swapAmounts(receipt: { logs: { address: Address; data: Hex; topics: Hex[] }[] }, pool: Address): { amount0: bigint; amount1: bigint } | undefined {
  let found = false;
  let amount0 = 0n;
  let amount1 = 0n;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: POOL_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (ev.eventName === 'Swap') {
        found = true;
        amount0 += ev.args.amount0;
        amount1 += ev.args.amount1;
      }
    } catch {
      // not a Swap
    }
  }
  return found ? { amount0, amount1 } : undefined;
}

export interface Fill {
  txHash: Hex;
  usdcIn: bigint;
  tokensOut: bigint;
  spotBefore: number;
  predicted: ImpactBreakdown;
  realisedBps?: number;
  fillMs: number;
  pool: ResolvedPool;
}

export interface Resolved {
  pool: ResolvedPool;
  /** Background full-table audit (cached / single-tier paths); awaited before the process ends. */
  audit?: Promise<void>;
}

/** Cached pool > configured tier (fast) > full discovery. Fast paths audit the full table in the background. */
export async function resolvePool(b: Boot, token: Address): Promise<Resolved> {
  const { cfg, ctx } = b;
  const rd = readHandle(ctx);
  const cached = cfg.poolFor(token);
  const fastTier = cfg.expectedFeeTierFor(token);
  let pool: ResolvedPool;
  if (cached) pool = await resolveCachedPool(rd, cfg, token, cached);
  else if (fastTier !== undefined) pool = await resolveSingleTier(rd, cfg, token, fastTier);
  else return { pool: await resolveDeepestPool(rd, cfg, token) };
  const audit = auditTiers(rd, cfg, pool).catch((e) => log(C.yellow(`background tier audit failed: ${(e as Error).message.split('\n')[0]}`)));
  return { pool, audit };
}

/**
 * `pre`: a pool resolved earlier in this process. `pre.fresh` = resolved moments ago (buy.ts main, in parallel with the
 * preflight): used as-is. Otherwise (run.ts: resolved before the mint) only depth/spot are re-read.
 */
export async function quote(b: Boot, token: Address, amountIn: bigint, slippageBps: number, pre?: Resolved & { fresh?: boolean }): Promise<Quote> {
  const { cfg, ctx, notifier } = b;
  const sizeUsd = toNumber(amountIn, USDC_DECIMALS);
  if (sizeUsd > cfg.trade.maxNotionalUsd) die(`amount ${sizeUsd} USDC exceeds trade.maxNotionalUsd ${cfg.trade.maxNotionalUsd} (fat-finger cap; raise it in executor.json consciously)`);
  const rd = readHandle(ctx);
  const r = pre ?? (await resolvePool(b, token));
  const pool = pre && !pre.fresh ? await refreshChosen(rd, cfg, pre.pool) : r.pool;
  const audit = r.audit;
  const t = pool.chosen;
  if (t.spotUsd === undefined) die(`no spot price readable for pool ${t.pool} (slot0)`);
  const predicted = impactBps({ feePpm: t.fee, sizeUsd, depthUsd: t.usdcDepth! });
  const { expectedOut, minOut } = quoteAtSpot({ amountIn, spotUsd: t.spotUsd, tokenDecimals: pool.tokenDecimals, slippageBps });
  console.log('');
  console.log(`  size            ${sizeUsd} USDC`);
  console.log(`  pool            fee ${t.fee} ${getAddress(t.pool)} depth $${t.usdcDepth!.toFixed(2)}`);
  console.log(`  spot            ${t.spotUsd.toPrecision(6)} USDC/${pool.symbol}`);
  console.log(`  expected out    ${formatUnits(expectedOut, pool.tokenDecimals)} ${pool.symbol} (at spot, before fee)`);
  console.log(`  minOut          ${formatUnits(minOut, pool.tokenDecimals)} ${pool.symbol} (slippage ${slippageBps} bps vs spot; must cover fee + impact)`);
  console.log(`  round-trip cost ${predicted.roundTripBps} bps ${C.dim(`= 2×fee ${predicted.feeLegsBps} + size/(2×depth) ${predicted.sizeTermBps}; paper.ts model, both legs, informational`)}`);
  void notifier.emit(
    'trade.preflight',
    embed({
      title: `trade.preflight ${pool.symbol}`,
      color: COLORS.info,
      fields: [
        { name: 'size', value: `${sizeUsd} USDC`, inline: true },
        { name: 'pool', value: `fee ${t.fee} ${arcAddr(t.pool)}`, inline: true },
        { name: 'depth', value: `$${t.usdcDepth!.toFixed(0)}`, inline: true },
        { name: 'spot', value: t.spotUsd.toPrecision(6), inline: true },
        { name: 'slippage', value: `${slippageBps} bps`, inline: true },
        { name: 'round-trip cost (model)', value: `${predicted.roundTripBps} bps (2×fee ${predicted.feeLegsBps} + size ${predicted.sizeTermBps})`, inline: true },
        ...tierFields(pool),
      ],
    }),
  );
  return { pool, amountIn, sizeUsd, spotUsd: t.spotUsd, expectedOut, minOut, slippageBps, predicted, audit };
}

/** Preflight + quote + (live) approve + swap. Returns undefined in dry run. */
/** `pool`: resolved earlier (run.ts does it before the mint); only depth/spot are re-read here. */
export async function buy(b: Boot, o: { nonce: NonceTracker; token: Address; amountIn: bigint; slippageBps: number; pool?: Resolved & { fresh?: boolean } }): Promise<Fill | undefined> {
  const { cfg, ctx, notifier } = b;
  const q = await quote(b, o.token, o.amountIn, o.slippageBps, o.pool);
  const t = q.pool.chosen;
  const router = getAddress(cfg.trade.router);
  const tokenOut = getAddress(q.pool.token);

  // After a mint the balance can lag on a public RPC. Poll the state; a failed read is not a zero.
  const bal = await pollState(
    () => rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] })),
    (v) => v >= o.amountIn,
    { intervalMs: 500, maxMs: cfg.live ? 30_000 : 1 },
  );
  if (bal === undefined) die('Arc USDC balance unreadable (RPC)');
  console.log(`  Arc USDC        ${formatUnits(bal, 6)} ${C.dim('(ERC-20, 6-dec)')}`);
  if (cfg.live && bal < o.amountIn) die(`insufficient USDC on Arc: ${formatUnits(bal, 6)} < ${formatUnits(o.amountIn, 6)}`);
  // Gas floor on FRESH reads, right before spending: the buy pays for approve + swap, and the exit must stay fundable.
  const native = await rpc(() => ctx.arcPub.getBalance({ address: ctx.account.address }));
  const gasNow = await rpc(() => ctx.arcPub.getGasPrice());
  assertGasFloor(cfg, { native18: native, spend6: o.amountIn, ownTxs: cfg.trade.approveOnFill ? 3 : 2, gasPriceWei: gasNow + gasParams(cfg).maxPriorityFeePerGas, what: `buy ${formatUnits(o.amountIn, 6)} USDC` });

  const { data, deadline } = swapCalldata({ router, tokenIn: USDC_ARC, tokenOut, fee: t.fee, recipient: ctx.account.address, amountIn: o.amountIn, minOut: q.minOut, deadlineSec: cfg.trade.deadlineSec });
  if (!cfg.live) {
    console.log(`\n${C.green('Dry run complete.')} would send to router ${router}: multicall(deadline ${deadline}, exactInputSingle fee ${t.fee}, amountIn ${o.amountIn}, minOut ${q.minOut})`);
    console.log(`calldata ${C.dim(data.slice(0, 74))}… (${(data.length - 2) / 2} bytes)`);
    console.log(`Execute: ${C.bold(`npx tsx src/buy.ts --live --amount ${formatUnits(o.amountIn, 6)}${o.slippageBps !== cfg.trade.slippageBps ? ` --slippage-bps ${o.slippageBps}` : ''}${o.token !== cfg.trade.targetToken ? ` --token ${o.token}` : ''}`)}\n`);
    await q.audit;
    return undefined;
  }

  const allowance = await rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, router] }));
  if (allowance < o.amountIn) {
    // Unlimited, like the exit approve: one tx for the wallet's lifetime instead of one per buy.
    const n = o.nonce.next();
    const approveData = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [router, maxUint256] });
    const approveGas = ((await rpc(() => ctx.arcPub.estimateGas({ account: ctx.account, to: USDC_ARC, data: approveData }))) * 130n) / 100n;
    log(`approving USDC -> router (nonce ${n}, gas ${approveGas}, unlimited; current allowance ${formatUnits(allowance, 6)} < ${formatUnits(o.amountIn, 6)})...`);
    const approveTx = (await broadcast(ctx, await signTx(ctx, { to: USDC_ARC, data: approveData, nonce: n, gas: approveGas }), 'approve')).hash;
    const r = await waitReceipt(ctx.arcPub, approveTx, cfg.timing.receiptTimeoutSec * 1000);
    if (r.status !== 'success') die(`approve ${r.status}: ${approveTx}${r.status === 'reverted' ? ` (nonce ${n} consumed)` : ' (nonce counter unknown)'}`);
    log(`approve mined: ${approveTx} gasUsed ${r.receipt.gasUsed} effectiveGasPrice ${Number(r.receipt.effectiveGasPrice) / 1e9} Gwei`);
    const ok = await pollState(() => rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, router] })), (v) => v >= o.amountIn, { intervalMs: 500, maxMs: 20_000 });
    if (ok === undefined || ok < o.amountIn) die('allowance not readable after approve; nothing swapped');
    log(`allowance confirmed readable: ${formatUnits(ok, 6)} USDC`);
  } else {
    log(`USDC -> router allowance ${allowance >= maxUint256 / 2n ? 'unlimited' : formatUnits(allowance, 6)} covers ${formatUnits(o.amountIn, 6)}: no approve`);
  }

  const tFill = Date.now();
  const n = o.nonce.next();
  let gas: bigint;
  try {
    gas = await rpc(() => ctx.arcPub.estimateGas({ account: ctx.account, to: router, data }));
    gas = (gas * 130n) / 100n;
  } catch (e) {
    die(`swap simulation reverted before sending (nothing spent): ${(e as Error).message.split('\n').slice(0, 3).join(' | ')}`);
  }
  const signed = await signTx(ctx, { to: router, data, nonce: n, gas });
  log(`swapping (nonce ${n}, gas ${gas}, hash ${signed.hash})...`);
  let txHash: Hex;
  try {
    const sent = await broadcast(ctx, signed, 'swap');
    txHash = sent.hash;
    if (sent.attempts > 1) log(`swap accepted on attempt ${sent.attempts}`);
  } catch (e) {
    die(`swap broadcast rejected: ${(e as Error).message.split('\n')[0]}`);
  }
  const r = await waitReceipt(ctx.arcPub, txHash, cfg.timing.receiptTimeoutSec * 1000);
  if (r.status === 'no_receipt') die(`swap ${txHash} has no receipt after ${cfg.timing.receiptTimeoutSec}s (not mined; blocklist?). Nonce counter unknown: restart before signing again.`);
  if (r.status === 'reverted') die(`swap reverted with receipt: ${txHash} (nonce ${n} consumed; likely minOut). Re-quote and re-run buy.`);
  const fillMs = Date.now() - tFill;

  const amounts = swapAmounts(r.receipt, t.pool);
  let tokensOut: bigint;
  if (amounts) {
    tokensOut = -(t.usdcSide === 0 ? amounts.amount1 : amounts.amount0);
  } else {
    log(C.yellow('no Swap log decoded from the pool; measuring the token balance instead'));
    tokensOut = (await rpc(() => ctx.arcPub.readContract({ address: tokenOut, abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] }))) ?? 0n;
  }
  const realisedBps = realisedLegBps({ usdc: q.sizeUsd, tokens: toNumber(tokensOut, q.pool.tokenDecimals), spotUsd: q.spotUsd, side: 'buy' });
  log(`filled in block ${r.receipt.blockNumber} (${fillMs} ms): ${txHash} gasUsed ${r.receipt.gasUsed} effectiveGasPrice ${Number(r.receipt.effectiveGasPrice) / 1e9} Gwei ${C.dim('(calibrate gas.reserveGasPerTx from this)')}`);
  console.log(`  tokens out      ${formatUnits(tokensOut, q.pool.tokenDecimals)} ${q.pool.symbol}`);
  console.log(`  realised leg    ${realisedBps ?? '?'} bps vs pre-trade spot (fee-inclusive) · predicted round-trip ${q.predicted.roundTripBps} bps`);
  void notifier.emit(
    'trade.fill',
    embed({
      title: `trade.fill ${q.pool.symbol}`,
      color: COLORS.ok,
      elapsedMs: fillMs,
      fields: [
        { name: 'in', value: `${q.sizeUsd} USDC`, inline: true },
        { name: 'out', value: `${formatUnits(tokensOut, q.pool.tokenDecimals)} ${q.pool.symbol}`, inline: true },
        { name: 'realised leg', value: `${realisedBps ?? '?'} bps`, inline: true },
        { name: 'predicted round-trip', value: `${q.predicted.roundTripBps} bps`, inline: true },
        { name: 'tx', value: arcTx(txHash) },
      ],
    }),
  );
  // ── approve on the entry path, so the exit path never contains an approve, a broadcast retry or an allowance poll ──
  if (cfg.trade.approveOnFill) {
    const tApprove = Date.now();
    const allowanceNow = await rpc(() => ctx.arcPub.readContract({ address: tokenOut, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, router] }));
    if (allowanceNow >= tokensOut) {
      log(`${q.pool.symbol} -> router allowance already ${formatUnits(allowanceNow, q.pool.tokenDecimals)}; exit path is pre-approved`);
    } else {
      const n2 = o.nonce.next();
      const approveData = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [router, maxUint256] });
      let approveGas = 80_000n;
      try {
        approveGas = ((await rpc(() => ctx.arcPub.estimateGas({ account: ctx.account, to: tokenOut, data: approveData }))) * 130n) / 100n;
      } catch (e) {
        log(C.yellow(`approve gas estimate failed (${(e as Error).message.split('\n')[0]!.slice(0, 80)}); using ${approveGas}`));
      }
      log(`approving ${q.pool.symbol} -> router for the exit (nonce ${n2}, gas ${approveGas}, unlimited)...`);
      const aTx = (await broadcast(ctx, await signTx(ctx, { to: tokenOut, data: approveData, nonce: n2, gas: approveGas }), 'exit approve')).hash;
      const ar = await waitReceipt(ctx.arcPub, aTx, cfg.timing.receiptTimeoutSec * 1000);
      if (ar.status !== 'success') die(`exit approve ${ar.status}: ${aTx}. The position is open but NOT pre-approved; sell.ts will approve at start.`);
      const ok = await pollState(() => rpc(() => ctx.arcPub.readContract({ address: tokenOut, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, router] })), (v) => v >= tokensOut, { intervalMs: 500, maxMs: 20_000 });
      if (ok === undefined || ok < tokensOut) die(`exit approve mined (${aTx}) but the allowance is not readable yet; sell.ts will re-check at start.`);
      log(`exit pre-approved: ${aTx} gasUsed ${ar.receipt.gasUsed}, allowance readable (${Date.now() - tApprove} ms)`);
    }
  }
  console.log(`\n  sell TUI:  ${C.bold(`npx tsx src/sell.ts --live --cost-usdc ${formatUnits(o.amountIn, 6)} --entry-tokens ${formatUnits(tokensOut, q.pool.tokenDecimals)}${o.token !== cfg.trade.targetToken ? ` --token ${o.token}` : ''}`)}\n`);
  await q.audit;
  return { txHash, usdcIn: o.amountIn, tokensOut, spotBefore: q.spotUsd, predicted: q.predicted, realisedBps, fillMs, pool: q.pool };
}

// ── cli ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const b = boot('buy', process.argv.slice(2));
  const { cfg, ctx, notifier } = b;
  if (cfg.live && !cfg.cli.amount) die('--live requires an explicit --amount. Refusing to guess a size.');
  const amountIn = parseUnits(cfg.cli.amount ?? '1', USDC_DECIMALS);
  // Preflight, pool resolve and the nonce read are independent: run them in parallel (route checks are irrelevant to a buy).
  const [, resolved, nonce] = await Promise.all([
    preflight(ctx, { base: false, route: false, spend: { usdc6: amountIn, ownTxs: cfg.trade.approveOnFill ? 3 : 2, what: `buy ${formatUnits(amountIn, 6)} USDC` } }),
    resolvePool(b, cfg.trade.targetToken),
    cfg.live ? NonceTracker.init(ctx.arcPub, ctx.account.address) : Promise.resolve(NonceTracker.fixed(0, ctx.account.address)),
  ]);
  await buy(b, { nonce, token: cfg.trade.targetToken, amountIn, slippageBps: cfg.trade.slippageBps, pool: { ...resolved, fresh: true } });
  if (!cfg.live) printDryRunPayloads(notifier, cfg.discordDryRun);
  await notifier.flush();
}

if (process.argv[1] && /buy\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    if ((e as { exitCode?: number }).exitCode === 2) return;
    console.error(`\n${C.red('failed')} ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
