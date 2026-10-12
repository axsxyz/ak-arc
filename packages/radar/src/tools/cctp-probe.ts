/**
 * cctp-probe — is CCTP domain 26 (Arc) wired on Base mainnet yet?
 *
 * Read-only. No keys, no signing, no state. Throwaway diagnostic.
 *
 * Run:  npx tsx src/tools/cctp-probe.ts
 *
 * Addresses come from env (see printed config). Nothing is hardcoded that
 * has not been verified — TM_V2_BASE must be supplied by you from
 * https://developers.circle.com/cctp (contract addresses, CCTP V2 mainnet).
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  type Address,
  type Hex,
} from 'viem';

// ── config ──────────────────────────────────────────────────────────────

const BASE_RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
const ARC_RPC = process.env.ARC_MAINNET_HTTP_URL ?? 'https://rpc.arc-scan.org';

// Widely known, but VERIFY before trusting it with money.
const USDC_BASE_DEFAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// CCTP V2 proxies are deployed via CREATE2, so TokenMessengerV2 has the SAME
// address on every EVM mainnet. Labelled "Circle CCTP: Token Messenger V2" on
// both BaseScan and LineaScan. Implementation behind the proxy:
// 0x555e272506c06e7e559d57418563742afe363ec8
// VERIFY on basescan.org before signing anything with it.
const TM_V2_DEFAULT = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';

const TM_V2_BASE = process.env.TM_V2_BASE ?? TM_V2_DEFAULT;
const USDC_BASE = process.env.USDC_BASE ?? USDC_BASE_DEFAULT;
const MY_ADDR = process.env.EXECUTOR_ADDRESS ?? '';

const ARC_DOMAIN = 26;
// Controls: domains that MUST already be wired. If a control reads zero,
// the probe itself is wrong — not the domain.
// Never include 6 (Base) here: that is this chain itself, and a messenger
// has no remote entry for its own domain.
const CONTROL_DOMAINS = [0, 3, 2] as const; // Ethereum, Arbitrum, OP Mainnet

// Negative controls: domains that should NOT be wired on CCTP V2 mainnet.
// 4 = Noble and 8 = Sui are V1-legacy only. 99/200 are not issued at all.
// If these read non-zero, the getter is not a liveness signal and Probe A
// proves nothing.
const NEGATIVE_DOMAINS = [4, 8, 99, 200] as const;

// TokenMessengerV2, uniform across EVM mainnets (CREATE2). Used here as a
// getCode target to test whether CCTP is deployed on Arc mainnet at all.
const CCTP_MAINNET_PROBE_ADDR = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
// Arc TESTNET TokenMessengerV2, from docs.arc.io. Shape reference only.
const CCTP_TESTNET_TM = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';

const base = createPublicClient({ transport: http(BASE_RPC) });
const arc = createPublicClient({ transport: http(ARC_RPC) });

const ZERO32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

// ── abis ────────────────────────────────────────────────────────────────

const TM_ABI = parseAbi([
  'function remoteTokenMessengers(uint32) view returns (bytes32)',
  'function remoteTokenMessenger(uint32) view returns (bytes32)',
  'function localMinter() view returns (address)',
  'function localMessageTransmitter() view returns (address)',
  'function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32) returns (uint64)',
]);

const MINTER_ABI = parseAbi([
  'function getLocalToken(uint32,bytes32) view returns (address)',
]);

const ERC20_ABI = parseAbi([
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// ── helpers ─────────────────────────────────────────────────────────────

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function shortErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0]!.slice(0, 160);
}

function toBytes32(addr: string): Hex {
  return `0x${'0'.repeat(24)}${addr.replace(/^0x/, '').toLowerCase()}` as Hex;
}

function requireTm(): Address | null {
  if (!TM_V2_BASE) {
    console.log(
      C.red('\n  TM_V2_BASE is not set.') +
        '\n  Get TokenMessengerV2 (Base mainnet) from:' +
        '\n    https://developers.circle.com/cctp  → contract addresses → CCTP V2 mainnet' +
        '\n  Then:  set TM_V2_BASE=0x...   (or add it to .env)\n'
    );
    return null;
  }
  try {
    return getAddress(TM_V2_BASE);
  } catch {
    console.log(C.red(`\n  TM_V2_BASE is not a valid address: ${TM_V2_BASE}\n`));
    return null;
  }
}

// ── probe A: remote messenger state ─────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Public RPCs rate-limit bursts. Space reads out and retry once.
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await sleep(1200);
    return fn();
  }
}

function fmt32(v: Hex): string {
  // Never truncate inside the 24-byte zero padding: every left-padded EVM
  // address looks like all zeros there. Show the payload instead.
  const body = v.slice(2);
  if (/^0+$/.test(body)) return 'zero';
  const padding = body.slice(0, 24);
  const payload = body.slice(24);
  if (/^0+$/.test(padding)) return `0x${payload}`;
  return v; // not address-shaped: show it whole
}

async function readRemote(
  tm: Address,
  domain: number
): Promise<{ value: Hex | null; via: string; err?: string }> {
  for (const fn of ['remoteTokenMessengers', 'remoteTokenMessenger'] as const) {
    try {
      const value = (await throttled(() =>
        base.readContract({
          address: tm,
          abi: TM_ABI,
          functionName: fn,
          args: [domain],
        })
      )) as Hex;
      return { value, via: fn };
    } catch (e) {
      if (fn === 'remoteTokenMessenger') {
        return { value: null, via: 'none', err: shortErr(e) };
      }
    }
  }
  return { value: null, via: 'none' };
}

async function probeA(): Promise<void> {
  const tm = requireTm();
  if (!tm) return;

  console.log(C.bold('\n── Probe A — remoteTokenMessengers state ──\n'));

  const seen = new Map<number, string>();

  const show = async (domain: number, tag: string): Promise<void> => {
    const r = await readRemote(tm, domain);
    if (r.value !== null) seen.set(domain, r.value.toLowerCase());
    const label =
      r.value === null
        ? C.red(`unreadable  ${r.err ?? ''}`)
        : r.value === ZERO32
          ? C.dim('zero  (unwired)')
          : C.green(fmt32(r.value));
    console.log(`  ${tag.padEnd(24)} ${label}`);
  };

  for (const d of CONTROL_DOMAINS) {
    await show(d, `control domain ${d}`);
    await sleep(350);
  }

  console.log(C.dim('\n  negative controls (must be zero):'));
  for (const d of NEGATIVE_DOMAINS) {
    await show(d, `unused domain ${d}`);
    await sleep(350);
  }

  console.log('');
  const t = await readRemote(tm, ARC_DOMAIN);
  console.log(
    `  ${C.bold(`DOMAIN ${ARC_DOMAIN} (Arc)`.padEnd(24))} ${
      t.value === null
        ? C.red(`unreadable — ${t.err ?? ''}`)
        : t.value === ZERO32
          ? C.yellow('zero  (unwired)')
          : C.green(C.bold(fmt32(t.value)))
    }`
  );

  console.log('');
  const negWired = NEGATIVE_DOMAINS.filter(
    (d) => seen.has(d) && seen.get(d) !== ZERO32
  );
  const ctrlWired = CONTROL_DOMAINS.filter(
    (d) => seen.has(d) && seen.get(d) !== ZERO32
  );

  if (t.value === null) {
    console.log(
      C.red('  VERDICT: domain 26 could not be read.') +
        '\n  This is an RPC failure, NOT an on-chain state. Retry, or point\n' +
        '  BASE_RPC_URL at a keyed endpoint. Never read a failed call as "unwired".'
    );
  } else if (negWired.length > 0) {
    console.log(
      C.red(C.bold('  VERDICT: this getter is NOT a liveness signal.')) +
        `\n  Unused domains ${negWired.join(', ')} also read non-zero.` +
        '\n  Probe A proves nothing. Use option 6 (Arc-side deployment check).'
    );
  } else if (ctrlWired.length === 0) {
    console.log(
      C.red('  VERDICT: inconclusive.') +
        ' No control reads non-zero — TM_V2_BASE is probably wrong.'
    );
  } else if (t.value === ZERO32) {
    console.log(
      C.green('  VERDICT: domain 26 is NOT wired on Base mainnet.') +
        '\n  Controls wired, negatives zero — this reading is trustworthy.'
    );
  } else {
    console.log(
      C.yellow(C.bold('  VERDICT: domain 26 is wired on the SOURCE side.')) +
        '\n  That only means Base will burn and emit toward domain 26.' +
        '\n  It does NOT mean Arc mainnet can mint. Run option 6 first.\n  ' +
        C.red('Burning toward a destination that cannot mint destroys the USDC.')
    );
  }
  console.log('');
}

// ── is CCTP deployed on Arc mainnet at all? ──────────────────────────

async function arcDeploymentCheck(): Promise<void> {
  console.log(C.bold('\n── Arc mainnet CCTP deployment ──\n'));

  const chainId = await arc.getChainId().catch(() => null);
  if (chainId !== 5042) {
    console.log(
      C.red(`  Arc RPC returned chainId ${chainId}, expected 5042. Aborting.`)
    );
    return;
  }

  const targets: Array<[string, string]> = [
    ['TokenMessengerV2 (mainnet CREATE2)', CCTP_MAINNET_PROBE_ADDR],
    ['TokenMessengerV2 (testnet addr)', CCTP_TESTNET_TM],
  ];
  if (process.env.EXTRA_CCTP_ADDR) {
    targets.push(['EXTRA_CCTP_ADDR', process.env.EXTRA_CCTP_ADDR]);
  }

  let anyCode = false;
  for (const [label, addr] of targets) {
    try {
      const code = await arc.getCode({ address: getAddress(addr) });
      const size = code && code !== '0x' ? (code.length - 2) / 2 : 0;
      if (size > 0) anyCode = true;
      console.log(
        `  ${label.padEnd(36)} ${
          size > 0 ? C.green(`${size} bytes`) : C.dim('no code')
        }  ${C.dim(addr)}`
      );
    } catch (e) {
      console.log(`  ${label.padEnd(36)} ${C.red(shortErr(e))}`);
    }
  }

  console.log('');
  if (anyCode) {
    console.log(
      C.green('  CCTP contracts exist on Arc mainnet.') +
        '\n  The destination can mint. Still confirm Iris attests for this\n' +
        '  domain before burning real size.'
    );
  } else {
    console.log(
      C.red(C.bold('  NO CCTP CODE ON ARC MAINNET at the probed addresses.')) +
        '\n  Do NOT burn. A burn toward a destination that cannot mint destroys\n' +
        '  the USDC until — and unless — that destination goes live on this domain.\n' +
        C.dim(
          '  The real addresses may differ from the CREATE2 default: set\n' +
            '  EXTRA_CCTP_ADDR to test another, or find them with discover:onchain.'
        )
    );
  }
  console.log('');
}

// ── probe B: control vs treatment simulation ────────────────────────────

async function probeB(): Promise<void> {
  const tm = requireTm();
  if (!tm) return;
  if (!MY_ADDR) {
    console.log(
      C.red('\n  EXECUTOR_ADDRESS is not set.') +
        '  Probe B simulates from your address.\n' +
        '  set EXECUTOR_ADDRESS=0x...\n'
    );
    return;
  }
  const me = getAddress(MY_ADDR);
  const usdc = getAddress(USDC_BASE);

  console.log(C.bold('\n── Probe B — depositForBurn simulation ──\n'));

  // Preconditions first: a revert from allowance/balance tells us nothing
  // about the domain, so surface them before interpreting anything.
  let allowance = 0n;
  let balance = 0n;
  try {
    [allowance, balance] = await Promise.all([
      base.readContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [me, tm],
      }) as Promise<bigint>,
      base.readContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [me],
      }) as Promise<bigint>,
    ]);
  } catch (e) {
    console.log(C.red(`  could not read USDC state: ${shortErr(e)}`));
    return;
  }

  const amount = 1_000_000n; // 1 USDC, 6 decimals on Base
  console.log(`  USDC balance    ${C.dim((Number(balance) / 1e6).toFixed(2))}`);
  console.log(`  allowance → TM  ${C.dim((Number(allowance) / 1e6).toFixed(2))}`);
  if (balance < amount || allowance < amount) {
    console.log(
      C.yellow(
        '\n  Both sides will revert on balance/allowance, not on the domain.\n' +
          '  Approve USDC → TokenMessenger on Base first (you need it anyway),\n' +
          '  and hold ≥ 1 USDC. Then rerun.\n'
      )
    );
    return;
  }

  const mintRecipient = toBytes32(me);

  const sim = async (domain: number) => {
    try {
      await base.simulateContract({
        address: tm,
        abi: TM_ABI,
        functionName: 'depositForBurn',
        args: [amount, domain, mintRecipient, usdc, ZERO32, 0n, 1000],
        account: me,
      });
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, err: shortErr(e) };
    }
  };

  const control = await sim(CONTROL_DOMAINS[0]);
  console.log(
    `\n  control domain ${CONTROL_DOMAINS[0]}   ${
      control.ok ? C.green('OK') : C.red('revert') + C.dim(`  ${control.err}`)
    }`
  );

  const treat = await sim(ARC_DOMAIN);
  console.log(
    `  ${C.bold(`domain ${ARC_DOMAIN} (Arc)`)}     ${
      treat.ok ? C.green('OK') : C.red('revert') + C.dim(`  ${treat.err}`)
    }`
  );

  console.log('');
  if (control.ok && !treat.ok) {
    console.log(
      C.green('  VERDICT: G1 validated.') +
        ' Control passes, domain 26 reverts — the revert is the domain.'
    );
  } else if (control.ok && treat.ok) {
    console.log(
      C.red(C.bold('  VERDICT: domain 26 simulates fine.')) +
        ' The route may already be open. Check now.'
    );
  } else {
    console.log(
      C.yellow('  VERDICT: inconclusive.') +
        ' The control reverts too, so something unrelated to the domain\n' +
        '  is failing. Fix that before reading anything into the treatment.'
    );
  }
  console.log('');
}

// ── watch loop ──────────────────────────────────────────────────────────

async function watch(rl: ReturnType<typeof createInterface>): Promise<void> {
  const tm = requireTm();
  if (!tm) return;

  const raw = await rl.question('  poll interval seconds [10]: ');
  const secs = Math.max(1, Number(raw.trim()) || 10);

  console.log(
    C.dim(`\n  polling domain ${ARC_DOMAIN} every ${secs}s — Ctrl+C to stop\n`)
  );

  let n = 0;
  for (;;) {
    n += 1;
    const r = await readRemote(tm, ARC_DOMAIN);
    const ts = new Date().toISOString().slice(11, 19);
    if (r.value === null) {
      console.log(`  ${ts}  #${n}  ${C.red('unreadable')}  ${r.err ?? ''}`);
    } else if (r.value === ZERO32) {
      console.log(`  ${ts}  #${n}  ${C.dim('unwired')}`);
    } else {
      console.log(
        `\n  ${ts}  ${C.green(C.bold('*** DOMAIN 26 WIRED ***'))}  ${r.value}\n`
      );
      process.stdout.write('\x07\x07\x07'); // terminal bell
      return;
    }
    await new Promise((res) => setTimeout(res, secs * 1000));
  }
}

// ── arc status ──────────────────────────────────────────────────────────

async function arcStatus(): Promise<void> {
  console.log(C.bold('\n── Arc mainnet status ──\n'));
  try {
    const [chainId, blockNumber, gasPrice] = await Promise.all([
      arc.getChainId(),
      arc.getBlockNumber(),
      arc.getGasPrice(),
    ]);
    const okChain = chainId === 5042;
    console.log(
      `  chainId      ${okChain ? C.green(String(chainId)) : C.red(`${chainId} (expected 5042)`)}`
    );
    console.log(`  block        ${blockNumber}`);
    console.log(
      `  gasPrice     ${gasPrice} wei  ${C.dim(`≈ ${(Number(gasPrice) / 1e9).toFixed(2)} Gwei`)}`
    );
    // Fee units are 18-dec on Arc; a 250k-gas call at this price:
    const call = (Number(gasPrice) * 250_000) / 1e18;
    console.log(
      `  250k-gas call ≈ ${C.dim(`${call.toFixed(6)} USDC`)}  ${C.dim(
        '(assumes 18-dec fee units — verify against the explorer)'
      )}`
    );
  } catch (e) {
    console.log(C.red(`  unreachable: ${shortErr(e)}`));
  }
  console.log('');
}

// ── reverse check: is the Arc side CONFIGURED, not just deployed? ────────

async function arcConfigCheck(): Promise<void> {
  console.log(C.bold('\n── Arc side configuration ──\n'));
  console.log(
    C.dim('  Deployment is not configuration. A deployed messenger with no\n') +
      C.dim('  remote source, no minter, or no token mapping cannot mint.\n')
  );

  const chainId = await arc.getChainId().catch(() => null);
  if (chainId !== 5042) {
    console.log(C.red(`  Arc chainId ${chainId}, expected 5042. Aborting.`));
    return;
  }

  const tmArc = getAddress(CCTP_MAINNET_PROBE_ADDR);
  const BASE_DOMAIN = 6;
  const arcUsdc = '0x3600000000000000000000000000000000000000';

  let ok = true;

  // 1. Is Base wired as a remote source on Arc?
  try {
    const remote = (await throttled(() =>
      arc.readContract({
        address: tmArc,
        abi: TM_ABI,
        functionName: 'remoteTokenMessengers',
        args: [BASE_DOMAIN],
      })
    )) as Hex;
    const wired = remote !== ZERO32;
    if (!wired) ok = false;
    console.log(
      `  remote messenger (Base, d6)   ${
        wired ? C.green(fmt32(remote)) : C.red('zero — Base NOT wired as source')
      }`
    );
  } catch (e) {
    ok = false;
    console.log(`  remote messenger (Base, d6)   ${C.red(shortErr(e))}`);
  }
  await sleep(350);

  // 2. Is a local minter set?
  let minter: Address | null = null;
  try {
    minter = (await throttled(() =>
      arc.readContract({ address: tmArc, abi: TM_ABI, functionName: 'localMinter' })
    )) as Address;
    const set = minter !== '0x0000000000000000000000000000000000000000';
    if (!set) ok = false;
    console.log(
      `  localMinter                   ${set ? C.green(minter) : C.red('unset')}`
    );
  } catch (e) {
    ok = false;
    console.log(`  localMinter                   ${C.red(shortErr(e))}`);
  }
  await sleep(350);

  // 3. Does the minter map Base USDC -> Arc USDC?
  if (minter && minter !== '0x0000000000000000000000000000000000000000') {
    try {
      const local = (await throttled(() =>
        arc.readContract({
          address: minter as Address,
          abi: MINTER_ABI,
          functionName: 'getLocalToken',
          args: [BASE_DOMAIN, toBytes32(USDC_BASE)],
        })
      )) as Address;
      const mapped = local !== '0x0000000000000000000000000000000000000000';
      const isArcUsdc = local.toLowerCase() === arcUsdc.toLowerCase();
      if (!mapped) ok = false;
      console.log(
        `  Base USDC → local token       ${
          !mapped
            ? C.red('unmapped — mint would revert')
            : isArcUsdc
              ? C.green(`${local}  (Arc USDC)`)
              : C.yellow(`${local}  (NOT the expected Arc USDC)`)
        }`
      );
    } catch (e) {
      ok = false;
      console.log(`  Base USDC → local token       ${C.red(shortErr(e))}`);
    }
  }

  console.log('');
  console.log(
    ok
      ? C.green('  Arc side looks fully configured for Base → Arc.') +
          '\n  Remaining unknown: does Iris attest for domain 26 on mainnet?\n' +
          '  The only way to know is a 1 USDC test bridge. Do that before size.'
      : C.red(C.bold('  Arc side is NOT ready.')) +
          '\n  Do not burn. A burn now emits a message nothing can mint.'
  );
  console.log('');
}

// ── menu ────────────────────────────────────────────────────────────────

function printConfig(): void {
  console.log(C.bold('\n  cctp-probe') + C.dim('  — read-only, no keys\n'));
  console.log(`  BASE_RPC_URL     ${C.dim(BASE_RPC)}`);
  console.log(`  ARC RPC          ${C.dim(ARC_RPC)}`);
  console.log(
    `  TM_V2_BASE       ${C.dim(TM_V2_BASE)}${
      TM_V2_BASE === TM_V2_DEFAULT ? C.yellow('  (default — verify on basescan)') : ''
    }`
  );
  console.log(
    `  USDC_BASE        ${C.dim(USDC_BASE)}${
      USDC_BASE === USDC_BASE_DEFAULT ? C.yellow('  (default — verify)') : ''
    }`
  );
  console.log(
    `  EXECUTOR_ADDRESS   ${MY_ADDR ? C.dim(MY_ADDR) : C.dim('not set (probe B only)')}`
  );
}

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  printConfig();

  for (;;) {
    console.log(
      `
  ${C.bold('1')}  Probe A — read remoteTokenMessengers(26) + controls   ${C.dim('← start here')}
  ${C.bold('2')}  Probe B — simulate depositForBurn, control vs Arc
  ${C.bold('3')}  Watch   — poll domain 26 until it flips
  ${C.bold('4')}  Arc mainnet status (chainId, block, gas)
  ${C.bold('5')}  Run A + 4 + 6
  ${C.bold('6')}  Arc mainnet CCTP deployment check   ${C.red('← run before any burn')}
  ${C.bold('7')}  Arc side CONFIG check (remote source, minter, token map)
  ${C.bold('q')}  quit
`
    );
    const choice = (await rl.question('  > ')).trim().toLowerCase();

    try {
      if (choice === '1') await probeA();
      else if (choice === '2') await probeB();
      else if (choice === '3') await watch(rl);
      else if (choice === '4') await arcStatus();
      else if (choice === '6') await arcDeploymentCheck();
      else if (choice === '7') await arcConfigCheck();
      else if (choice === '5') {
        await probeA();
        await arcStatus();
        await arcDeploymentCheck();
        await arcConfigCheck();
      } else if (choice === 'q' || choice === '') break;
      else console.log(C.dim('  ?'));
    } catch (e) {
      console.log(C.red(`\n  probe threw: ${shortErr(e)}\n`));
    }
  }

  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
