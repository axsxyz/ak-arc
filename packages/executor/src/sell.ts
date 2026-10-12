/**
 * sell — interactive multi-position TUI: watch every held position, sell fractions
 * on hotkeys. One process arms every position because they share a wallet and a
 * nonce counter: a fire in one silently invalidates every other position's
 * pre-signed tiers, so two TUIs (or two single-position processes) is not a safe
 * shape here.
 *
 *   npx tsx src/sell.ts --cost-usdc 5000 --entry-tokens N          dry run: keypress prints the tx it would send
 *   npx tsx src/sell.ts --live --cost-usdc 5000 --entry-tokens N   arms the hotkeys
 *
 * Positions: trade.targetToken + every trade.tokens key + EXTRA_TOKENS (.env),
 * filtered to non-zero balances. TAB / `[` `]` cycles the selected position;
 * a/s/d… jumps directly to one (assigned in arming order, printed in the
 * header). Number keys sell that % of the SELECTED position — never any other —
 * and the header marks the armed position unmistakably (▶, bold) so a fast
 * TAB-then-number sequence can't fire on the wrong position.
 *
 * --cost-usdc / --entry-tokens track PnL for trade.targetToken's position only
 * (the position this tool was originally aimed at); every other position renders
 * without PnL, position/balance/tier data only.
 *
 * Live view: a portfolio header (balance, mark, ▲▼ since the last refresh,
 * % of pool depth, and "exit ≈" — modelled net proceeds of selling the WHOLE
 * position in one order, fee + impact included) above the selected position's detail
 * (balance, PnL split realised/unrealised/total against a FIXED entry, and
 * its tier table). Every tier's calldata is built and signed BEFORE the
 * keypress, so a press only broadcasts.
 *
 * Nonce model (ONE counter for the whole process; instrumented, every step
 * printed to stdout as it happens):
 *   - every tier of every position is pre-signed at the SAME nonce (only one tx
 *     across the whole portfolio can fire next)
 *   - a fire reserves the nonce, broadcasts the pre-signed tx, then
 *     invalidates every other tier — in every position — and re-signs all of
 *     them at nonce+1: the fired position on its PROJECTED balance, every other
 *     position on its UNCHANGED balance. No receipt wait: a second tier pressed
 *     right after (on any position) lands behind the first. ~15 signatures for
 *     3 positions × 5 tiers, a few ms — keypress→broadcast stays under 1 ms.
 *   - single-flight across the WHOLE portfolio: one broadcast at a time; a
 *     press during a broadcast, during re-signing, or a same-key double-tap
 *     on the same position inside DOUBLE_TAP_MS is REJECTED and logged with the
 *     reason. Exactly one tx per accepted press.
 *   - receipts are awaited in the background and reported when they land
 *
 * Transport: WSS (ARC_MAINNET_WSS_URL) when set, HTTP polling otherwise.
 * Hotkeys are manual by design. No automated exit strategy lives here.
 */

import { encodeFunctionData, formatUnits, getAddress, type Address, type Hex } from 'viem';
import { v3TokenPriceUsd } from '../../radar/src/math/price.js';
import { toNumber } from '../../radar/src/math/units.js';
import { boot, type Boot } from './boot.js';
import { broadcast, ERC20, NonceTracker, POOL_ABI, pollState, preflight, readHandle, rpc, signTx, USDC_ARC, USDC_DECIMALS, waitReceipt, type Ctx, type SignedTx } from './chain.js';
import type { Config } from './config.js';
import { impactBps, realisedLegBps, type ImpactBreakdown } from './impact.js';
import { C, die, elapsedMs, log } from './log.js';
import { arcTx, COLORS, embed } from './notify.js';
import { auditTiers, resolveCachedPool, resolveDeepestPool, resolveSingleTier, type ResolvedPool } from './pool.js';
import { swapAmounts, swapCalldata } from './buy.js';

const CTRL_C = String.fromCharCode(3);
/** Same key pressed again, on the SAME position, inside this window after a fire is a double-tap, not a second sell. */
export const DOUBLE_TAP_MS = 500;
/** Assigned to positions in arming order; 'q' is reserved for quit. */
export const JUMP_KEYS = 'asdfghjklzxcvbnmrtyuiopew'.split('');

export interface Position {
  symbol: string;
  token: Address;
  tokenDecimals: number;
  pool: Address;
  fee: number;
  usdcSide: 0 | 1;
  balance: bigint;
  usdcDepth: number;
  spotUsd: number;
  /** USDC spent to open the position (--cost-usdc). Only tracked for trade.targetToken's position. */
  costUsdc?: number;
  /** Tokens received at fill (--entry-tokens, else the balance when the TUI started). Entry = costUsdc / entryTokens, FIXED for the session. */
  entryTokens?: number;
  updatedMs: number;
}

export interface Sale {
  pct: number;
  usdcOut: number;
  realisedBps?: number;
  predictedBps: number;
  tx: Hex;
}

export interface TierPlan {
  key: string;
  pct: number;
  amountIn: bigint;
  minOut: bigint;
  valueUsd: number;
  predicted: ImpactBreakdown;
  refused?: string;
  signed?: SignedTx;
  nonce?: number;
  signedAtMs?: number;
}

/** One held token, armed for selling. Extends Position with per-position selection/config/live state. */
export interface Bag extends Position {
  /** Direct-jump hotkey (a/s/d/…), assigned once in arming order. */
  jumpKey: string;
  slippageBps: number;
  hotkeys: Record<string, number>;
  tiers: TierPlan[];
  sells: Sale[];
}

export interface Pnl {
  /** cost / tokens received. Never moves when you sell. */
  entryPx: number;
  /** USDC actually received across every sell this session. */
  realised: number;
  /** remaining balance × spot */
  unrealised: number;
  /** realised + unrealised − cost */
  total: number;
  totalPct: number;
  /** cost × remaining / received: what the position still holding cost you. */
  remainingCost: number;
  soldTokens: number;
}

/**
 * Pure. Entry is anchored to the fill, not to the current balance: cost /
 * current_balance inflates entry on every partial sale and reads −100% after
 * a full exit. Total = (realised + unrealised) − cost; after a full exit it is
 * exactly realised − cost.
 */
export function computePnl(i: { costUsdc: number; entryTokens: number; realisedUsdc: number; balanceTokens: number; spotUsd: number }): Pnl {
  const entryPx = i.entryTokens > 0 ? i.costUsdc / i.entryTokens : 0;
  const unrealised = i.balanceTokens * i.spotUsd;
  const total = i.realisedUsdc + unrealised - i.costUsdc;
  const remaining = i.entryTokens > 0 ? Math.min(1, Math.max(0, i.balanceTokens / i.entryTokens)) : 0;
  return {
    entryPx,
    realised: i.realisedUsdc,
    unrealised,
    total,
    totalPct: i.costUsdc > 0 ? (total / i.costUsdc) * 100 : 0,
    remainingCost: i.costUsdc * remaining,
    soldTokens: Math.max(0, i.entryTokens - i.balanceTokens),
  };
}

/** Pure: size every hotkey tier from the live position, re-quote impact, refuse breaches. */
export function planTiers(pos: Position, sell: Config['sell'], slippageBps: number): TierPlan[] {
  return Object.entries(sell.hotkeys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, pct]) => {
      const amountIn = (pos.balance * BigInt(pct)) / 100n;
      const tokens = toNumber(amountIn, pos.tokenDecimals);
      const valueUsd = tokens * pos.spotUsd;
      const expectedUsdc = BigInt(Math.floor(valueUsd * 10 ** USDC_DECIMALS));
      const minOut = (expectedUsdc * BigInt(10_000 - slippageBps)) / 10_000n;
      const predicted = pos.usdcDepth > 0 ? impactBps({ feePpm: pos.fee, sizeUsd: valueUsd, depthUsd: pos.usdcDepth }) : { roundTripBps: 10_000, feeLegsBps: 0, sizeTermBps: 10_000 };
      let refused: string | undefined;
      if (amountIn === 0n) refused = 'nothing to sell';
      else if (sell.perTierMaxImpactBps !== null && predicted.roundTripBps > sell.perTierMaxImpactBps) refused = `round-trip ${predicted.roundTripBps} bps > perTierMaxImpactBps ${sell.perTierMaxImpactBps}`;
      return { key, pct, amountIn, minOut, valueUsd, predicted, refused };
    });
}

export interface Status {
  live: boolean;
  transport: 'wss' | 'http';
  /** Active RPC endpoint (pool.describe()) and whether it rotated during the session. */
  rpc: string;
  rpcChanged: boolean;
  /** ONE counter for the whole process, shared across every position. */
  nonce: number;
  inFlight: boolean;
  lastMsg: string;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const usd = (v: number) => (Number.isFinite(v) ? `$${v.toFixed(2)}` : 'n/a');
const fmtTok = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 4 });
const fmt2 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What the last render showed for ONE position; fields that differ on the next render are printed bold. */
export interface Snapshot {
  balance: bigint;
  /** balance × spot, so a spot move bolds the value too */
  value: string;
  spot: string;
  depth: string;
  nonce: number;
  total?: string;
  realised?: string;
  rpc: string;
}

export function snapshot(bag: Bag, st: Status): Snapshot {
  const tokens = toNumber(bag.balance, bag.tokenDecimals);
  const realisedUsdc = bag.sells.reduce((a, s) => a + s.usdcOut, 0);
  const pnl = bag.costUsdc !== undefined && bag.entryTokens !== undefined ? computePnl({ costUsdc: bag.costUsdc, entryTokens: bag.entryTokens, realisedUsdc, balanceTokens: tokens, spotUsd: bag.spotUsd }) : undefined;
  return { balance: bag.balance, value: (tokens * bag.spotUsd).toFixed(6), spot: bag.spotUsd.toPrecision(6), depth: bag.usdcDepth.toFixed(2), nonce: st.nonce, total: pnl?.total.toFixed(6), realised: pnl?.realised.toFixed(6), rpc: st.rpc };
}

/** Tier state as one symbol: ● signed at the current nonce · … stale (re-sign pending) · ○ unsigned (dry run) · ✕ refused. */
export function tierSymbol(t: TierPlan, nonce: number, live: boolean): string {
  if (t.refused) return '✕';
  if (!t.signed) return live ? '…' : '○';
  return t.nonce === nonce ? '●' : '…';
}

export const TIER_LEGEND = '● signed at current nonce   … stale, re-sign pending   ○ unsigned (dry run)   ✕ refused';
export const BPS_NOTE = 'bps = paper.ts round-trip model (2×fee + size/(2×depth)), informational; minOut from slippageBps is the only on-chain guard';

// ── position selection (pure; keeps a mis-selected position from ever firing) ────────

/** TAB / `[` `]`: cycle the selected position. dir 1 = forward (TAB, `]`), -1 = back (`[`). */
export function cycleBag(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return current;
  return (current + dir + count) % count;
}

/** a/s/d…: jump straight to the position owning this key, else undefined (not a jump key). */
export function jumpToBag(bags: { jumpKey: string }[], key: string): number | undefined {
  const i = bags.findIndex((b) => b.jumpKey === key);
  return i >= 0 ? i : undefined;
}

export type FireResolution = { ok: true; bagIndex: number; bag: Bag; tier: TierPlan } | { ok: false; error: string };

/**
 * Pure: resolve what a number-key press targets, from an EXPLICIT selected
 * index (never a mutable outer reference) — so a caller can prove a rapid
 * jump→fire→jump→fire sequence never lets one position's keypress act on another.
 */
export function resolveFireTarget(bags: Bag[], selected: number, key: string): FireResolution {
  const bag = bags[selected];
  if (!bag) return { ok: false, error: 'no position selected' };
  const tier = bag.tiers.find((t) => t.key === key);
  if (!tier) return { ok: false, error: `not a configured hotkey for the selected position [${bag.symbol}]` };
  return { ok: true, bagIndex: selected, bag, tier };
}

export interface BagBasis {
  token: Address;
  balance: bigint;
}

/**
 * Pure: after firing `amountIn` of `firedToken`, the re-sign balance basis
 * for every position — the fired position PROJECTED (balance − amountIn), every other
 * position UNCHANGED (same value, not recomputed from anything).
 */
export function projectAfterFire<B extends BagBasis>(bags: B[], firedToken: Address, amountIn: bigint): B[] {
  const lc = firedToken.toLowerCase();
  return bags.map((b) => (b.token.toLowerCase() === lc ? { ...b, balance: b.balance - amountIn } : b));
}

// ── portfolio header ────────────────────────────────────────────────────

export interface PortfolioRow {
  symbol: string;
  balance: number;
  markUsd: number;
  pctOfDepth: number;
  /** Modelled net proceeds of selling the WHOLE position in one order (fee + impact). Mark is what it looks like; this is what you'd get. */
  exitUsd: number;
}

function exitEstimateUsd(bag: Bag): number {
  const tokens = toNumber(bag.balance, bag.tokenDecimals);
  const valueUsd = tokens * bag.spotUsd;
  if (!(bag.usdcDepth > 0) || !(valueUsd > 0)) return valueUsd;
  const predicted = impactBps({ feePpm: bag.fee, sizeUsd: valueUsd, depthUsd: bag.usdcDepth });
  return valueUsd * (1 - predicted.roundTripBps / 10_000);
}

export function portfolioRow(bag: Bag): PortfolioRow {
  const tokens = toNumber(bag.balance, bag.tokenDecimals);
  const markUsd = tokens * bag.spotUsd;
  return { symbol: bag.symbol, balance: tokens, markUsd, pctOfDepth: bag.usdcDepth > 0 ? (markUsd / bag.usdcDepth) * 100 : 0, exitUsd: exitEstimateUsd(bag) };
}

/**
 * Always-visible portfolio: USDC cash, one line per position (mark, ▲▼ since the
 * previous refresh, % of pool depth, modelled exit proceeds), then TOTAL.
 * The selected position is marked ▶ and bold — unmistakably, since a mis-selected
 * position firing 100% is the worst outcome available here.
 */
export function renderPortfolio(usdcCash: number, bags: Bag[], selected: number, prevMarks?: Map<Address, number>): string {
  const rows = bags.map(portfolioRow);
  const total = usdcCash + rows.reduce((a, r) => a + r.markUsd, 0);
  const lines: string[] = [];
  lines.push(`  ${pad('USDC', 6)} ${lpad(fmt2(usdcCash), 16)}                                    ${C.dim('cash')}`);
  bags.forEach((b, i) => {
    const r = rows[i]!;
    const prevMark = prevMarks?.get(b.token);
    const arrow = prevMark === undefined || Math.abs(r.markUsd - prevMark) < 0.005 ? C.dim('·') : r.markUsd > prevMark ? C.green('▲') : C.red('▼');
    const body = `${pad(`[${b.jumpKey}] ${b.symbol}`, 11)} ${lpad(fmt2(r.balance), 16)}   ${lpad(usd(r.markUsd), 10)}  ${arrow}  ${lpad(r.pctOfDepth.toFixed(1), 5)}% of depth   exit ≈ ${usd(r.exitUsd)}`;
    lines.push(i === selected ? C.bold(`▶ ${body}  ARMED`) : `  ${body}`);
  });
  lines.push(`  ${pad('TOTAL', 11)} ${' '.repeat(17)}${lpad(usd(total), 10)}`);
  return lines.join('\n');
}

// ── selected-position detail (position + PnL + tier table) ──────────────────

/**
 * Pure renderer for ONE position (tested against mocked positions). Hierarchy:
 * position + PnL first, tier table second; the event log is written by the
 * loop between renders. Colour: green/red for the PnL sign only, dim for
 * informational, bold for what changed since `prev`. Never clears the screen.
 */
export function renderBagDetail(bag: Bag, st: Status, prev?: Snapshot): string {
  const now = snapshot(bag, st);
  const chg = (k: keyof Snapshot, s: string) => (prev && prev[k] !== now[k] ? C.bold(s) : s);
  const tokens = toNumber(bag.balance, bag.tokenDecimals);
  const value = tokens * bag.spotUsd;
  const realisedUsdc = bag.sells.reduce((a, s) => a + s.usdcOut, 0);
  const pnl = bag.costUsdc !== undefined && bag.entryTokens !== undefined ? computePnl({ costUsdc: bag.costUsdc, entryTokens: bag.entryTokens, realisedUsdc, balanceTokens: tokens, spotUsd: bag.spotUsd }) : undefined;
  const signed = (v: number, digits = 6) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(digits)}`;
  const lines: string[] = [];

  // ── header ──
  const rpcTag = `${st.transport} ${st.rpc}${st.rpcChanged ? ' (rotated)' : ''}`;
  lines.push(`${C.bold(`━━ ${bag.symbol}  ${st.live ? 'LIVE' : 'DRY RUN'}`)}  ${C.dim('·')} nonce ${chg('nonce', String(st.nonce))}  ${C.dim('·')} ${st.rpcChanged ? chg('rpc', rpcTag) : C.dim(rpcTag)}  ${C.dim(`· ${new Date(bag.updatedMs).toISOString().slice(11, 19)}`)}`);
  lines.push('');

  // ── position + PnL (first, large) ──
  lines.push(`  ${C.bold('position')}   ${chg('balance', `${fmtTok(tokens)} ${bag.symbol}`)}   ≈ ${chg('value', `${value.toFixed(6)} USDC`)}   ${C.dim('spot')} ${chg('spot', bag.spotUsd.toPrecision(6))}   ${C.dim('depth')} ${chg('depth', usd(bag.usdcDepth))}`);
  if (pnl === undefined) {
    lines.push(`  ${C.dim('PnL        n/a (pass --cost-usdc to track entry; tracked for trade.targetToken only)')}`);
  } else {
    const col = pnl.total >= 0 ? C.green : C.red;
    lines.push(`  ${C.dim('entry')}      ${C.dim(`${pnl.entryPx.toPrecision(6)}  ·  cost ${bag.costUsdc!.toFixed(6)}  ·  basis left ${pnl.remainingCost.toFixed(6)}  ·  ${bag.entryTokens!.toLocaleString('en-US', { maximumFractionDigits: 6 })} received`)}`);
    const unknown = bag.sells.length === 0 && pnl.soldTokens > 0 ? C.dim(' (sold before this session: proceeds unknown here, total understates)') : '';
    lines.push(`  ${C.dim('realised')}   ${chg('realised', signed(pnl.realised))}  ${C.dim(`· ${bag.sells.length} sell(s), ${fmtTok(pnl.soldTokens)} ${bag.symbol} sold`)}${unknown}   ${C.dim('unrealised')} ${signed(pnl.unrealised)}`);
    lines.push(`  ${C.bold('TOTAL')}      ${col(C.bold(`${signed(pnl.total)} USDC  (${pnl.totalPct >= 0 ? '+' : ''}${pnl.totalPct.toFixed(2)}%)`))}`);
  }
  lines.push('');

  // ── tiers (second) ──
  lines.push(`  ${C.dim(`tiers @ nonce ${st.nonce}`)}   ${C.dim(`${pad('key', 4)} ${lpad('pct', 4)}  ${lpad('tokens', 14)}  ${lpad('≈USDC', 10)}  ${lpad('minOut', 10)}  ${lpad('bps', 5)}  st`)}`);
  for (const t of bag.tiers) {
    const sym = tierSymbol(t, st.nonce, st.live);
    const row = `${pad(`[${t.key}]`, 4)} ${lpad(`${t.pct}%`, 4)}  ${lpad(fmtTok(toNumber(t.amountIn, bag.tokenDecimals)), 14)}  ${lpad(t.valueUsd.toFixed(4), 10)}  ${lpad(formatUnits(t.minOut, USDC_DECIMALS), 10)}  ${lpad(String(t.predicted.roundTripBps), 5)}  ${sym}`;
    lines.push(`                    ${t.refused ? C.dim(`${row} ${t.refused}`) : row}`);
  }
  if (bag.sells.length) {
    lines.push('');
    lines.push(`  ${C.dim('sold')}`);
    for (const s of bag.sells) lines.push(`    ${C.dim(`${s.pct}% → ${s.usdcOut.toFixed(6)} USDC  realised ${s.realisedBps ?? '?'} bps (predicted ${s.predictedBps})  ${s.tx.slice(0, 10)}…${s.tx.slice(-4)}`)}`);
  }
  if (st.inFlight) lines.push(`  ${C.bold('SELL IN FLIGHT')} ${C.dim('keys ignored')}`);
  else if (st.lastMsg) lines.push(`  ${C.dim(st.lastMsg)}`);
  return lines.join('\n');
}

/** Full screen: portfolio header (every position) + the selected position's detail. */
export function render(usdcCash: number, bags: Bag[], selected: number, st: Status, prevSnapshots?: Map<Address, Snapshot>, prevMarks?: Map<Address, number>): string {
  const portfolio = renderPortfolio(usdcCash, bags, selected, prevMarks);
  const bag = bags[selected];
  if (!bag) return `${portfolio}\n\n  ${C.dim('no position armed (every candidate token has a zero balance)')}`;
  return `${portfolio}\n\n${renderBagDetail(bag, st, prevSnapshots?.get(bag.token))}`;
}

// ── live loop ───────────────────────────────────────────────────────────

async function readBagState(ctx: Ctx, bag: Bag): Promise<Pick<Bag, 'balance' | 'usdcDepth' | 'spotUsd' | 'updatedMs'>> {
  const balance = await rpc(() => ctx.arcPub.readContract({ address: bag.token, abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] }));
  const depthRaw = await rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [bag.pool] }));
  const slot0 = await rpc(() => ctx.arcPub.readContract({ address: bag.pool, abi: POOL_ABI, functionName: 'slot0' }));
  const dec0 = bag.usdcSide === 0 ? USDC_DECIMALS : bag.tokenDecimals;
  const dec1 = bag.usdcSide === 1 ? USDC_DECIMALS : bag.tokenDecimals;
  const spotUsd = v3TokenPriceUsd(slot0[0], dec0, dec1, bag.usdcSide === 0) ?? 0;
  return { balance, usdcDepth: toNumber(depthRaw, USDC_DECIMALS), spotUsd, updatedMs: Date.now() };
}

/** trade.targetToken + every trade.tokens key + EXTRA_TOKENS, deduped, lowercased. */
function candidateTokens(cfg: Config): Address[] {
  const set = new Set<Address>();
  set.add(cfg.trade.targetToken.toLowerCase() as Address);
  for (const t of Object.keys(cfg.trade.tokens)) set.add(t as Address);
  for (const t of cfg.extraTokens) set.add(t);
  return [...set];
}

async function resolveBagPool(rd: ReturnType<typeof readHandle>, cfg: Config, token: Address): Promise<ResolvedPool> {
  const cachedPool = cfg.poolFor(token);
  const fastTier = cfg.expectedFeeTierFor(token);
  if (cachedPool) return resolveCachedPool(rd, cfg, token, cachedPool);
  if (fastTier !== undefined) return resolveSingleTier(rd, cfg, token, fastTier);
  return resolveDeepestPool(rd, cfg, token);
}

const iso = () => new Date().toISOString();
const now = () => performance.now();
const ms1 = (v: number) => `${v.toFixed(1)} ms`;

/**
 * Sign every non-refused tier of every position at the SAME nonce `n`. Mutates
 * `bags` in place (tiers replaced, freshly signed). Logs which POSITIONS were
 * re-signed (not just which tiers) when `verbose`.
 */
async function signAllBags(bags: Bag[], ctx: Ctx, cfg: Config, router: Address, gas: bigint, n: number, reason: string, verbose: boolean): Promise<void> {
  const t0 = now();
  const resignedBags: string[] = [];
  for (const bag of bags) {
    const previous = new Map(bag.tiers.map((t) => [t.key, t.nonce]));
    if (verbose) log(`  re-sign start (${reason}) [${bag.symbol}]: balance basis ${formatUnits(bag.balance, bag.tokenDecimals)} ${bag.symbol}, target nonce ${n}`);
    bag.tiers = planTiers(bag, { ...cfg.sell, hotkeys: bag.hotkeys }, bag.slippageBps);
    let signedAny = false;
    for (const t of bag.tiers) {
      if (t.refused) continue;
      const t1 = now();
      const { data } = swapCalldata({ router, tokenIn: bag.token, tokenOut: USDC_ARC, fee: bag.fee, recipient: ctx.account.address, amountIn: t.amountIn, minOut: t.minOut, deadlineSec: cfg.trade.deadlineSec });
      t.nonce = n;
      t.signed = await signTx(ctx, { to: router, data, nonce: n, gas });
      t.signedAtMs = now();
      signedAny = true;
      if (verbose) log(`    [${bag.symbol}][${t.key}] ${t.pct}% end +${ms1(t.signedAtMs - t1)}: nonce ${previous.get(t.key) ?? 'none'} -> ${n}, amountIn ${formatUnits(t.amountIn, bag.tokenDecimals)}, minOut ${formatUnits(t.minOut, 6)} USDC, hash ${t.signed.hash}`);
    }
    if (signedAny) resignedBags.push(bag.symbol);
  }
  if (verbose) log(`  re-sign complete (${reason}): ${resignedBags.length}/${bags.length} position(s) re-signed [${resignedBags.join(', ')}] at nonce ${n} in ${ms1(now() - t0)}`);
}

async function main(): Promise<void> {
  const b = boot('sell', process.argv.slice(2));
  const { cfg, ctx, notifier } = b;
  const router = getAddress(cfg.trade.router);
  const costUsdc = cfg.cli.costUsdc !== undefined ? Number(cfg.cli.costUsdc) : undefined;
  const entryTokensArg = cfg.cli.entryTokens !== undefined ? Number(cfg.cli.entryTokens) : undefined;
  const rd = readHandle(ctx);
  const targetTokenLc = cfg.trade.targetToken.toLowerCase();

  const [, nonce, candidates] = await Promise.all([
    preflight(ctx, { base: false, route: false, spend: { usdc6: 0n, ownTxs: 0, what: 'sell session' } }),
    cfg.live ? NonceTracker.init(ctx.arcPub, ctx.account.address) : Promise.resolve(NonceTracker.fixed(0, ctx.account.address)),
    Promise.resolve(candidateTokens(cfg)),
  ]);

  // Balances first (cheap), so pool discovery only runs for tokens actually held.
  const balances = await Promise.all(candidates.map((t) => rpc(() => ctx.arcPub.readContract({ address: getAddress(t), abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] }))));
  const held = candidates.map((token, i) => ({ token, balance: balances[i]! })).filter((h) => h.balance > 0n);
  if (!held.length) die(`no non-zero balance for any candidate token (trade.targetToken, trade.tokens, EXTRA_TOKENS): ${candidates.join(', ')}. Nothing to arm.`);
  log(`${held.length}/${candidates.length} candidate token(s) held: ${held.map((h) => h.token).join(', ')}`);

  const resolved = await Promise.all(held.map((h) => resolveBagPool(rd, cfg, h.token)));
  let jumpIdx = 0;
  const bags: Bag[] = resolved.map((rp, i) => {
    const h = held[i]!;
    const isTarget = h.token === targetTokenLc;
    return {
      symbol: rp.symbol,
      token: rp.token,
      tokenDecimals: rp.tokenDecimals,
      pool: rp.chosen.pool,
      fee: rp.chosen.fee,
      usdcSide: rp.chosen.usdcSide!,
      balance: h.balance,
      usdcDepth: rp.chosen.usdcDepth ?? 0,
      spotUsd: rp.chosen.spotUsd ?? 0,
      costUsdc: isTarget ? costUsdc : undefined,
      entryTokens: isTarget ? (entryTokensArg ?? toNumber(h.balance, rp.tokenDecimals)) : undefined,
      updatedMs: Date.now(),
      jumpKey: JUMP_KEYS[jumpIdx++] ?? '?',
      slippageBps: cfg.slippageBpsFor(h.token),
      hotkeys: cfg.hotkeysFor(h.token),
      tiers: [],
      sells: [],
    };
  });
  const targetBag = bags.find((bg) => bg.token === targetTokenLc);
  if (costUsdc !== undefined && targetBag) {
    log(`entry anchor [${targetBag.symbol}]: ${costUsdc} USDC / ${targetBag.entryTokens} ${targetBag.symbol} received (${entryTokensArg !== undefined ? '--entry-tokens' : 'balance at start; pass --entry-tokens after a restart mid-position'}) = ${(costUsdc / (targetBag.entryTokens || 1)).toPrecision(6)} USDC/${targetBag.symbol}, fixed for this session`);
  } else if (costUsdc !== undefined) {
    log(C.dim('--cost-usdc given but trade.targetToken has no balance this session; PnL will show n/a for every position'));
  }
  for (const bag of bags) log(`position [${bag.jumpKey}] ${bag.symbol}: ${formatUnits(bag.balance, bag.tokenDecimals)} @ pool ${bag.pool} fee ${bag.fee}`);

  // One approval per position that needs it, before any hotkey is armed. Sequential: one nonce counter.
  const gas = BigInt(cfg.gas.reserveGasPerTx);
  if (cfg.live) {
    for (const bag of bags) {
      const allowance = await rpc(() => ctx.arcPub.readContract({ address: bag.token, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, router] }));
      if (allowance < bag.balance) {
        log(C.bold(`EXIT PATH CONTAINS AN APPROVE [${bag.symbol}]: allowance ${formatUnits(allowance, bag.tokenDecimals)} < balance. buy.ts with trade.approveOnFill pre-approves; this run pays for it now.`));
        const n = nonce.next();
        const approveData = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [router, bag.balance * 2n] });
        const approveGas = ((await rpc(() => ctx.arcPub.estimateGas({ account: ctx.account, to: bag.token, data: approveData }))) * 130n) / 100n;
        log(`approving ${bag.symbol} -> router (nonce ${n}, gas ${approveGas})...`);
        const tx = (await broadcast(ctx, await signTx(ctx, { to: bag.token, data: approveData, nonce: n, gas: approveGas }), `approve [${bag.symbol}]`)).hash;
        const r = await waitReceipt(ctx.arcPub, tx, cfg.timing.receiptTimeoutSec * 1000);
        if (r.status !== 'success') die(`approve [${bag.symbol}] ${r.status}: ${tx}`);
        log(`approve mined: ${tx} gasUsed ${r.receipt.gasUsed}`);
        const ok = await pollState(() => rpc(() => ctx.arcPub.readContract({ address: bag.token, abi: ERC20, functionName: 'allowance', args: [ctx.account.address, router] })), (v) => v >= bag.balance, { intervalMs: 500, maxMs: 20_000 });
        if (ok === undefined || ok < bag.balance) die(`allowance not readable after approve [${bag.symbol}]`);
        log(`allowance confirmed readable [${bag.symbol}]`);
      } else {
        log(`router allowance ${formatUnits(allowance, bag.tokenDecimals)} covers [${bag.symbol}]: no approve on the exit path`);
      }
    }
  }
  log(`sell gas limit ${gas} (gas.reserveGasPerTx; measured sell swap 113,545)`);

  const st: Status = { live: cfg.live, transport: ctx.arcWs ? 'wss' : 'http', rpc: ctx.pool.describe(), rpcChanged: ctx.pool.changed, nonce: nonce.peek(), inFlight: false, lastMsg: '' };
  let usdcCash = toNumber(await rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] })), USDC_DECIMALS);
  let selectedIndex = 0;
  let sending = false;
  let resigning = false;
  let lastFire: { key: string; symbol: string; atMs: number; nonce: number } | undefined;
  /** nonce -> block, for every fired sell whose receipt landed (ordering audit, global — nonces are global). */
  const minedAt = new Map<number, bigint>();
  let gen = 0;

  let prevSnapshots = new Map<Address, Snapshot>();
  let prevMarks = new Map<Address, number>();
  const dashboard = () => {
    st.rpc = ctx.pool.describe();
    st.rpcChanged = ctx.pool.changed;
    console.log(`\n${render(usdcCash, bags, selectedIndex, st, prevSnapshots, prevMarks)}\n`);
    prevSnapshots = new Map(bags.map((bg) => [bg.token, snapshot(bg, st)]));
    prevMarks = new Map(bags.map((bg) => [bg.token, portfolioRow(bg).markUsd]));
  };

  let refreshing = false;
  let lastStatusKey = '';
  async function refresh(): Promise<void> {
    if (refreshing || sending || resigning) return;
    refreshing = true;
    const myGen = gen;
    try {
      const [freshStates, freshCash] = await Promise.all([
        Promise.all(bags.map((bg) => readBagState(ctx, bg))),
        rpc(() => ctx.arcPub.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [ctx.account.address] })),
      ]);
      if (gen !== myGen || sending || resigning) {
        log(C.dim(`refresh discarded: a fire happened during the reads (gen ${myGen} -> ${gen})`));
        return;
      }
      for (let i = 0; i < bags.length; i += 1) Object.assign(bags[i]!, freshStates[i]!);
      usdcCash = toNumber(freshCash, USDC_DECIMALS);
      await signAllBags(bags, ctx, cfg, router, gas, nonce.peek(), 'refresh', false);
      const key = bags.map((bg) => `${bg.balance}|${bg.spotUsd.toPrecision(4)}|${bg.usdcDepth.toFixed(0)}`).join(';') + `|${nonce.peek()}`;
      if (key !== lastStatusKey) {
        lastStatusKey = key;
        log(C.dim(`refresh: ${bags.length} position(s), cash ${usdcCash.toFixed(2)} USDC, tiers re-signed at nonce ${nonce.peek()}`));
      }
    } catch (e) {
      log(C.bold(`refresh failed: ${(e as Error).message.split('\n')[0]!.slice(0, 100)}`));
    } finally {
      refreshing = false;
    }
  }

  function reject(key: string, why: string): void {
    log(`${C.bold(`REJECTED [${key}]`)} ${C.dim(why)}`);
  }

  async function fire(key: string, tKey: number): Promise<void> {
    log(`${C.bold(`KEYPRESS [${key}]`)} ${C.dim(`t_keypress=${iso()}`)}`);
    // Snapshot the target position from the CURRENT selection right now, synchronously — never re-read after an await.
    const target = resolveFireTarget(bags, selectedIndex, key);
    if (!target.ok) {
      reject(key, target.error);
      return;
    }
    const { bagIndex, bag, tier: t } = target;
    if (sending) {
      reject(key, `single-flight: broadcast of tier [${lastFire?.key}] (${lastFire?.symbol}, nonce ${lastFire?.nonce}) still in progress, ${ms1(tKey - (lastFire?.atMs ?? tKey))} after its keypress`);
      return;
    }
    if (lastFire && lastFire.key === key && lastFire.symbol === bag.symbol && tKey - lastFire.atMs < DOUBLE_TAP_MS) {
      reject(key, `double-tap: same key on [${bag.symbol}] ${ms1(tKey - lastFire.atMs)} after it fired at nonce ${lastFire.nonce} (window ${DOUBLE_TAP_MS} ms)`);
      return;
    }
    if (resigning) {
      reject(key, `re-signing after nonce ${lastFire?.nonce} is still in progress; press again in a moment`);
      return;
    }
    if (t.refused) {
      reject(key, `[${bag.symbol}] tier refused: ${t.refused}`);
      return;
    }
    if (!t.signed || t.nonce !== nonce.peek()) {
      reject(key, `[${bag.symbol}] stale signature (signed at nonce ${t.nonce ?? 'none'}, counter ${nonce.peek()})`);
      return;
    }
    if (!cfg.live) {
      log(C.dim(`dry run: would broadcast [${bag.symbol}] tier [${key}] (${t.pct}%, ${formatUnits(t.amountIn, bag.tokenDecimals)} ${bag.symbol}, minOut ${formatUnits(t.minOut, 6)} USDC, nonce ${t.nonce}, signed ${ms1(tKey - (t.signedAtMs ?? tKey))} before the keypress)`));
      return;
    }

    // ── broadcast ──
    sending = true;
    st.inFlight = true;
    gen += 1;
    const n = nonce.next(); // the counter moves exactly once per broadcast, across the whole portfolio
    lastFire = { key, symbol: bag.symbol, atMs: tKey, nonce: n };
    const signed = t.signed;
    const spotBefore = bag.spotUsd;
    log(`${C.bold(`FIRE [${bag.symbol}][${key}]`)} ${t.pct}% nonce ${n}: amountIn ${formatUnits(t.amountIn, bag.tokenDecimals)} ${bag.symbol}, minOut ${formatUnits(t.minOut, 6)} USDC, pre-signed ${ms1(tKey - (t.signedAtMs ?? tKey))} before the keypress`);
    const tSend = now();
    log(`  t_broadcast=${iso()} keypress→broadcast ${C.bold(ms1(tSend - tKey))}`);
    let hash: Hex;
    let attempts = 1;
    try {
      ({ hash, attempts } = await broadcast(ctx, signed, `sell [${bag.symbol}] tier [${key}]`));
    } catch (e) {
      sending = false;
      st.inFlight = false;
      die(`broadcast of nonce ${n} rejected: ${(e as Error).message.split('\n')[0]!.slice(0, 160)}. Nonce counter unknown: restart before signing again.`);
    }
    const tAck = now();
    sending = false;
    log(`  broadcast ack ${hash}: rpc ${ms1(tAck - tSend)}, keypress→ack ${ms1(tAck - tKey)}${attempts > 1 ? ` (accepted on attempt ${attempts})` : ''}`);

    // ── invalidate EVERY position's tiers + re-sign all of them at nonce+1: fired position projected, others unchanged ──
    resigning = true;
    const invalidated = bags.flatMap((x) => x.tiers.filter((y) => y.signed).map((y) => `${x.symbol}:${y.key}`));
    const projected = projectAfterFire(bags, bag.token, t.amountIn);
    log(
      `  nonce ${n} consumed: invalidated pre-signed tiers across ${bags.length} position(s) [${invalidated.join(',')}] (all signed at nonce ${n}); re-signing at nonce ${nonce.peek()} — [${bag.symbol}] projected balance ${formatUnits(projected[bagIndex]!.balance, bag.tokenDecimals)} (${formatUnits(bag.balance, bag.tokenDecimals)} − ${formatUnits(t.amountIn, bag.tokenDecimals)}), other position(s) unchanged`,
    );
    for (let i = 0; i < bags.length; i += 1) bags[i] = { ...bags[i]!, balance: projected[i]!.balance, updatedMs: i === bagIndex ? Date.now() : bags[i]!.updatedMs };
    await signAllBags(bags, ctx, cfg, router, gas, nonce.peek(), `after fire [${bag.symbol}:${key}]`, true);
    resigning = false;
    st.inFlight = false;

    // ── receipt in the background ──
    void (async () => {
      const r = await waitReceipt(ctx.arcPub, hash, cfg.timing.receiptTimeoutSec * 1000);
      const tRcpt = now();
      if (r.status === 'no_receipt') die(`sell [${bag.symbol}] ${hash} (nonce ${n}) has no receipt after ${cfg.timing.receiptTimeoutSec}s (not mined; blocklist?). Nonce counter unknown: restart before signing again.`);
      if (r.status === 'reverted') {
        minedAt.set(n, r.receipt.blockNumber);
        log(C.bold(`  receipt: [${bag.symbol}] tier [${key}] nonce ${n} REVERTED in block ${r.receipt.blockNumber} (${ms1(tRcpt - tKey)} after keypress; likely minOut). Nonce consumed; counter continues at ${nonce.peek()}.`));
        void refresh();
        return;
      }
      const amounts = swapAmounts(r.receipt, bag.pool);
      const usdcOutRaw = amounts ? -(bag.usdcSide === 0 ? amounts.amount0 : amounts.amount1) : 0n;
      const usdcOut = toNumber(usdcOutRaw, USDC_DECIMALS);
      const realisedBps = realisedLegBps({ usdc: usdcOut, tokens: toNumber(t.amountIn, bag.tokenDecimals), spotUsd: spotBefore, side: 'sell' });
      bags[bagIndex]!.sells.push({ pct: t.pct, usdcOut, realisedBps, predictedBps: t.predicted.roundTripBps, tx: hash });
      minedAt.set(n, r.receipt.blockNumber);
      log(C.dim(`  receipt: [${bag.symbol}] tier [${key}] nonce ${n} SUCCESS block ${r.receipt.blockNumber}, keypress→receipt ${ms1(tRcpt - tKey)}, gasUsed ${r.receipt.gasUsed}: sold ${t.pct}% for ${usdcOut.toFixed(6)} USDC, realised leg ${realisedBps ?? '?'} bps vs predicted round-trip ${t.predicted.roundTripBps} bps`));
      const prevBlock = minedAt.get(n - 1);
      if (prevBlock !== undefined) log(`  ordering: nonce ${n} block ${r.receipt.blockNumber} vs nonce ${n - 1} block ${prevBlock} -> landed behind: ${r.receipt.blockNumber >= prevBlock ? 'YES' : 'NO (impossible: nonces are ordered)'}${r.receipt.blockNumber === prevBlock ? ' (same block)' : ''}`);
      else if (n > 0 && [...minedAt.keys()].length) log(`  ordering: nonce ${n} block ${r.receipt.blockNumber}; previous sell receipt not seen yet`);
      void notifier.emit(
        'trade.sell',
        embed({
          title: `trade.sell ${bag.symbol}`,
          color: COLORS.ok,
          elapsedMs: Math.round(tRcpt - tKey),
          fields: [
            { name: 'tier', value: `${t.pct}%`, inline: true },
            { name: 'in', value: `${formatUnits(t.amountIn, bag.tokenDecimals)} ${bag.symbol}`, inline: true },
            { name: 'out', value: `${usdcOut.toFixed(6)} USDC`, inline: true },
            { name: 'realised leg', value: `${realisedBps ?? '?'} bps`, inline: true },
            { name: 'predicted round-trip', value: `${t.predicted.roundTripBps} bps`, inline: true },
            { name: 'keypress→broadcast', value: ms1(tSend - tKey), inline: true },
            { name: 'tx', value: arcTx(hash) },
          ],
        }),
      );
      await refresh();
      dashboard();
    })();
  }

  await signAllBags(bags, ctx, cfg, router, gas, nonce.peek(), 'initial', true);
  st.nonce = nonce.peek();
  dashboard();
  log(C.dim(TIER_LEGEND));
  log(C.dim(BPS_NOTE));
  log(C.dim(`positions: ${bags.map((bg) => `[${bg.jumpKey}] ${bg.symbol}`).join('  ')}  ${C.dim('· TAB/[ ] cycles, letter jumps, digits sell % of the ARMED position')}`));
  log(C.bold(`armed ${elapsedMs()} ms after start`) + C.dim(` via ${ctx.pool.describe()}`));
  for (const rp of resolved) {
    const cachedPool = cfg.poolFor(rp.token);
    const fastTier = cfg.expectedFeeTierFor(rp.token);
    if (cachedPool || fastTier !== undefined) void auditTiers(rd, cfg, rp).catch((e) => log(C.dim(`background tier audit failed [${rp.symbol}]: ${(e as Error).message.split('\n')[0]}`)));
  }

  // Transport: WSS block subscription when available, HTTP polling otherwise. Both are throttled to statePollMs.
  let stop: () => void;
  if (ctx.arcWs) {
    let last = 0;
    stop = ctx.arcWs.watchBlockNumber({
      onBlockNumber: () => {
        if (Date.now() - last < cfg.timing.statePollMs) return;
        last = Date.now();
        void refresh();
      },
      onError: (e) => log(C.dim(`wss error: ${e.message.split('\n')[0]!.slice(0, 80)}`)),
    });
  } else {
    const timer = setInterval(() => void refresh(), cfg.timing.statePollMs);
    stop = () => clearInterval(timer);
  }

  if (!process.stdin.isTTY) {
    log(C.dim('stdin is not a TTY: rendered once without hotkeys'));
    stop();
    await notifier.flush();
    return;
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  log(C.dim(`hotkeys armed (${cfg.live ? 'LIVE' : 'dry run'}); TAB/[ ] cycles positions, a/s/d… jumps, digits sell, q to quit`));
  await new Promise<void>((resolve) => {
    process.stdin.on('data', (chunk: string) => {
      // A fast sequence can arrive as one chunk: every key is handled in order, each with its own timestamp.
      for (const k of chunk) {
        const tKey = now();
        if (k === 'q' || k === CTRL_C) {
          stop();
          resolve();
          return;
        }
        if (k === '\t' || k === ']') {
          selectedIndex = cycleBag(selectedIndex, bags.length, 1);
          dashboard();
          continue;
        }
        if (k === '[') {
          selectedIndex = cycleBag(selectedIndex, bags.length, -1);
          dashboard();
          continue;
        }
        const jump = jumpToBag(bags, k);
        if (jump !== undefined) {
          selectedIndex = jump;
          dashboard();
          continue;
        }
        // An abort (exit 2) is already exiting via die(); only a plain failure hands control back to quit cleanly.
        void fire(k, tKey).catch((e) => {
          if ((e as { exitCode?: number }).exitCode !== 2) {
            log(C.bold(`fire failed: ${(e as Error).message}`));
            resolve();
          }
        });
      }
    });
  });
  process.stdin.setRawMode(false);
  await notifier.flush();
  b.release();
  process.exit(0);
}

if (process.argv[1] && /sell\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    if ((e as { exitCode?: number }).exitCode === 2) return;
    console.error(`\n${C.bold('failed')} ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
