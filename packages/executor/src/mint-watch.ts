/**
 * mint-watch — poll ONE existing burn's attestation until complete, then mint.
 *
 *   npx tsx src/mint-watch.ts --burn-tx 0x…            dry run: one Iris poll, report status
 *   npx tsx src/mint-watch.ts --live --burn-tx 0x…     poll until complete, then receiveMessage on Arc
 *
 * This IS the detector. Our own pending message flips to `complete` the
 * instant Circle enables attestations for the domain; no eth_call gates,
 * no state machine. Safely restartable at any point: attestations never
 * expire, and a message already minted is detected via usedNonces() and
 * skipped instead of reverting.
 *
 * The completed message object is dumped ONCE, in full, so we learn which
 * field reports the finality threshold actually served.
 */

import { encodeFunctionData, formatUnits, type Hex } from 'viem';
import { boot, printDryRunPayloads, type Boot } from './boot.js';
import { acquireLockWait, broadcast, ERC20, NonceTracker, pollState, preflight, rpc, signTx, TRANSMITTER_ABI, USDC_ARC, waitReceipt } from './chain.js';
import { C, die, log, sleep } from './log.js';
import { arcTx, baseTx, COLORS, embed } from './notify.js';

export interface IrisMessage {
  status?: string;
  message?: Hex | null;
  attestation?: Hex | 'PENDING' | null;
  eventNonce?: Hex;
  delayReason?: string | null;
  decodedMessage?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface Attested {
  message: Hex;
  attestation: Hex;
  raw: IrisMessage;
  attMs: number;
}

/** Walk the object and list every key path containing "finality" (so a downgrade can never hide again). */
export function finalityFields(v: unknown, at = ''): string[] {
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => {
    const p = at ? `${at}.${k}` : k;
    const here = /finality/i.test(k) ? [`${p}=${JSON.stringify(x)}`] : [];
    return [...here, ...finalityFields(x, p)];
  });
}

/**
 * Poll Iris for `burnTx`. `once` = a single poll (dry run). Returns undefined
 * when not complete within `maxMs` (or after the single poll). `sourceDomain`
 * is the CCTP domain the burn happened on (Base=6 for the inbound leg,
 * Arc=26 for bridge-out.ts's outbound leg) — Iris indexes messages by their
 * source domain, so this must match where the burn actually happened.
 */
export async function pollAttestation(b: Boot, burnTx: Hex, o: { once?: boolean; burnSentMs?: number; sourceDomain: number }): Promise<Attested | undefined> {
  const { cfg, notifier } = b;
  const url = `${cfg.irisUrl}/v2/messages/${o.sourceDomain}?transactionHash=${burnTx}`;
  const tAtt = Date.now();
  const deadline = tAtt + cfg.timing.attestationTimeoutSec * 1000;
  log(`polling attestation every ${cfg.timing.attestationPollMs} ms: ${C.dim(url)}`);
  let lastStatus = '';
  let pendingNotified = false;
  for (let i = 0; o.once ? i < 1 : Date.now() < deadline; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { messages?: IrisMessage[] };
        const m = data.messages?.[0];
        if (m?.status === 'complete' && m.message && m.attestation && m.attestation !== 'PENDING') {
          const attMs = Date.now() - (o.burnSentMs ?? tAtt);
          console.log(`\n${C.bold('completed message object (dumped once; look for the finality field):')}`);
          console.log(C.dim(JSON.stringify(m, null, 2)));
          const ff = finalityFields(m);
          log(ff.length ? `finality fields: ${ff.join(' ')}` : C.yellow('no key containing "finality" in the completed message'));
          log(`attestation received (${attMs} ms${o.burnSentMs ? ' since burn' : ' since poll start'})`);
          const fast = attMs <= cfg.timing.fastTransferTargetMs;
          void notifier.emit(
            'bridge.attestation_complete',
            embed({ title: 'bridge.attestation_complete', color: COLORS.ok, elapsedMs: attMs, fields: [{ name: 'burn', value: baseTx(burnTx) }, { name: 'finality', value: ff.join('\n') || 'n/a' }] }),
          );
          if (!fast) {
            log(C.yellow(`downgrade suspected: ${attMs} ms > fastTransferTargetMs ${cfg.timing.fastTransferTargetMs}`));
            void notifier.emit(
              'bridge.downgrade_detected',
              embed({
                title: 'bridge.downgrade_detected',
                color: COLORS.warn,
                elapsedMs: attMs,
                fields: [
                  { name: 'target', value: `${cfg.timing.fastTransferTargetMs} ms`, inline: true },
                  { name: 'burn', value: baseTx(burnTx) },
                  { name: 'finality', value: ff.join('\n') || 'n/a' },
                ],
              }),
            );
          }
          return { message: m.message, attestation: m.attestation as Hex, raw: m, attMs };
        }
        const tag = `${m?.status ?? 'no message'}${m?.delayReason ? ` (${m.delayReason})` : ''}`;
        if (tag !== lastStatus) {
          lastStatus = tag;
          log(`iris status: ${C.dim(tag)}`);
          if (!pendingNotified && m?.status) {
            pendingNotified = true;
            void notifier.emit('bridge.attestation_pending', embed({ title: 'bridge.attestation_pending', color: COLORS.info, fields: [{ name: 'status', value: tag, inline: true }, { name: 'burn', value: baseTx(burnTx) }] }));
          }
        }
      } else {
        // 404 is expected until the message is indexed, but stay visible:
        // a silent 404 loop is indistinguishable from a wrong host.
        const tag = `HTTP ${res.status}`;
        if (tag !== lastStatus) {
          lastStatus = tag;
          log(`iris ${C.dim(tag)} ${C.dim((await res.text()).slice(0, 120))}`);
        }
      }
    } catch (e) {
      log(C.red(`iris unreachable: ${(e as Error).message}`));
    }
    if (i > 0 && i % 30 === 0) log(C.dim(`still waiting (${((Date.now() - tAtt) / 60_000).toFixed(1)} min)`));
    if (!o.once) await sleep(cfg.timing.attestationPollMs);
  }
  return undefined;
}

/**
 * receiveMessage on Arc. Returns undefined if the message was already minted.
 *
 * The wallet nonce is read HERE, at mint time, never at process start: this
 * process may wait hours while buy/sell consume nonces on the same wallet
 * (a counter pre-read at start would send a stale nonce and fail). The
 * single-instance lock is taken here too, so a waiting watcher never blocks
 * a sell, and a live signer never runs concurrently with the mint.
 * `o.nonce` (run.ts) continues the same counter into the buy: no re-read
 * between mint and buy.
 */
export async function mint(b: Boot, o: { transmitter: `0x${string}`; nonce?: NonceTracker; att: Attested }): Promise<{ mintTx: Hex; mintMs: number; nonce: NonceTracker } | undefined> {
  const { ctx, cfg } = b;
  const evNonce = o.att.raw.eventNonce;
  if (evNonce) {
    const used = await rpc(() => ctx.arcPub.readContract({ address: o.transmitter, abi: TRANSMITTER_ABI, functionName: 'usedNonces', args: [evNonce] }));
    if (used !== 0n) {
      log(`message nonce already used on Arc: minted in an earlier run, skipping receiveMessage`);
      return undefined;
    }
  }
  const tMint = Date.now();
  const release = o.nonce ? () => undefined : await acquireLockWait(process.cwd(), ctx.account.address, 60_000);
  const nonce = o.nonce ?? (await NonceTracker.init(ctx.arcPub, ctx.account.address));
  const n = nonce.next();
  const data = encodeFunctionData({ abi: TRANSMITTER_ABI, functionName: 'receiveMessage', args: [o.att.message, o.att.attestation] });
  let gas: bigint;
  try {
    gas = ((await rpc(() => ctx.arcPub.estimateGas({ account: ctx.account, to: o.transmitter, data }))) * 130n) / 100n;
  } catch (e) {
    release();
    die(`receiveMessage simulation reverted before sending (nothing spent): ${(e as Error).message.split('\n').slice(0, 3).join(' | ')}`);
  }
  log(`minting on Arc (nonce ${n}, gas ${gas})...`);
  let mintTx: Hex;
  try {
    mintTx = (await broadcast(ctx, await signTx(ctx, { to: o.transmitter, data, nonce: n, gas }), 'mint')).hash;
  } catch (e) {
    release();
    die(`mint broadcast rejected: ${(e as Error).message.split('\n')[0]}`);
  }
  const r = await waitReceipt(ctx.arcPub, mintTx, cfg.timing.receiptTimeoutSec * 1000);
  if (r.status === 'no_receipt') die(`mint ${mintTx} has no receipt after ${cfg.timing.receiptTimeoutSec}s: not mined (blocklist?). The nonce counter is now unknown; re-run mint-watch, it is restartable.`);
  if (r.status === 'reverted') die(`mint reverted with receipt: ${mintTx} (nonce ${n} consumed). Re-run mint-watch; if usedNonces reports used, the funds already arrived.`);
  const mintMs = Date.now() - tMint;
  log(`minted in block ${r.receipt.blockNumber} (${mintMs} ms): ${mintTx}`);
  release();
  return { mintTx, mintMs, nonce };
}

export interface MintResult {
  attMs: number;
  mintTx?: Hex;
  mintMs: number;
  /** Arc USDC ERC-20 balance (6-dec) after the mint, confirmed readable. */
  arcUsdc: bigint;
  minted: bigint;
  /** The counter used for the mint, to be continued by the buy (never re-read in between). */
  nonce?: NonceTracker;
}

/** Poll until attested, mint, and confirm the USDC is readable on Arc. Dry run: one poll and stop. */
export async function watchAndMint(b: Boot, o: { burnTx: Hex; transmitter: `0x${string}`; nonce?: NonceTracker; burnSentMs?: number }): Promise<MintResult> {
  const { ctx, cfg, notifier } = b;
  const before = await rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] }));
  log(`Arc USDC before mint: ${formatUnits(before, 6)} ${C.dim('(ERC-20, 6-dec)')}`);
  const att = await pollAttestation(b, o.burnTx, { once: !cfg.live, burnSentMs: o.burnSentMs, sourceDomain: cfg.route.baseDomain });
  if (!att) {
    if (!cfg.live) {
      log(`dry run: attestation not complete; would mint via ${o.transmitter} once it is. Live: npx tsx src/mint-watch.ts --live --burn-tx ${o.burnTx}`);
      return { attMs: 0, mintMs: 0, arcUsdc: before, minted: 0n };
    }
    die(`no attestation after ${cfg.timing.attestationTimeoutSec}s. The burn happened; the USDC is not lost, only unminted. Resume later with:\n  npx tsx src/mint-watch.ts --live --burn-tx ${o.burnTx}`);
  }
  if (!cfg.live) {
    log(`dry run: attestation complete; would call receiveMessage on ${o.transmitter}`);
    return { attMs: att.attMs, mintMs: 0, arcUsdc: before, minted: 0n };
  }
  const m = await mint(b, { transmitter: o.transmitter, nonce: o.nonce, att });
  // A receipt does not mean the balance is readable on a lagging public RPC. Poll the state.
  const after = await pollState(
    () => rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] })),
    (v) => v > before || m === undefined,
    { intervalMs: 500, maxMs: 30_000 },
  );
  if (after === undefined) die('Arc USDC balance unreadable after mint (RPC). The mint may be fine; re-run mint-watch before buying.');
  if (m && after <= before) die(`mint ${m.mintTx} succeeded but the USDC balance did not move within 30s (${formatUnits(before, 6)} -> ${formatUnits(after, 6)}). Re-check before buying.`);
  const minted = after - before;
  log(`Arc USDC after mint: ${formatUnits(after, 6)} (+${formatUnits(minted, 6)})`);
  if (m) {
    void notifier.emit(
      'bridge.mint_complete',
      embed({
        title: 'bridge.mint_complete',
        color: COLORS.ok,
        elapsedMs: m.mintMs,
        fields: [
          { name: 'minted', value: `${formatUnits(minted, 6)} USDC`, inline: true },
          { name: 'attestation', value: `${att.attMs} ms`, inline: true },
          { name: 'tx', value: arcTx(m.mintTx) },
        ],
      }),
    );
  }
  return { attMs: att.attMs, mintTx: m?.mintTx, mintMs: m?.mintMs ?? 0, arcUsdc: after, minted, nonce: m?.nonce ?? o.nonce };
}

// ── cli ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // No lock at boot: the watcher may sit for hours next to a sell TUI. Lock + nonce are taken at mint time.
  const b = boot('mint-watch', process.argv.slice(2), { lock: false });
  const { cfg, ctx, notifier } = b;
  if (!cfg.cli.burnTx) die('--burn-tx 0x… is required (the Base burn to watch)');
  const pf = await preflight(ctx, { base: true, spend: { usdc6: 0n, ownTxs: 1, what: 'mint' } });
  const m = await watchAndMint(b, { burnTx: cfg.cli.burnTx, transmitter: pf.transmitter });
  console.log(`\n${C.bold('─── result ───')}\n`);
  console.log(`  attestation   ${m.attMs} ms`);
  console.log(`  mint          ${m.mintMs} ms ${m.mintTx ?? ''}`);
  console.log(`  Arc USDC      ${formatUnits(m.arcUsdc, 6)}\n`);
  if (!cfg.live) printDryRunPayloads(notifier, cfg.discordDryRun);
  await notifier.flush();
}

if (process.argv[1] && /mint-watch\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    if ((e as { exitCode?: number }).exitCode === 2) return;
    console.error(`\n${C.red('failed')} ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
