/**
 * bridge — CCTP V2 Fast Transfer, Base mainnet -> Arc mainnet.
 *
 *   npx tsx src/bridge.ts                           dry run, no signing
 *   npx tsx src/bridge.ts --live --amount 1         burns 1 USDC for real, then mints
 *   npx tsx src/bridge.ts --live --burn-tx 0x…      resume: skip approve+burn, poll attestation, mint
 *
 * Every stage is timed, so the output doubles as the latency measurement
 * the executor needs. Nothing is hardcoded that can be read on chain: the
 * destination MessageTransmitter is resolved from the TokenMessenger.
 *
 * Verified on chain 2026-09-15: Base remoteTokenMessengers(26) set,
 * Arc remoteTokenMessengers(6) set, Arc localMinter
 * 0xfd78EE919681417d192449715b2594ab58f5D002, Base USDC maps to Arc USDC.
 *
 * `burn()` is reused by run.ts; attestation + mint live in mint-watch.ts.
 */

import { encodeFunctionData, formatUnits, pad, parseUnits, type Hex } from 'viem';
import { boot, printDryRunPayloads, type Boot } from './boot.js';
import { baseRpc, ERC20, pollState, preflight, TOKEN_MESSENGER, TOKEN_MESSENGER_ABI, USDC_BASE, waitReceipt } from './chain.js';
import type { Config } from './config.js';
import { C, die, log } from './log.js';
import { watchAndMint } from './mint-watch.js';
import { baseTx, COLORS, embed } from './notify.js';

/**
 * Quote the Fast Transfer fee for this route, right before burning.
 * Returns the maxFee to pass to depositForBurn.
 *
 * Circle's formula: protocolFee = amount * round(minimumFee * 100) / 1e6
 * where minimumFee is in basis points. The fee is PROPORTIONAL to the
 * amount, so maxFee must never be a constant: too low and CCTP silently
 * downgrades the transfer to Standard (15-19 min from Base) instead of
 * failing.
 */
export async function quoteMaxFee(cfg: Config, amount: bigint): Promise<bigint> {
  const { baseDomain, arcDomain, minFinalityThreshold, maxFeeMargin } = cfg.route;
  const res = await fetch(`${cfg.irisUrl}/v2/burn/USDC/fees/${baseDomain}/${arcDomain}`);
  if (!res.ok) die(`fee quote failed: HTTP ${res.status}. Refusing to guess a maxFee.`);
  const quotes = (await res.json()) as Array<{ finalityThreshold: number; minimumFee: number }>;
  const fast = quotes.find((q) => q.finalityThreshold === minFinalityThreshold);
  if (!fast) die(`Fast Transfer (threshold ${minFinalityThreshold}) is not offered on route ${baseDomain}->${arcDomain}. Quotes: ${JSON.stringify(quotes)}`);
  const protocolFee = (amount * BigInt(Math.round(fast.minimumFee * 100))) / 1_000_000n;
  const maxFee = protocolFee * BigInt(maxFeeMargin);
  log(`fee quote: ${fast.minimumFee} bps -> protocolFee ${formatUnits(protocolFee, 6)} USDC, maxFee ${formatUnits(maxFee, 6)}`);
  if (maxFee >= amount) die('quoted fee exceeds the transfer amount');
  return maxFee;
}

/** Base-side readiness: balance and allowance, printed. Aborts on insufficient USDC. */
export async function bridgeReadiness(b: Boot, amount: bigint): Promise<{ usdcBal: bigint; allowance: bigint }> {
  const { ctx } = b;
  const [usdcBal, allowance] = await Promise.all([
    ctx.basePub.readContract({ address: USDC_BASE, abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] }),
    ctx.basePub.readContract({ address: USDC_BASE, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, TOKEN_MESSENGER] }),
  ]);
  console.log('');
  console.log(`  Base USDC        ${formatUnits(usdcBal, 6)}`);
  console.log(`  allowance -> TM  ${formatUnits(allowance, 6)}`);
  if (usdcBal < amount) die('insufficient USDC on Base');
  return { usdcBal, allowance };
}

export interface Burn {
  burnTx: Hex;
  burnMs: number;
  /** wall-clock ms when the burn was sent; attestation latency is measured from here. */
  burnSentMs: number;
}

/** Approve (if needed) and burn `amount` at the configured finality threshold. LIVE only. */
export async function burn(b: Boot, amount: bigint): Promise<Burn> {
  const { ctx, cfg, notifier } = b;
  const { allowance } = await bridgeReadiness(b, amount);

  if (allowance < amount) {
    log('approving USDC -> TokenMessenger...');
    const approveTx = await ctx.baseWallet.sendTransaction({
      to: USDC_BASE,
      data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [TOKEN_MESSENGER, amount * 10n] }),
    });
    const r = await waitReceipt(ctx.basePub, approveTx, cfg.timing.receiptTimeoutSec * 1000, { arc: false });
    if (r.status !== 'success') die(`approve ${r.status}: ${approveTx}. Nothing was burned.`);
    log(`approve mined: ${approveTx}`);
    // Base serves sub-second preconfirmation receipts. A receipt does not mean
    // the new allowance is readable yet, and depositForBurn will revert on a
    // stale one. Poll the actual state instead of trusting it.
    const confirmed = await pollState(
      () => baseRpc(() => ctx.basePub.readContract({ address: USDC_BASE, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, TOKEN_MESSENGER] })),
      (v) => v >= amount,
      { intervalMs: 500, maxMs: 20_000 },
    );
    if (confirmed === undefined || confirmed < amount) die(`allowance still ${confirmed === undefined ? 'unreadable' : formatUnits(confirmed, 6)} after 20s. Nothing was burned. Re-run once it settles.`);
    log(`allowance confirmed readable: ${formatUnits(confirmed, 6)} USDC`);
  } else {
    log('allowance already sufficient, skipping approve');
  }

  const tBurn = Date.now();
  const maxFee = await quoteMaxFee(cfg, amount);
  log('burning on Base...');
  const burnTx = await ctx.baseWallet.sendTransaction({
    to: TOKEN_MESSENGER,
    data: encodeFunctionData({
      abi: TOKEN_MESSENGER_ABI,
      functionName: 'depositForBurn',
      args: [
        amount,
        cfg.route.arcDomain,
        pad(ctx.account.address, { size: 32 }),
        USDC_BASE,
        pad('0x', { size: 32 }), // empty destinationCaller: anyone may mint
        maxFee,
        cfg.route.minFinalityThreshold,
      ],
    }),
  });
  const burnSentMs = Date.now();
  const r = await waitReceipt(ctx.basePub, burnTx, cfg.timing.receiptTimeoutSec * 1000, { arc: false });
  if (r.status === 'no_receipt') die(`burn ${burnTx} has no receipt after ${cfg.timing.receiptTimeoutSec}s. Check Base before doing anything else.`);
  if (r.status === 'reverted') die(`burn reverted: ${burnTx}. Nothing left Base.`);
  const burnMs = Date.now() - tBurn;
  log(`burned in block ${r.receipt.blockNumber} (${burnMs} ms): ${burnTx}`);
  void notifier.emit(
    'bridge.burn_sent',
    embed({
      title: 'bridge.burn_sent',
      color: COLORS.info,
      elapsedMs: burnMs,
      fields: [
        { name: 'amount', value: `${formatUnits(amount, 6)} USDC`, inline: true },
        { name: 'threshold', value: String(cfg.route.minFinalityThreshold), inline: true },
        { name: 'maxFee', value: `${formatUnits(maxFee, 6)} USDC`, inline: true },
        { name: 'tx', value: baseTx(burnTx) },
      ],
    }),
  );
  return { burnTx, burnMs, burnSentMs };
}

// ── cli ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const b = boot('bridge', process.argv.slice(2));
  const { cfg, ctx, notifier } = b;
  if (cfg.live && !cfg.cli.amount && !cfg.cli.burnTx) die('--live requires an explicit --amount. Refusing to guess a size.');
  const amount = parseUnits(cfg.cli.amount ?? '1', 6); // USDC is 6-dec on Base

  console.log(`  amount     ${formatUnits(amount, 6)} USDC`);
  console.log(`  route      Base (d${cfg.route.baseDomain}) -> Arc (d${cfg.route.arcDomain})`);
  console.log(`  mode       Fast Transfer (threshold ${cfg.route.minFinalityThreshold})\n`);

  const pf = await preflight(ctx, { base: true, spend: { usdc6: 0n, ownTxs: 1, what: 'mint' } });
  if (!cfg.live) {
    await bridgeReadiness(b, amount);
    await quoteMaxFee(cfg, amount);
    console.log(`\n${C.green('Dry run complete.')} Everything needed for the burn is in place.\nExecute: ${C.bold(`npx tsx src/bridge.ts --live --amount ${formatUnits(amount, 6)}`)}\n`);
    printDryRunPayloads(notifier, cfg.discordDryRun);
    return;
  }

  let burnTx: Hex;
  let burnMs = 0;
  let burnSentMs: number | undefined;
  if (cfg.cli.burnTx) {
    burnTx = cfg.cli.burnTx;
    log(`resuming from existing burn: ${burnTx}`);
    log('skipping approve and burn');
  } else {
    ({ burnTx, burnMs, burnSentMs } = await burn(b, amount));
  }
  const m = await watchAndMint(b, { burnTx, transmitter: pf.transmitter, burnSentMs });

  console.log(`\n${C.bold('─── result ───')}\n`);
  console.log(`  burn          ${burnMs} ms`);
  console.log(`  attestation   ${m.attMs} ms`);
  console.log(`  mint          ${m.mintMs} ms`);
  console.log(`  ${C.bold('total')}         ${C.bold(`${burnMs + m.attMs + m.mintMs} ms`)}`);
  console.log(`\n  Arc USDC balance (ERC-20, 6-dec)  ${formatUnits(m.arcUsdc, 6)}\n`);
  await notifier.flush();
}

if (process.argv[1] && /bridge\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    if ((e as { exitCode?: number }).exitCode === 2) return;
    console.error(`\n${C.red('failed')} ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
