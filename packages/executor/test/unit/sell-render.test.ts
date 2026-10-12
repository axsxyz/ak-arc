import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  computePnl,
  cycleBag,
  jumpToBag,
  planTiers,
  projectAfterFire,
  render,
  renderBagDetail,
  renderPortfolio,
  resolveFireTarget,
  snapshot,
  tierSymbol,
  type Bag,
  type Position,
  type Status,
  type TierPlan,
} from '../../src/sell.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const BOLD = '\x1b[1m';

const sellCfg = { hotkeys: { '1': 10, '2': 25, '3': 50, '4': 75, '5': 100 }, perTierMaxImpactBps: null, confirmAbovePercent: 100, slippageBps: 300 };

const demoPos: Position = {
  symbol: 'DEMO',
  token: '0x5555555555555555555555555555555555555555' as Address,
  tokenDecimals: 18,
  pool: '0x6666666666666666666666666666666666666666' as Address,
  fee: 10000,
  usdcSide: 0,
  balance: 1_000_000n * 10n ** 18n, // 1,000,000 DEMO
  usdcDepth: 114_163.13,
  spotUsd: 0.0026,
  costUsdc: 2000,
  entryTokens: 1_000_000,
  updatedMs: Date.UTC(2026, 8, 15, 12, 0, 0),
};

function makeBag(pos: Position, jumpKey: string, o: Partial<Bag> = {}): Bag {
  return { ...pos, jumpKey, slippageBps: 300, hotkeys: sellCfg.hotkeys, tiers: [], sells: [], ...o };
}

const demo = (o: Partial<Bag> = {}) => makeBag(demoPos, 'a', { tiers: planTiers(demoPos, sellCfg, 300), ...o });

const st: Status = { live: false, transport: 'http', rpc: 'rpc.arc-scan.org', rpcChanged: false, nonce: 7, inFlight: false, lastMsg: '' };

describe('sell TUI position detail: renders a mocked position, position + PnL first', () => {
  const bag = demo();
  const raw = renderBagDetail(bag, st);
  const out = strip(raw);
  const lines = out.split('\n');
  it('header carries symbol, mode, nonce, transport + active RPC and the time', () => {
    expect(lines[0]).toContain('━━ DEMO  DRY RUN');
    expect(lines[0]).toContain('nonce 7');
    expect(lines[0]).toContain('http rpc.arc-scan.org');
    expect(lines[0]).toContain('12:00:00');
    expect(lines[0]).not.toContain('rotated');
  });
  it('position line, then entry / realised / unrealised / TOTAL, before the tier table', () => {
    expect(lines[2]).toContain('position   1,000,000 DEMO   ≈ 2600.000000 USDC   spot 0.00260000   depth $114163.13');
    expect(lines[3]).toContain('entry      0.00200000  ·  cost 2000.000000  ·  basis left 2000.000000  ·  1,000,000 received');
    expect(lines[4]).toContain('realised   +0.000000  · 0 sell(s), 0 DEMO sold   unrealised +2600.000000');
    expect(lines[5]).toContain('TOTAL      +600.000000 USDC  (+30.00%)');
    expect(out.indexOf('TOTAL')).toBeLessThan(out.indexOf('tiers @ nonce 7'));
  });
  it('tier rows are compact: key, pct, tokens, ≈USDC, minOut, bps, one-symbol state', () => {
    expect(bag.tiers.map((t) => t.key)).toEqual(['1', '2', '3', '4', '5']);
    expect(out).toMatch(/\[1\]\s+10%\s+100,000\s+260\.0000\s+252\.2\s+211\s+○/);
    expect(out).toMatch(/\[5\]\s+100%\s+1,000,000\s+2600\.0000\s+2522\s+314\s+○/);
    expect(out).not.toContain('signed n');
    expect(out).not.toContain('informational'); // shown once at arm time, not per render
    const full = bag.tiers[4]!;
    expect(full.minOut).toBe(2_522_000_000n); // $2600 × 0.97 in 6-dec
    expect(full.predicted.feeLegsBps).toBe(200);
  });
  it('colour is only on the PnL sign; no screen-clear sequence', () => {
    expect(raw).toContain('\x1b[32m'); // green TOTAL
    expect(raw).not.toContain('\x1b[31m');
    expect(raw).not.toContain('\x1b[2J');
    const loss = strip(renderBagDetail(demo({ spotUsd: 0.001 }), st));
    expect(loss).toContain('TOTAL      -1000.000000 USDC  (-50.00%)');
    expect(renderBagDetail(demo({ spotUsd: 0.001 }), st)).toContain('\x1b[31m');
  });
  it('bold marks what changed since the previous snapshot', () => {
    const prev = snapshot(bag, st);
    const same = renderBagDetail(bag, st, prev);
    expect(same).not.toContain(`${BOLD}0.00260000`);
    const moved = renderBagDetail(demo({ spotUsd: 0.0027 }), st, prev);
    expect(moved).toContain(`${BOLD}0.00270000`);
    expect(moved).toContain(`${BOLD}2700.000000 USDC`);
    const bumped = renderBagDetail(bag, { ...st, nonce: 8 }, prev);
    expect(bumped).toContain(`${BOLD}8${'\x1b[0m'}`);
  });
  it('rotated RPC is marked in the header', () => {
    const o = strip(renderBagDetail(bag, { ...st, rpc: 'b.example* (2/2)', rpcChanged: true }));
    expect(o.split('\n')[0]).toContain('http b.example* (2/2) (rotated)');
  });
  it('in-flight state hides the hotkey prompt; sold rows carry realised vs predicted', () => {
    expect(strip(renderBagDetail(bag, { ...st, inFlight: true }))).toContain('SELL IN FLIGHT');
    const o = strip(renderBagDetail(demo({ sells: [{ pct: 25, usdcOut: 640.5, realisedBps: 130, predictedBps: 228, tx: '0xabcdef0123456789' }] }), st));
    expect(o).toContain('25% → 640.500000 USDC  realised 130 bps (predicted 228)  0xabcdef01…6789');
  });
});

describe('tier symbols', () => {
  const t = (o: Partial<TierPlan>): TierPlan => ({ key: '1', pct: 10, amountIn: 1n, minOut: 1n, valueUsd: 1, predicted: { roundTripBps: 200, feeLegsBps: 200, sizeTermBps: 0 }, ...o });
  it('● current nonce, … stale or unsigned live, ○ unsigned dry, ✕ refused', () => {
    const s = { raw: '0x', hash: '0x', nonce: 7 } as unknown as TierPlan['signed'];
    expect(tierSymbol(t({ signed: s, nonce: 7 }), 7, true)).toBe('●');
    expect(tierSymbol(t({ signed: s, nonce: 6 }), 7, true)).toBe('…');
    expect(tierSymbol(t({}), 7, true)).toBe('…');
    expect(tierSymbol(t({}), 7, false)).toBe('○');
    expect(tierSymbol(t({ refused: 'nothing to sell' }), 7, true)).toBe('✕');
  });
});

describe('sell tiers: refusals', () => {
  it('zero balance refuses every tier', () => {
    for (const t of planTiers({ ...demoPos, balance: 0n }, sellCfg, 300)) expect(t.refused).toBe('nothing to sell');
  });
  it('perTierMaxImpactBps (when set) refuses only the breaching tiers', () => {
    const tiers = planTiers(demoPos, { ...sellCfg, perTierMaxImpactBps: 230 }, 300);
    // 10%: 211, 25%: 228 pass; 50%: 257, 75%: 285, 100%: 314 breach
    expect(tiers.filter((t) => t.refused).map((t) => t.pct)).toEqual([50, 75, 100]);
  });
  it('null perTierMaxImpactBps is informational: nothing refused', () => {
    expect(planTiers(demoPos, sellCfg, 300).every((t) => !t.refused)).toBe(true);
  });
});

describe('PnL: entry is anchored to the fill, never to the current balance (live sequence 2026-09-15)', () => {
  // cost 0.300 USDC for 114.540548 DEMO; sells received 0.029408 / 0.026467 / 0.238204 USDC; final balance 0.
  const cost = 0.3;
  const received = 114.540548;
  const entry = cost / received; // 0.00261916
  const sells = [0.029408, 0.026467, 0.238204];
  it('after two 10% sells at entry price the total is about -0.4%, not -19.8%', () => {
    const balance = received * 0.9 * 0.9; // 92.777844 left
    const p = computePnl({ costUsdc: cost, entryTokens: received, realisedUsdc: sells[0]! + sells[1]!, balanceTokens: balance, spotUsd: entry });
    expect(p.entryPx).toBeCloseTo(0.00261916, 8); // unchanged by the sells
    expect(p.realised).toBeCloseTo(0.055875, 6);
    expect(p.unrealised).toBeCloseTo(balance * entry, 6);
    expect(p.totalPct).toBeGreaterThan(-1);
    expect(p.totalPct).toBeLessThan(0);
    expect(p.remainingCost).toBeCloseTo(cost * 0.81, 6);
  });
  it('after the full exit the total is realised - cost: about -2%, never -100%', () => {
    const p = computePnl({ costUsdc: cost, entryTokens: received, realisedUsdc: sells.reduce((a, b) => a + b, 0), balanceTokens: 0, spotUsd: entry });
    expect(p.realised).toBeCloseTo(0.294079, 6);
    expect(p.unrealised).toBe(0);
    expect(p.total).toBeCloseTo(-0.005921, 6);
    expect(p.totalPct).toBeCloseTo(-1.97, 1);
    expect(p.totalPct).toBeGreaterThan(-3);
    expect(p.remainingCost).toBe(0);
    expect(p.entryPx).toBeCloseTo(entry, 10);
  });
  it('renders the full exit as realised vs cost', () => {
    const bag: Bag = makeBag({ ...demoPos, balance: 0n, costUsdc: cost, entryTokens: received, spotUsd: entry }, 'a', {
      sells: sells.map((usdcOut, i) => ({ pct: i < 2 ? 10 : 100, usdcOut, predictedBps: 200, tx: '0xabc' as `0x${string}` })),
    });
    const out = strip(renderBagDetail(bag, st, undefined));
    expect(out).toContain('realised   +0.294079  · 3 sell(s), 114.5405 DEMO sold');
    expect(out).toContain('TOTAL      -0.005921 USDC  (-1.97%)');
    expect(out).not.toContain('-100.00%');
  });
});

// ── multi-position: portfolio header, selection, dry-run of three positions ──────────

const archPos: Position = {
  symbol: 'ARCH',
  token: '0x1111111111111111111111111111111111111111' as Address,
  tokenDecimals: 18,
  pool: '0x2222222222222222222222222222222222222222' as Address,
  fee: 3000,
  usdcSide: 1,
  balance: 412_338n * 10n ** 18n + 200_000_000_000_000_000n, // 412,338.20 ARCH
  usdcDepth: 33_209.0,
  spotUsd: 0.006524, // mark ≈ 2690
  updatedMs: Date.UTC(2026, 8, 16, 9, 0, 0),
};

const zedPos: Position = {
  symbol: 'ZED',
  token: '0x3333333333333333333333333333333333333333' as Address,
  tokenDecimals: 6,
  pool: '0x4444444444444444444444444444444444444444' as Address,
  fee: 500,
  usdcSide: 0,
  balance: 900n * 10n ** 6n,
  usdcDepth: 5_000,
  spotUsd: 1.2,
  updatedMs: Date.UTC(2026, 8, 16, 9, 0, 0),
};

function threeBags(): Bag[] {
  return [demo(), makeBag(archPos, 's', { tiers: planTiers(archPos, sellCfg, 300) }), makeBag(zedPos, 'd', { tiers: planTiers(zedPos, sellCfg, 300) })];
}

describe('dry run: renders three positions against mocked state', () => {
  const bags = threeBags();
  const usdcCash = 25_874.57;
  const out = strip(render(usdcCash, bags, 0, st));

  it('portfolio header lists USDC cash, every position, and a TOTAL', () => {
    expect(out).toContain('USDC');
    expect(out).toContain('25,874.57');
    expect(out).toContain('cash');
    expect(out).toContain('DEMO');
    expect(out).toContain('ARCH');
    expect(out).toContain('ZED');
    expect(out).toContain('TOTAL');
  });
  it('shows mark, % of depth and a modelled exit estimate per position', () => {
    expect(out).toMatch(/DEMO[\s\S]*?\$2600\.00[\s\S]*?% of depth[\s\S]*?exit ≈ \$/);
    expect(out).toContain('% of depth');
    expect(out).toMatch(/exit ≈ \$\d/);
  });
  it('TOTAL sums cash + every position mark', () => {
    const total = usdcCash + 1_000_000 * 0.0026 + 412_338.2 * 0.006524 + 900 * 1.2;
    const m = out.match(/TOTAL\s+\$([\d.,]+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1]!.replace(/,/g, ''))).toBeCloseTo(total, 0);
  });
  it('the selected position detail (DEMO, index 0) follows the header', () => {
    expect(out.indexOf('━━ DEMO')).toBeGreaterThan(out.indexOf('TOTAL'));
  });
  it('selecting a different position renders that position as ARMED and its own detail', () => {
    const out2 = strip(render(usdcCash, bags, 1, st));
    expect(out2).toContain('━━ ARCH');
    expect(out2).not.toContain('━━ DEMO');
  });
});

describe('portfolio header: the armed position is marked unmistakably', () => {
  const bags = threeBags();
  it('exactly one position row is marked ARMED, matching the selected index', () => {
    const raw0 = renderPortfolio(1000, bags, 0);
    expect((raw0.match(/ARMED/g) ?? []).length).toBe(1);
    expect(raw0.split('\n').find((l) => l.includes('ARMED'))).toContain('DEMO');

    const raw1 = renderPortfolio(1000, bags, 1);
    expect(raw1.split('\n').find((l) => l.includes('ARMED'))).toContain('ARCH');
  });
  it('▲/▼ reflect the mark change since the previous refresh', () => {
    const prevMarks = new Map(bags.map((b) => [b.token, 0]));
    const out = strip(renderPortfolio(1000, bags, 0, prevMarks));
    expect(out).toContain('▲'); // every position's mark grew from the fabricated previous 0
  });
});

describe('position selection: TAB/[ ]/jump keys never leak the target across keypresses', () => {
  const bags = threeBags(); // a=DEMO, s=ARCH, d=ZED

  it('cycleBag advances/wraps independent of any external state', () => {
    expect(cycleBag(0, 3, 1)).toBe(1);
    expect(cycleBag(2, 3, 1)).toBe(0); // wraps forward
    expect(cycleBag(0, 3, -1)).toBe(2); // wraps backward
  });
  it('jumpToBag resolves the exact position for its letter, and only that position', () => {
    expect(jumpToBag(bags, 'a')).toBe(0);
    expect(jumpToBag(bags, 's')).toBe(1);
    expect(jumpToBag(bags, 'd')).toBe(2);
    expect(jumpToBag(bags, 'z')).toBeUndefined();
  });
  it('resolveFireTarget always targets the EXPLICIT selected index passed in, never a stale one', () => {
    const onCool = resolveFireTarget(bags, 0, '3');
    const onArch = resolveFireTarget(bags, 1, '3');
    const onZed = resolveFireTarget(bags, 2, '3');
    expect(onCool.ok && onCool.bag.symbol).toBe('DEMO');
    expect(onArch.ok && onArch.bag.symbol).toBe('ARCH');
    expect(onZed.ok && onZed.bag.symbol).toBe('ZED');
  });
  it('a jump→fire→jump→fire sequence resolves each fire against the position selected at THAT moment, never the previous one', () => {
    let selected = 0;
    selected = jumpToBag(bags, 's') ?? selected; // -> ARCH
    const first = resolveFireTarget(bags, selected, '2');
    selected = jumpToBag(bags, 'd') ?? selected; // -> ZED
    const second = resolveFireTarget(bags, selected, '1');
    expect(first.ok && first.bag.symbol).toBe('ARCH');
    expect(second.ok && second.bag.symbol).toBe('ZED');
    // The ARCH target captured before the jump to ZED must not have silently become ZED.
    expect(first.ok && first.bagIndex).toBe(1);
  });
  it('a number key with no matching tier on the selected position is rejected, not routed to another position', () => {
    const noTierBag = makeBag(zedPos, 'd', { tiers: [] });
    const r = resolveFireTarget([bags[0]!, bags[1]!, noTierBag], 2, '1');
    expect(r.ok).toBe(false);
  });
});

describe('multi-position re-sign after a partial fire: fired position projected, others unchanged', () => {
  const basis = [
    { token: '0xaaaa000000000000000000000000000000aaaa' as Address, balance: 1_000_000n },
    { token: '0xbbbb000000000000000000000000000000bbbb' as Address, balance: 500_000n },
    { token: '0xcccc000000000000000000000000000000cccc' as Address, balance: 42n },
  ];
  it('the fired position balance is projected down by exactly the fired amount', () => {
    const next = projectAfterFire(basis, basis[1]!.token, 200_000n);
    expect(next[1]!.balance).toBe(300_000n);
  });
  it('every OTHER position keeps its exact prior balance value, untouched', () => {
    const next = projectAfterFire(basis, basis[1]!.token, 200_000n);
    expect(next[0]!.balance).toBe(basis[0]!.balance);
    expect(next[2]!.balance).toBe(basis[2]!.balance);
  });
  it('is case-insensitive on the token address and pure (does not mutate the input)', () => {
    const upper = basis[0]!.token.toUpperCase() as Address;
    const next = projectAfterFire(basis, upper, 1n);
    expect(next[0]!.balance).toBe(999_999n);
    expect(basis[0]!.balance).toBe(1_000_000n); // original untouched
  });
  it('applied to real Position objects: planTiers on the projected/unchanged basis produces the expected tier sizes', () => {
    const bags = threeBags();
    const fired = bags[0]!; // DEMO, sell 25% (250,000 DEMO)
    const amountIn = (fired.balance * 25n) / 100n;
    const projected = projectAfterFire(bags, fired.token, amountIn);
    const newTiers = planTiers(projected[0]!, sellCfg, 300);
    expect(projected[0]!.balance).toBe(fired.balance - amountIn);
    expect(newTiers[4]!.amountIn).toBe(projected[0]!.balance); // 100% tier == new balance
    // ARCH and ZED bases are untouched, so their re-planned tiers are identical to before.
    expect(projected[1]!.balance).toBe(bags[1]!.balance);
    expect(projected[2]!.balance).toBe(bags[2]!.balance);
    expect(planTiers(projected[1]!, sellCfg, 300)).toEqual(planTiers(bags[1]!, sellCfg, 300));
    expect(planTiers(projected[2]!, sellCfg, 300)).toEqual(planTiers(bags[2]!, sellCfg, 300));
  });
});
