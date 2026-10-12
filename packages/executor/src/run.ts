/**
 * run — chain bridge -> mint -> buy, timed per stage.
 *
 *   npx tsx src/run.ts --amount 100                                    dry run every stage, bridge == buy
 *   npx tsx src/run.ts --live --amount 5000                            burn 5000, mint on Arc, buy 5000
 *   npx tsx src/run.ts --live --bridge-amount 25000 --buy-amount 10000 burn 25000, buy only 10000 of what lands
 *   npx tsx src/run.ts --live --burn-tx 0x… [--buy-amount N]           resume: mint the existing burn, then buy
 *   npx tsx src/run.ts --live --prefunded --buy-amount 5000            USDC already on Arc: skip bridge + mint, buy
 *
 * Every stage is independently re-runnable via its own script
 * (bridge / mint-watch / buy). Auto-buy: once the mint lands and the
 * preflight passes, the buy fires without a pause.
 *
 * --buy-amount is a spend ceiling, never a clamp target: it must be <=
 * what actually lands on Arc (read from the post-mint balance, since the
 * CCTP protocol fee is deducted from the transfer) or the run aborts
 * before anything signs.
 *
 * Nonce: one Arc counter, initialised ONCE before the mint; approve and
 * swap use local increments. The nonce is never re-read between stages.
 */

import { formatUnits, parseUnits, type Hex } from 'viem';
import { boot, printDryRunPayloads } from './boot.js';
import { bridgeReadiness, burn, quoteMaxFee } from './bridge.js';
import { NonceTracker, preflight, USDC_DECIMALS } from './chain.js';
import { buy, resolvePool } from './buy.js';
import { C, die, log } from './log.js';
import { watchAndMint } from './mint-watch.js';

async function main(): Promise<void> {
  const b = boot('run', process.argv.slice(2));
  const { cfg, ctx, notifier } = b;
  const { prefunded, burnTx: burnTxArg, amount: amountArg, bridgeAmount: bridgeAmountArg, buyAmount: buyAmountArg } = cfg.cli;
  if (amountArg !== undefined && (bridgeAmountArg !== undefined || buyAmountArg !== undefined)) {
    die('--amount cannot be combined with --bridge-amount / --buy-amount; use --amount for both or set them individually.');
  }
  if (prefunded && burnTxArg) die('--prefunded and --burn-tx are mutually exclusive');

  const bridgeAmountStr = prefunded ? undefined : (bridgeAmountArg ?? amountArg);
  const buyAmountStr = buyAmountArg ?? amountArg;
  if (cfg.live) {
    if (prefunded) {
      if (!buyAmountStr) die('--live --prefunded requires an explicit --buy-amount (or --amount). Refusing to guess a size.');
    } else if (!burnTxArg && !bridgeAmountStr) {
      die('--live requires an explicit --bridge-amount (or --amount), or --burn-tx to resume. Refusing to guess a size.');
    }
  }
  const bridgeAmountIn = bridgeAmountStr ? parseUnits(bridgeAmountStr, USDC_DECIMALS) : undefined;
  const buyAmountIn = buyAmountStr ? parseUnits(buyAmountStr, USDC_DECIMALS) : undefined;

  console.log(`  plan          ${prefunded ? 'buy (prefunded)' : burnTxArg ? 'mint (resume) -> buy' : 'bridge -> mint -> buy'}`);
  if (!prefunded) console.log(`  bridge amount ${bridgeAmountIn !== undefined ? `${formatUnits(bridgeAmountIn, 6)} USDC (burn on Base)` : '(resuming existing burn; no new burn)'}`);
  console.log(`  buy amount    ${buyAmountIn !== undefined ? `${formatUnits(buyAmountIn, 6)} USDC (spend on swap)` : '(defaults to the full minted amount)'}\n`);

  const timings: [string, number][] = [];
  const tPre = Date.now();
  const pf = await preflight(ctx, { base: !prefunded, spend: { usdc6: prefunded ? (buyAmountIn ?? 0n) : 0n, ownTxs: (prefunded ? 2 : 3) + (cfg.trade.approveOnFill ? 1 : 0), what: prefunded ? 'buy (prefunded)' : 'mint + buy' } });
  timings.push(['preflight', Date.now() - tPre]);

  // The Arc nonce is read ONCE: at mint time (mint-watch) or right before the buy (prefunded). Never between mint and buy.
  let nonce: NonceTracker | undefined = cfg.live ? undefined : NonceTracker.fixed(0, ctx.account.address);

  // Cached pool > configured tier (fast) > full discovery, same as buy.ts/sell.ts: on a degraded RPC, full enumeration
  // BEFORE the mint is the difference between 5s and 46s before anything signs.
  const tPool = Date.now();
  const resolved = await resolvePool(b, cfg.trade.targetToken);
  timings.push(['pool', Date.now() - tPool]);

  let buyAmount = buyAmountIn;
  if (!prefunded) {
    let burnTx: Hex | undefined = burnTxArg;
    let burnSentMs: number | undefined;
    if (!burnTx) {
      const t = Date.now();
      if (cfg.live) {
        const r = await burn(b, bridgeAmountIn!);
        burnTx = r.burnTx;
        burnSentMs = r.burnSentMs;
      } else {
        await bridgeReadiness(b, bridgeAmountIn ?? parseUnits('1', 6));
        await quoteMaxFee(cfg, bridgeAmountIn ?? parseUnits('1', 6));
        log('dry run: would approve + depositForBurn here');
      }
      timings.push(['bridge', Date.now() - t]);
    }
    const t = Date.now();
    if (burnTx) {
      const m = await watchAndMint(b, { burnTx, transmitter: pf.transmitter, nonce, burnSentMs });
      if (cfg.live) {
        if (buyAmountIn !== undefined) {
          if (buyAmountIn > m.minted) {
            die(
              `--buy-amount ${formatUnits(buyAmountIn, 6)} USDC exceeds the ${formatUnits(m.minted, 6)} USDC actually minted ` +
                `(the CCTP protocol fee is deducted from the transfer). Refusing to clamp — resize --buy-amount, or omit it to buy the full minted amount.`,
            );
          }
        } else {
          buyAmount = m.minted;
        }
      }
      nonce = m.nonce ?? nonce;
    } else {
      log('dry run: no burn tx; mint stage skipped (pass --burn-tx to dry-run the attestation poll)');
    }
    timings.push(['mint', Date.now() - t]);
  }

  const t = Date.now();
  nonce ??= await NonceTracker.init(ctx.arcPub, ctx.account.address);
  const fill = await buy(b, { nonce, token: cfg.trade.targetToken, amountIn: buyAmount ?? parseUnits('1', 6), slippageBps: cfg.trade.slippageBps, pool: resolved });
  timings.push(['buy', Date.now() - t]);

  console.log(`\n${C.bold('─── timings ───')}\n`);
  for (const [k, ms] of timings) console.log(`  ${k.padEnd(12)} ${ms} ms`);
  console.log(`  ${C.bold('total'.padEnd(12))} ${C.bold(`${timings.reduce((a, [, ms]) => a + ms, 0)} ms`)}\n`);
  if (fill) log(`position open: ${formatUnits(fill.tokensOut, fill.pool.tokenDecimals)} ${fill.pool.symbol} for ${formatUnits(fill.usdcIn, 6)} USDC`);
  if (!cfg.live) printDryRunPayloads(notifier, cfg.discordDryRun);
  await notifier.flush();
  b.release();
}

main().catch((e) => {
  if ((e as { exitCode?: number }).exitCode === 2) return;
  console.error(`\n${C.red('failed')} ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
