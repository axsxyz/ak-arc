/**
 * status — read-only situation board for executor.
 *
 *   npx tsx src/status.ts
 *
 * Signs nothing, sends nothing. Reads .env and config/executor.json the same
 * way the stages do, then reports what is actually true right now.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createPublicClient,
  decodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { toolEnv } from './config.js';
import { readNonceForDisplay } from './chain.js';

// ── config ──────────────────────────────────────────────────────────────

const cfg = JSON.parse(
  readFileSync(new URL('../config/executor.json', import.meta.url), 'utf8')
) as {
  route: { baseDomain: number; arcDomain: number; arcChainId: number };
  trade: {
    targetToken: string;
    router: string;
    factories: string[];
    feeTiers: number[];
    slippageBps: number;
    tokens: Record<string, { pool?: string; expectedFeeTier?: number }>;
  };
  gas: { reserveTxCount: number; reserveGasPerTx: number };
};

const ENV = toolEnv();
const ARC_RPCS = ENV.arcRpcs;
const BASE_RPCS = ENV.baseRpcs;
const IRIS = ENV.irisUrl;
const BURN_TX = ENV.pendingBurnTx as Hex | undefined;

const USDC_BASE = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const TOKEN_MESSENGER = getAddress('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
const USDC_ARC = getAddress('0x3600000000000000000000000000000000000000');
const TARGET = getAddress(cfg.trade.targetToken);
const ROUTER = getAddress(cfg.trade.router);
const POOL = cfg.trade.tokens[cfg.trade.targetToken.toLowerCase()]?.pool;

/** Every token to value in the portfolio view: config target + anything in trade.tokens + EXTRA_TOKENS. */
function portfolioTokens(): string[] {
  const set = new Set<string>();
  set.add(cfg.trade.targetToken.toLowerCase());
  for (const k of Object.keys(cfg.trade.tokens)) set.add(k.toLowerCase());
  for (const t of ENV.extraTokens) {
    const v = t.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(v)) set.add(v);
  }
  return [...set];
}
const ARC_DOMAIN = cfg.route.arcDomain;
const BASE_DOMAIN = cfg.route.baseDomain;

const ZERO32 = `0x${'0'.repeat(64)}`;

// ── abis ────────────────────────────────────────────────────────────────

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const TM = parseAbi([
  'function remoteTokenMessengers(uint32) view returns (bytes32)',
  'function localMinter() view returns (address)',
  'function localMessageTransmitter() view returns (address)',
  'function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
]);
const TRANSMITTER = parseAbi([
  'function localDomain() view returns (uint32)',
]);
const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function factory() view returns (address)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
]);
const FACTORY_ABI = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
]);

// ── helpers ─────────────────────────────────────────────────────────────

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const short = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 90);

/**
 * arc-scan throttles bursts with JSON-RPC -32603, and viem wraps that as a
 * ContractFunctionRevertedError with an EMPTY reason — indistinguishable at
 * a glance from a contract actually saying no. Retry anything that smells
 * like transport rather than reporting it as on-chain truth.
 */
function looksTransient(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('internal error') ||
    m.includes('could not complete') ||
    m.includes('timeout') ||
    m.includes('fetch failed') ||
    m.includes('request failed') ||
    // empty-reason revert: the tell-tale shape of a wrapped throttle
    (m.includes('reverted with the following reason') && m.trim().endsWith(':'))
  );
}

async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!looksTransient(e) && i > 0) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

const row = (label: string, value: string) =>
  console.log(`  ${label.padEnd(26)} ${value}`);

function account() {
  const raw = ENV.privateKey;
  const pk = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
  return privateKeyToAccount(pk as Hex);
}

function arcClient(url = ARC_RPCS[0]!) {
  return createPublicClient({ transport: http(url, { retryCount: 1 }) });
}
function baseClient(url = BASE_RPCS[0]!) {
  return createPublicClient({ chain: base, transport: http(url, { retryCount: 1 }) });
}

// ── 1. wallet & balances ────────────────────────────────────────────────

async function balances(): Promise<void> {
  const acct = account();
  if (!acct) {
    console.log(C.red('\n  PRIVATE_KEY missing or malformed\n'));
    return;
  }
  console.log(C.bold('\n── wallet ──\n'));
  row('address', acct.address);

  const b = baseClient();
  const a = arcClient();

  console.log(C.bold('\n── Base ──\n'));
  try {
    const [eth, usdc, allow, nonce] = await Promise.all([
      b.getBalance({ address: acct.address }),
      b.readContract({ address: USDC_BASE, abi: ERC20, functionName: 'balanceOf', args: [acct.address] }),
      b.readContract({ address: USDC_BASE, abi: ERC20, functionName: 'allowance', args: [acct.address, TOKEN_MESSENGER] }),
      readNonceForDisplay(b, acct.address),
    ]);
    row('ETH (gas)', `${Number(formatEther(eth)).toFixed(6)}`);
    row('USDC', formatUnits(usdc, 6));
    row(
      'allowance -> TokenMessenger',
      allow === 0n ? C.yellow('0 (approve needed at burn)') : formatUnits(allow, 6)
    );
    row('nonce', String(nonce));
    if (eth === 0n) console.log(C.red('\n  no ETH on Base: the burn cannot be signed'));
  } catch (e) {
    console.log(C.red(`  Base read failed: ${short(e)}`));
  }

  console.log(C.bold('\n── Arc ──\n'));
  try {
    const [nativeBal, usdcBal, gasPrice, nonce] = [
      await retry(() => a.getBalance({ address: acct.address }), 6),
      await retry(() => a.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [acct.address] }), 6),
      await retry(() => a.getGasPrice(), 6),
      await retry(() => readNonceForDisplay(a, acct.address), 6),
    ];
    row('gas balance (18-dec native)', `${formatUnits(nativeBal, 18)} USDC`);
    row('USDC (6-dec ERC-20)', formatUnits(usdcBal, 6));
    row('gas price', `${(Number(gasPrice) / 1e9).toFixed(2)} Gwei`);
    row('nonce', String(nonce));

    const reserve =
      BigInt(cfg.gas.reserveTxCount) * BigInt(cfg.gas.reserveGasPerTx) * gasPrice;
    const ok = nativeBal >= reserve;
    row(
      'exit gas reserve',
      `${ok ? C.green('OK') : C.red('BELOW FLOOR')} — need ${formatUnits(reserve, 18)}`
    );

    // target token balance
    try {
      const [bal, dec, sym] = await Promise.all([
        a.readContract({ address: TARGET, abi: ERC20, functionName: 'balanceOf', args: [acct.address] }),
        a.readContract({ address: TARGET, abi: ERC20, functionName: 'decimals' }),
        a.readContract({ address: TARGET, abi: ERC20, functionName: 'symbol' }),
      ]);
      row(`${sym} position`, formatUnits(bal, dec));
      const allow = await a.readContract({
        address: TARGET, abi: ERC20, functionName: 'allowance', args: [acct.address, ROUTER],
      });
      row(
        `${sym} -> router`,
        allow > 0n ? C.green('pre-approved (exit is fast)') : C.yellow('0 — exit pays an approve first')
      );
    } catch (e) {
      console.log(C.dim(`  target token read failed: ${short(e)}`));
    }
  } catch (e) {
    console.log(C.red(`  Arc read failed: ${short(e)}`));
  }
  console.log('');
}

// ── 2. corridor ─────────────────────────────────────────────────────────

async function corridor(): Promise<void> {
  console.log(C.bold('\n── corridor ──\n'));
  const b = baseClient();
  const a = arcClient();

  try {
    const remote = (await retry(() => b.readContract({
      address: TOKEN_MESSENGER, abi: TM, functionName: 'remoteTokenMessengers', args: [ARC_DOMAIN],
    }))) as Hex;
    row(
      `Base -> domain ${ARC_DOMAIN}`,
      remote === ZERO32 ? C.red('UNWIRED') : C.green('wired')
    );
  } catch (e) {
    row('Base -> domain', C.red(short(e)));
  }

  try {
    const remote = (await retry(() => a.readContract({ address: TOKEN_MESSENGER, abi: TM, functionName: 'remoteTokenMessengers', args: [BASE_DOMAIN] }), 6)) as Hex;
    await new Promise((r) => setTimeout(r, 250));
    const minter = (await retry(() => a.readContract({ address: TOKEN_MESSENGER, abi: TM, functionName: 'localMinter' }), 6)) as Address;
    row(`Arc -> domain ${BASE_DOMAIN}`, remote === ZERO32 ? C.red('UNWIRED') : C.green('wired'));
    row('Arc localMinter', minter);
  } catch (e) {
    row('Arc side', C.red(short(e)));
  }

  // Iris: fee quote + fast transfer allowance
  try {
    const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${BASE_DOMAIN}/${ARC_DOMAIN}`);
    const q = (await r.json()) as Array<{ finalityThreshold: number; minimumFee: number }>;
    const fast = q.find((x) => x.finalityThreshold === 1000);
    row(
      'Iris fee quote (fast)',
      fast ? `${fast.minimumFee} bps` : C.red('threshold 1000 not offered')
    );
  } catch (e) {
    row('Iris fee quote', C.red(short(e)));
  }
  try {
    const r = await fetch(`${IRIS}/v2/fastBurn/USDC/allowance`);
    const j = (await r.json()) as { allowance: number };
    row('fast transfer allowance', `${j.allowance.toLocaleString('en-US')} USDC`);
  } catch (e) {
    row('fast allowance', C.dim(short(e)));
  }
  console.log('');
}

// ── 3. pending burn ─────────────────────────────────────────────────────

async function pendingBurn(): Promise<void> {
  console.log(C.bold('\n── pending burn ──\n'));
  if (!BURN_TX) {
    console.log(
      C.dim('  set PENDING_BURN_TX in .env to track your queued burn here\n')
    );
    return;
  }
  row('burn tx', BURN_TX);

  // Decode mintRecipient from the burn itself and compare to the wallet.
  // If the key changed since the burn, the minted USDC lands elsewhere.
  const acct = account();
  try {
    const tx = await baseClient().getTransaction({ hash: BURN_TX });
    const { args } = decodeFunctionData({ abi: TM, data: tx.input });
    const recipient = getAddress(`0x${(args![2] as string).slice(26)}`);
    row('mintRecipient', recipient);
    row('burn amount', `${formatUnits(args![0] as bigint, 6)} USDC`);
    if (acct) {
      const same = recipient.toLowerCase() === acct.address.toLowerCase();
      row(
        'recipient == wallet',
        same
          ? C.green('YES')
          : C.red('NO — the mint will land on the OTHER address')
      );
    }
  } catch (e) {
    row('decode', C.dim(short(e)));
  }

  try {
    const r = await fetch(
      `${IRIS}/v2/messages/${BASE_DOMAIN}?transactionHash=${BURN_TX}`
    );
    if (!r.ok) {
      row('Iris', C.yellow(`HTTP ${r.status}`));
    } else {
      const j = (await r.json()) as {
        messages?: Array<{ status: string; delayReason?: string | null }>;
      };
      const m = j.messages?.[0];
      row(
        'attestation',
        m?.status === 'complete'
          ? C.green('COMPLETE — corridor is open, mint now')
          : C.yellow(m?.status ?? 'unknown')
      );
      if (m?.delayReason) row('delayReason', String(m.delayReason));
    }
  } catch (e) {
    row('Iris', C.red(short(e)));
  }
  console.log('');
}

// ── 4. pool + sizing ────────────────────────────────────────────────────

async function poolAndSizing(rl: ReturnType<typeof createInterface>): Promise<void> {
  console.log(C.bold('\n── pool ──\n'));
  if (!POOL) {
    console.log(C.yellow('  no cached pool configured for the target token\n'));
    return;
  }
  const a = arcClient();
  let depth = 0;
  try {
    const pool = getAddress(POOL);
    // Sequential, spaced out. Firing these in parallel trips arc-scan's
    // burst throttle, and the throttle comes back dressed as a revert.
    const gap = () => new Promise((r) => setTimeout(r, 250));
    const t0 = (await retry(() => a.readContract({ address: pool, abi: POOL_ABI, functionName: 'token0' }), 6)) as Address;
    await gap();
    const t1 = (await retry(() => a.readContract({ address: pool, abi: POOL_ABI, functionName: 'token1' }), 6)) as Address;
    await gap();
    const fee = (await retry(() => a.readContract({ address: pool, abi: POOL_ABI, functionName: 'fee' }), 6)) as number;
    await gap();
    const factory = (await retry(() => a.readContract({ address: pool, abi: POOL_ABI, functionName: 'factory' }), 6)) as Address;
    await gap();
    const liq = (await retry(() => a.readContract({ address: pool, abi: POOL_ABI, functionName: 'liquidity' }), 6)) as bigint;
    await gap();
    const usdcSide = t0.toLowerCase() === USDC_ARC.toLowerCase() ? t0 : t1;
    const usdcBal = await retry(() => a.readContract({
      address: usdcSide, abi: ERC20, functionName: 'balanceOf', args: [pool],
    }), 6);
    depth = Number(formatUnits(usdcBal, 6));

    const trusted = cfg.trade.factories.some(
      (f) => f.toLowerCase() === factory.toLowerCase()
    );
    row('pool', pool);
    row('factory', trusted ? C.green('allowlisted') : C.red(`UNTRUSTED ${factory}`));
    row('fee tier', `${fee} (${fee / 10000}%)`);
    row('USDC depth', C.bold(`$${depth.toLocaleString('en-US', { maximumFractionDigits: 0 })}`));
    row('liquidity', String(liq));
  } catch (e) {
    console.log(C.red(`  pool read failed: ${short(e)}`));
    return;
  }

  const raw = await rl.question('\n  size in USDC to model (blank to skip): ');
  const size = Number(raw.trim());
  if (!Number.isFinite(size) || size <= 0) {
    console.log('');
    return;
  }
  const feeBps = 200; // 2 x 1% tier, both legs
  const impactBps = (size / (2 * depth)) * 10000;
  const pctOfPool = (size / depth) * 100;
  console.log('');
  row('% of pool depth', `${pctOfPool.toFixed(2)}%`);
  row('round-trip fee', `${feeBps} bps  ($${((size * feeBps) / 10000).toFixed(2)})`);
  row('modelled impact', `${impactBps.toFixed(0)} bps  ($${((size * impactBps) / 10000).toFixed(2)})`);
  row(
    C.bold('total round-trip'),
    C.bold(`${(feeBps + impactBps).toFixed(0)} bps  ($${((size * (feeBps + impactBps)) / 10000).toFixed(2)})`)
  );
  console.log(
    C.dim(
      '\n  Linear model (paper.ts). Real V3 cost is convex and runs higher\n' +
        '  above ~5% of depth. Treat this as a floor, not an estimate.\n'
    )
  );
}

// ── 5. rpc health ───────────────────────────────────────────────────────

async function rpcHealth(): Promise<void> {
  console.log(C.bold('\n── rpc health ──\n'));
  const probe = async (url: string, expect: number, label: string) => {
    const t = Date.now();
    try {
      const c = createPublicClient({ transport: http(url, { retryCount: 0 }) });
      const id = await c.getChainId();
      const ms = Date.now() - t;
      const okId = id === expect;
      console.log(
        `  ${label.padEnd(8)} ${okId ? C.green(`${ms} ms`) : C.red(`chainId ${id} != ${expect}`)}  ${C.dim(new URL(url).host)}`
      );
    } catch (e) {
      console.log(`  ${label.padEnd(8)} ${C.red('FAIL')}  ${C.dim(new URL(url).host)}  ${C.dim(short(e))}`);
    }
  };

  for (const u of BASE_RPCS) await probe(u, 8453, 'base');
  for (const u of ARC_RPCS) await probe(u, cfg.route.arcChainId, 'arc');

  if (ARC_RPCS.length === 1) {
    console.log(
      C.yellow('\n  single Arc endpoint: failover has nowhere to go if it degrades')
    );
  }
  console.log('');
}

// ── 7. domain truth ───────────────────────────────────────────────

const DOMAIN_SNAPSHOT = new URL('../data/domains.json', import.meta.url);
const SCAN_MAX = 64;

/**
 * Two independent answers to "is Arc mainnet really domain 26?":
 *
 *  1. Arc's own MessageTransmitter exposes localDomain() — the domain the
 *     chain assigns itself. This is authoritative and settles it outright.
 *  2. Scanning remoteTokenMessengers(d) on Base for every d shows which
 *     corridors mainnet knows about. Diffing against a stored snapshot
 *     surfaces any NEW domain the moment Circle wires one.
 */
async function domainTruth(): Promise<void> {
  console.log(C.bold('\n── domain truth ──\n'));
  const a = arcClient();
  const b = baseClient();

  // 1. authoritative: what does Arc call itself?
  try {
    const transmitter = (await retry(() =>
      a.readContract({ address: TOKEN_MESSENGER, abi: TM, functionName: 'localMessageTransmitter' })
    )) as Address;
    const localDomain = (await retry(() =>
      a.readContract({ address: transmitter, abi: TRANSMITTER, functionName: 'localDomain' })
    )) as number;
    const matches = Number(localDomain) === ARC_DOMAIN;
    row('Arc MessageTransmitter', transmitter);
    row(
      'Arc localDomain()',
      matches
        ? C.green(`${localDomain} — matches config, domain ${ARC_DOMAIN} is correct`)
        : C.red(`${localDomain} — CONFIG SAYS ${ARC_DOMAIN}. Arc mainnet is domain ${localDomain}.`)
    );
    if (!matches) {
      console.log(
        C.red(
          `\n  Update route.arcDomain to ${localDomain} in config/executor.json.\n` +
            '  Any burn already sent to the old domain is not mintable here.\n'
        )
      );
    }
  } catch (e) {
    row('Arc localDomain()', C.red(short(e)));
  }

  // 2. corridor table on Base, diffed against the last snapshot
  console.log(C.dim(`\n  scanning domains 0-${SCAN_MAX} on Base...`));
  const wired: number[] = [];
  for (let d = 0; d <= SCAN_MAX; d += 1) {
    try {
      const v = (await retry(
        () =>
          b.readContract({
            address: TOKEN_MESSENGER, abi: TM, functionName: 'remoteTokenMessengers', args: [d],
          }),
        2
      )) as Hex;
      if (v !== ZERO32) wired.push(d);
    } catch {
      // a read that will not resolve is not evidence of an unwired domain
    }
    await new Promise((r) => setTimeout(r, 60));
  }

  row('wired domains', wired.join(', ') || C.red('none — the scan failed'));

  let previous: number[] = [];
  try {
    previous = JSON.parse(readFileSync(DOMAIN_SNAPSHOT, 'utf8')).wired as number[];
  } catch {
    // first run
  }
  if (previous.length > 0) {
    const added = wired.filter((d) => !previous.includes(d));
    const removed = previous.filter((d) => !wired.includes(d));
    if (added.length === 0 && removed.length === 0) {
      row('vs last snapshot', C.dim('unchanged'));
    } else {
      if (added.length > 0) {
        row('NEW domains', C.green(C.bold(added.join(', '))));
        console.log(
          C.yellow(
            '\n  A newly wired domain means Circle opened a corridor. If Arc\n' +
              '  moved, this is the number to use — confirm with localDomain()\n' +
              '  above before burning anything toward it.\n'
          )
        );
      }
      if (removed.length > 0) row('removed domains', C.red(removed.join(', ')));
    }
  } else {
    row('vs last snapshot', C.dim('no baseline yet — saving one now'));
  }

  try {
    mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
    writeFileSync(
      DOMAIN_SNAPSHOT,
      JSON.stringify({ wired, at: new Date().toISOString() }, null, 2)
    );
  } catch (e) {
    console.log(C.dim(`  snapshot not saved: ${short(e)}`));
  }
  console.log('');
}

// ── 8. portfolio ────────────────────────────────────────────────

/**
 * Spot price from the pool's reserves, not slot0: reserve ratio is what a
 * small trade actually gets, and it needs no tick maths. USD value here is
 * mark-to-spot on the whole position — you will NOT realise it at that price,
 * because your own exit moves the price. The impact line says by how much.
 */
async function portfolio(): Promise<void> {
  console.log(C.bold('\n── portfolio ──\n'));
  const acct = account();
  if (!acct) {
    console.log(C.red('  PRIVATE_KEY missing or malformed\n'));
    return;
  }
  const a = arcClient();
  const gap = () => new Promise((r) => setTimeout(r, 120));

  let totalUsd = 0;
  let usdcBal = 0;
  try {
    const raw = await retry(() => a.readContract({
      address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [acct.address],
    }), 6);
    usdcBal = Number(formatUnits(raw, 6));
    totalUsd += usdcBal;
  } catch (e) {
    console.log(C.red(`  USDC read failed: ${short(e)}`));
  }

  console.log(
    `  ${'USDC'.padEnd(10)} ${usdcBal.toLocaleString('en-US', { maximumFractionDigits: 2 }).padStart(16)}   ${C.dim('cash')}`
  );

  for (const token of portfolioTokens()) {
    await gap();
    try {
      const addr = getAddress(token);
      const bal = await retry(() => a.readContract({ address: addr, abi: ERC20, functionName: 'balanceOf', args: [acct.address] }), 6);
      if (bal === 0n) continue;
      await gap();
      const dec = (await retry(() => a.readContract({ address: addr, abi: ERC20, functionName: 'decimals' }), 6)) as number;
      await gap();
      let sym = token.slice(0, 8);
      try { sym = (await retry(() => a.readContract({ address: addr, abi: ERC20, functionName: 'symbol' }), 4)) as string; } catch { /* keep the short address */ }

      // Resolve the pool: cached override first, else ask the factory per tier
      // and keep the deepest. Same rule the buy path uses.
      const cached = cfg.trade.tokens[token]?.pool;
      let best: { pool: Address; depth: number; fee: number } | null = null;
      if (cached) {
        await gap();
        const usdcInPool = await retry(() => a.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [getAddress(cached)] }), 6);
        const feeT = cfg.trade.tokens[token]?.expectedFeeTier ?? 0;
        best = { pool: getAddress(cached), depth: Number(formatUnits(usdcInPool, 6)), fee: feeT };
      } else {
        for (const factory of cfg.trade.factories) {
          for (const feeT of cfg.trade.feeTiers) {
            await gap();
            try {
              const p = (await retry(() => a.readContract({
                address: getAddress(factory), abi: FACTORY_ABI, functionName: 'getPool',
                args: [addr, USDC_ARC, feeT],
              }), 3)) as Address;
              if (/^0x0+$/.test(p)) continue;
              await gap();
              const usdcInPool = await retry(() => a.readContract({ address: USDC_ARC, abi: ERC20, functionName: 'balanceOf', args: [p] }), 4);
              const d = Number(formatUnits(usdcInPool, 6));
              if (!best || d > best.depth) best = { pool: p, depth: d, fee: feeT };
            } catch { /* a tier that will not read is not a tier that exists */ }
          }
        }
      }

      const balNum = Number(formatUnits(bal, dec));
      if (!best || best.depth === 0) {
        console.log(`  ${sym.padEnd(10)} ${balNum.toLocaleString('en-US', { maximumFractionDigits: 4 }).padStart(16)}   ${C.yellow('no priceable pool')}`);
        continue;
      }

      // spot = USDC reserve / token reserve
      await gap();
      const tokInPool = await retry(() => a.readContract({ address: addr, abi: ERC20, functionName: 'balanceOf', args: [best!.pool] }), 6);
      const tokReserve = Number(formatUnits(tokInPool, dec));
      const spot = tokReserve > 0 ? best.depth / tokReserve : 0;
      const markUsd = balNum * spot;
      totalUsd += markUsd;

      const pctOfDepth = best.depth > 0 ? (markUsd / best.depth) * 100 : 0;
      const exitImpactBps = best.depth > 0 ? (markUsd / (2 * best.depth)) * 10000 : 0;
      const feeBps = best.fee ? best.fee / 100 : 100;
      const netExit = markUsd * (1 - (exitImpactBps + feeBps) / 10000);

      console.log(
        `  ${C.bold(sym.padEnd(10))} ${balNum.toLocaleString('en-US', { maximumFractionDigits: 4 }).padStart(16)}   ` +
          `${C.bold(`$${markUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)} ${C.dim('mark')}`
      );
      console.log(
        C.dim(
          `             spot ${spot.toPrecision(6)}  pool $${best.depth.toLocaleString('en-US', { maximumFractionDigits: 0 })} (fee ${best.fee})  ` +
            `position = ${pctOfDepth.toFixed(1)}% of depth`
        )
      );
      console.log(
        `             ${C.yellow(`exit in one order ≈ $${netExit.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)} ` +
          C.dim(`(−${(exitImpactBps + feeBps).toFixed(0)} bps: impact ${exitImpactBps.toFixed(0)} + fee ${feeBps.toFixed(0)}) — linear model, a floor`)
      );
    } catch (e) {
      console.log(`  ${token.slice(0, 10)}… ${C.red(short(e))}`);
    }
  }

  console.log(
    `\n  ${C.bold('TOTAL (mark)')}  ${C.bold(`$${totalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)}`
  );
  console.log(
    C.dim(
      '  Mark-to-spot. Selling a position this size moves the price against you,\n' +
        '  so the exit lines above are what matters, not the mark.\n'
    )
  );
}

// ── menu ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  console.log(
    `\n${C.bold('executor status')} ${C.dim('— read-only, signs nothing')}`
  );

  for (;;) {
    console.log(
      `
  ${C.bold('1')}  Everything
  ${C.bold('2')}  Wallet & balances (Base + Arc)
  ${C.bold('3')}  Corridor (CCTP wiring, Iris fees, fast allowance)
  ${C.bold('4')}  Pending burn (attestation + mintRecipient check)
  ${C.bold('5')}  Pool snapshot + sizing model
  ${C.bold('6')}  RPC health
  ${C.bold('7')}  Domain truth (Arc localDomain + Base corridor diff)
  ${C.bold('8')}  ${C.bold('Portfolio')} — balances, USD mark, realistic exit
  ${C.bold('q')}  quit
`
    );
    const c = (await rl.question('  > ')).trim().toLowerCase();
    try {
      if (c === '1') {
        await rpcHealth();
        await balances();
        await portfolio();
        await corridor();
        await pendingBurn();
        await poolAndSizing(rl);
      } else if (c === '2') await balances();
      else if (c === '3') await corridor();
      else if (c === '4') await pendingBurn();
      else if (c === '5') await poolAndSizing(rl);
      else if (c === '6') await rpcHealth();
      else if (c === '7') await domainTruth();
      else if (c === '8') await portfolio();
      else if (c === 'q' || c === '') break;
      else console.log(C.dim('  ?'));
    } catch (e) {
      console.log(C.red(`\n  threw: ${short(e)}\n`));
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
