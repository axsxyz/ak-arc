/**
 * bridge-out — CCTP V2, Arc mainnet -> Base mainnet (the return leg).
 *
 *   npx tsx src/bridge-out.ts                        dry run, no signing
 *   npx tsx src/bridge-out.ts --live --amount 1       burns 1 USDC on Arc for real, then mints on Base
 *   npx tsx src/bridge-out.ts --live --burn-tx 0x…    resume: skip approve+burn, poll attestation, mint
 *   npx tsx src/bridge-out.ts --live --amount 1 --to 0x…   mint to a different address on Base
 *
 * Mirrors bridge.ts's structure, direction reversed: burn happens on ARC
 * (so it uses the same manual NonceTracker + signTx + broadcast discipline
 * mint-watch.ts uses for Arc-side txs — Arc needs an explicit nonce counter,
 * unlike Base's wallet-client auto-nonce), attestation is polled from Arc's
 * domain, and the mint (receiveMessage) happens on BASE via the wallet
 * client, exactly like bridge.ts's own Base-side burn.
 *
 * Differences from the inbound leg (bridge.ts), and why:
 *   - Arc's own attestation is ~0.5s at 1 confirmation; there is no
 *     "Fast Transfer" tier to ask for here because standard is already
 *     fast. `quoteFeeOut` never sends a hardcoded minFinalityThreshold —
 *     it reads whatever /v2/burn/USDC/fees/26/6 actually quotes (the
 *     cheapest offered) and burns at THAT threshold.
 *   - receiveMessage on Base costs ETH, not USDC. Arc's gas floor
 *     (preflight, via assertGasFloor) covers the approve+burn; a separate
 *     `assertBaseGas` covers the Base-side mint, the same "abort, don't
 *     guess" discipline the Arc leg already applies to its own gas.
 *   - `TOKEN_MESSENGER` is the same CREATE2 address on both chains, so the
 *     approve target and the depositForBurn target are identical to
 *     bridge.ts's, just called on Arc's client instead of Base's.
 */

import { encodeFunctionData, formatEther, formatUnits, getAddress, pad, parseUnits, type Address, type Hex } from 'viem';
import { boot, printDryRunPayloads, type Boot } from './boot.js';
import { baseRpc, broadcast, ERC20, NonceTracker, pollState, preflight, rpc, signTx, TOKEN_MESSENGER, TOKEN_MESSENGER_ABI, TRANSMITTER_ABI, USDC_ARC, waitReceipt } from './chain.js';
import type { Config } from './config.js';
import { C, die, log } from './log.js';
import { pollAttestation, type Attested } from './mint-watch.js';
import { arcTx, baseTx, COLORS, embed } from './notify.js';

/**
 * Quote the fee for Arc -> Base, right before burning. Circle's formula:
 * protocolFee = amount * round(minimumFee * 100) / 1e6, proportional to the
 * amount — never a hardcoded constant. Unlike bridge.ts's quoteMaxFee (which
 * insists on Fast Transfer, threshold 1000), this does NOT assume a
 * threshold: Arc standard attestation is already ~0.5s, so whichever
 * threshold /fees/26/6 actually quotes is what gets burned at. Picks the
 * cheapest offered quote when more than one is returned.
 */
export async function quoteFeeOut(cfg: Config, amount: bigint): Promise<{ maxFee: bigint; threshold: number }> {
  const { arcDomain, baseDomain, maxFeeMargin } = cfg.route;
  const res = await fetch(`${cfg.irisUrl}/v2/burn/USDC/fees/${arcDomain}/${baseDomain}`);
  if (!res.ok) die(`fee quote failed: HTTP ${res.status}. Refusing to guess a maxFee.`);
  const quotes = (await res.json()) as Array<{ finalityThreshold: number; minimumFee: number }>;
  if (!quotes.length) die(`no fee quotes offered on route ${arcDomain}->${baseDomain}. Refusing to guess a threshold.`);
  const chosen = quotes.reduce((a, b) => (b.minimumFee < a.minimumFee ? b : a));
  const protocolFee = (amount * BigInt(Math.round(chosen.minimumFee * 100))) / 1_000_000n;
  const maxFee = protocolFee * BigInt(maxFeeMargin);
  log(`fee quote (Arc standard attestation ~0.5s; no Fast Transfer tier here): threshold ${chosen.finalityThreshold}, ${chosen.minimumFee} bps -> protocolFee ${formatUnits(protocolFee, 6)} USDC, maxFee ${formatUnits(maxFee, 6)}`);
  if (maxFee >= amount) die('quoted fee exceeds the transfer amount');
  return { maxFee, threshold: chosen.finalityThreshold };
}

/** Arc-side readiness: USDC balance and allowance to the TokenMessenger, printed. Aborts on insufficient USDC. */
export async function arcReadiness(b: Boot, amount: bigint): Promise<{ usdcBal: bigint; allowance: bigint }> {
  const { ctx } = b;
  const [usdcBal, allowance] = await Promise.all([
    rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] })),
    rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, TOKEN_MESSENGER] })),
  ]);
  console.log('');
  console.log(`  Arc USDC         ${formatUnits(usdcBal, 6)}`);
  console.log(`  allowance -> TM  ${formatUnits(allowance, 6)}`);
  if (usdcBal < amount) die('insufficient USDC on Arc');
  return { usdcBal, allowance };
}

/**
 * Gas for receiveMessage on Base is ETH, not USDC — the Arc gas floor
 * (assertGasFloor, inside preflight) says nothing about it. Aborts if the
 * Base ETH balance can't plausibly cover a receiveMessage call. 200k gas is
 * a conservative headroom for a single CCTP message verification + mint;
 * the real cost is estimated (and this exact check redone implicitly) right
 * before signing, in mintOnBase.
 */
export async function assertBaseGas(b: Boot): Promise<void> {
  const { ctx } = b;
  const [ethBal, gasPrice] = await Promise.all([baseRpc(() => ctx.basePub.getBalance({ address: ctx.account.address })), baseRpc(() => ctx.basePub.getGasPrice())]);
  const headroomGas = 200_000n;
  const needed = headroomGas * gasPrice;
  if (ethBal === 0n) die('zero ETH on Base. receiveMessage must be paid in ETH, not USDC — seed the wallet with Base ETH before bridging out.');
  if (ethBal < needed) die(`Base ETH balance ${formatEther(ethBal)} is below the estimated cost of receiveMessage (~${formatEther(needed)} ETH at ${gasPrice / 1_000_000_000n} Gwei, ${headroomGas} gas headroom). Seed more ETH on Base first.`);
  log(`Base gas: balance ${formatEther(ethBal)} ETH, price ${gasPrice / 1_000_000_000n} Gwei (receiveMessage headroom ${headroomGas} gas ~ ${formatEther(needed)} ETH)`);
}

export interface BurnOut {
  burnTx: Hex;
  burnMs: number;
  /** wall-clock ms when the burn was sent; attestation latency is measured from here. */
  burnSentMs: number;
  threshold: number;
}

/** Approve (if needed) and burn `amount` on Arc, minting to `to` on Base. LIVE only. Explicit nonce: Arc needs it, unlike Base's wallet client. */
export async function burnOut(b: Boot, amount: bigint, nonce: NonceTracker, to: Address): Promise<BurnOut> {
  const { ctx, cfg, notifier } = b;
  const { allowance } = await arcReadiness(b, amount);

  if (allowance < amount) {
    log('approving USDC -> TokenMessenger (Arc)...');
    const approveData = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [TOKEN_MESSENGER, amount * 10n] });
    const approveGas = ((await rpc(() => ctx.arcPub.estimateGas({ account: ctx.account, to: USDC_ARC, data: approveData }))) * 130n) / 100n;
    const n = nonce.next();
    log(`approving (nonce ${n}, gas ${approveGas})...`);
    const approveTx = (await broadcast(ctx, await signTx(ctx, { to: USDC_ARC, data: approveData, nonce: n, gas: approveGas }), 'approve')).hash;
    const r = await waitReceipt(ctx.arcPub, approveTx, cfg.timing.receiptTimeoutSec * 1000);
    if (r.status !== 'success') die(`approve ${r.status}: ${approveTx}. Nothing was burned.`);
    log(`approve mined: ${approveTx} gasUsed ${r.receipt.gasUsed}`);
    // Same trap as bridge.ts / sell.ts: a receipt does not mean the new allowance is readable yet.
    const confirmed = await pollState(
      () => rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, TOKEN_MESSENGER] })),
      (v) => v >= amount,
      { intervalMs: 500, maxMs: 20_000 },
    );
    if (confirmed === undefined || confirmed < amount) die(`allowance still ${confirmed === undefined ? 'unreadable' : formatUnits(confirmed, 6)} after 20s. Nothing was burned. Re-run once it settles.`);
    log(`allowance confirmed readable: ${formatUnits(confirmed, 6)} USDC`);
  } else {
    log('allowance already sufficient, skipping approve');
  }

  const tBurn = Date.now();
  const { maxFee, threshold } = await quoteFeeOut(cfg, amount);
  const burnData = encodeFunctionData({
    abi: TOKEN_MESSENGER_ABI,
    functionName: 'depositForBurn',
    args: [
      amount,
      cfg.route.baseDomain,
      pad(to, { size: 32 }),
      USDC_ARC,
      pad('0x', { size: 32 }), // empty destinationCaller: anyone may mint
      maxFee,
      threshold,
    ],
  });
  const burnGas = ((await rpc(() => ctx.arcPub.estimateGas({ account: ctx.account, to: TOKEN_MESSENGER, data: burnData }))) * 130n) / 100n;
  const n = nonce.next();
  log(`burning on Arc (nonce ${n}, gas ${burnGas})${to.toLowerCase() !== ctx.account.address.toLowerCase() ? `, mintRecipient ${to}` : ''}...`);
  const burnTx = (await broadcast(ctx, await signTx(ctx, { to: TOKEN_MESSENGER, data: burnData, nonce: n, gas: burnGas }), 'burn (Arc->Base)')).hash;
  const burnSentMs = Date.now();
  const r = await waitReceipt(ctx.arcPub, burnTx, cfg.timing.receiptTimeoutSec * 1000);
  if (r.status === 'no_receipt') die(`burn ${burnTx} has no receipt after ${cfg.timing.receiptTimeoutSec}s. Check Arc before doing anything else. Nonce counter unknown: restart before signing again.`);
  if (r.status === 'reverted') die(`burn reverted: ${burnTx} (nonce ${n} consumed). Nothing left Arc.`);
  const burnMs = Date.now() - tBurn;
  log(`burned in block ${r.receipt.blockNumber} (${burnMs} ms): ${burnTx}`);
  void notifier.emit(
    'bridge.burn_sent',
    embed({
      title: 'bridge.burn_sent (Arc -> Base)',
      color: COLORS.info,
      elapsedMs: burnMs,
      fields: [
        { name: 'amount', value: `${formatUnits(amount, 6)} USDC`, inline: true },
        { name: 'threshold', value: String(threshold), inline: true },
        { name: 'maxFee', value: `${formatUnits(maxFee, 6)} USDC`, inline: true },
        { name: 'tx', value: arcTx(burnTx) },
      ],
    }),
  );
  return { burnTx, burnMs, burnSentMs, threshold };
}

export interface MintOut {
  mintTx?: Hex;
  mintMs: number;
}

/**
 * receiveMessage on Base. Returns mintTx undefined if the message was
 * already minted (usedNonces), so a resumed run never double-mints. Base's
 * wallet client handles its own nonce (single-shot per session, same as
 * bridge.ts's burn), unlike Arc's explicit counter.
 */
export async function mintOnBase(b: Boot, o: { transmitter: Address; att: Attested }): Promise<MintOut> {
  const { ctx, cfg } = b;
  const evNonce = o.att.raw.eventNonce;
  if (evNonce) {
    const used = await baseRpc(() => ctx.basePub.readContract({ address: o.transmitter, abi: TRANSMITTER_ABI, functionName: 'usedNonces', args: [evNonce] }));
    if (used !== 0n) {
      log('message nonce already used on Base: minted in an earlier run, skipping receiveMessage');
      return { mintMs: 0 };
    }
  }
  const tMint = Date.now();
  const data = encodeFunctionData({ abi: TRANSMITTER_ABI, functionName: 'receiveMessage', args: [o.att.message, o.att.attestation] });
  log('minting (receiveMessage) on Base...');
  const mintTx = await ctx.baseWallet.sendTransaction({ to: o.transmitter, data });
  const r = await waitReceipt(ctx.basePub, mintTx, cfg.timing.receiptTimeoutSec * 1000, { arc: false });
  if (r.status === 'no_receipt') die(`receiveMessage ${mintTx} has no receipt after ${cfg.timing.receiptTimeoutSec}s (not mined). Re-run bridge-out --live --burn-tx ${'0x…'} to resume; it is restartable.`);
  if (r.status === 'reverted') die(`receiveMessage reverted: ${mintTx}. Check usedNonces before retrying — it may already be minted.`);
  const mintMs = Date.now() - tMint;
  log(`minted in block ${r.receipt.blockNumber} (${mintMs} ms): ${mintTx}`);
  return { mintTx, mintMs };
}

// ── cli ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const b = boot('bridge-out', process.argv.slice(2));
  const { cfg, ctx, notifier } = b;
  if (cfg.live && !cfg.cli.amount && !cfg.cli.burnTx) die('--live requires an explicit --amount. Refusing to guess a size.');
  const amount = parseUnits(cfg.cli.amount ?? '1', 6); // USDC is 6-dec on Arc too
  const to = cfg.cli.to ?? ctx.account.address;

  console.log(`  amount     ${formatUnits(amount, 6)} USDC`);
  console.log(`  route      Arc (d${cfg.route.arcDomain}) -> Base (d${cfg.route.baseDomain})`);
  console.log(`  mintTo     ${getAddress(to)}${to.toLowerCase() === ctx.account.address.toLowerCase() ? C.dim(' (this wallet)') : C.dim(' (--to)')}\n`);

  // base:true asserts Base's chainId AND that Base's TokenMessenger has Arc registered (needed for receiveMessage
  // to validate the message); route!==false (default) asserts Arc has Base registered (the burn's destination) and
  // checks the Arc gas floor for the approve+burn about to happen here. Both checks, both directions, reused as-is.
  await preflight(ctx, { base: true, spend: { usdc6: 0n, ownTxs: 2, what: 'bridge-out (approve + burn)' } });
  // preflight's `transmitter` is Arc's own (irrelevant here); Base's is resolved separately, at runtime, never hardcoded.
  const baseTransmitter = getAddress(await baseRpc(() => ctx.basePub.readContract({ address: TOKEN_MESSENGER, abi: TOKEN_MESSENGER_ABI, functionName: 'localMessageTransmitter' })));
  if (/^0x0+$/.test(baseTransmitter)) die('Base localMessageTransmitter is unset');
  log(`Base MessageTransmitter: ${baseTransmitter}`);
  await assertBaseGas(b);

  if (!cfg.live) {
    await arcReadiness(b, amount);
    await quoteFeeOut(cfg, amount);
    console.log(`\n${C.green('Dry run complete.')} Everything needed for the burn is in place.\nExecute: ${C.bold(`npx tsx src/bridge-out.ts --live --amount ${formatUnits(amount, 6)}`)}\n`);
    printDryRunPayloads(notifier, cfg.discordDryRun);
    return;
  }

  const nonce = await NonceTracker.init(ctx.arcPub, ctx.account.address);

  let burnTx: Hex;
  let burnMs = 0;
  let burnSentMs: number | undefined;
  if (cfg.cli.burnTx) {
    burnTx = cfg.cli.burnTx;
    log(`resuming from existing burn: ${burnTx}`);
    log('skipping approve and burn');
  } else {
    ({ burnTx, burnMs, burnSentMs } = await burnOut(b, amount, nonce, to));
  }

  const att = await pollAttestation(b, burnTx, { once: !cfg.live, burnSentMs, sourceDomain: cfg.route.arcDomain });
  if (!att) die(`no attestation after ${cfg.timing.attestationTimeoutSec}s. The burn happened; the USDC is not lost, only unminted. Resume later with:\n  npx tsx src/bridge-out.ts --live --burn-tx ${burnTx}`);

  const m = await mintOnBase(b, { transmitter: baseTransmitter, att });
  if (m.mintTx) {
    void notifier.emit(
      'bridge.mint_complete',
      embed({
        title: 'bridge.mint_complete (Arc -> Base)',
        color: COLORS.ok,
        elapsedMs: m.mintMs,
        fields: [
          { name: 'amount', value: `${formatUnits(amount, 6)} USDC`, inline: true },
          { name: 'attestation', value: `${att.attMs} ms`, inline: true },
          { name: 'tx', value: baseTx(m.mintTx) },
        ],
      }),
    );
  }

  console.log(`\n${C.bold('─── result ───')}\n`);
  console.log(`  burn          ${burnMs} ms`);
  console.log(`  attestation   ${att.attMs} ms`);
  console.log(`  mint          ${m.mintMs} ms ${m.mintTx ?? '(already minted)'}`);
  console.log(`  ${C.bold('total')}         ${C.bold(`${burnMs + att.attMs + m.mintMs} ms`)}\n`);
  await notifier.flush();
}

if (process.argv[1] && /bridge-out\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    if ((e as { exitCode?: number }).exitCode === 2) return;
    console.error(`\n${C.red('failed')} ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
