/**
 * approve — read or set an ERC-20 allowance on Arc. Nothing else.
 *
 *   npx tsx src/approve.ts --spender 0x…              read the allowance
 *   npx tsx src/approve.ts --spender 0x… --live       approve unlimited
 *   npx tsx src/approve.ts --spender 0x… --live --amount 100
 *   npx tsx src/approve.ts --spender 0x… --live --amount 0   revoke
 *
 * Defaults to USDC on Arc (0x3600…0000, 6-dec interface). --token overrides.
 *
 * Use when a UI's own approval step fails and you want to set the allowance
 * yourself. Find the spender the UI actually wants in the MetaMask prompt —
 * do not guess it.
 */

import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { toolEnv } from './config.js';

const ENV = toolEnv();
const ARC_RPC = ENV.arcRpcs[0] ?? 'https://rpc.arc-scan.org';
const ARC_CHAIN_ID = 5042;
const USDC_ARC = '0x3600000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;

const arc = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
});

const ERC20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIVE = argv.includes('--live');

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function die(m: string): never {
  console.error(`\n${C.red('ABORT')} ${m}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const raw = ENV.privateKey;
  const pk = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) die('PRIVATE_KEY missing or malformed');
  const account = privateKeyToAccount(pk as Hex);

  const spenderArg = flag('spender');
  if (!spenderArg) {
    die(
      '--spender is required. Find it in the MetaMask approval prompt\n' +
        "  (the contract being granted access). Do not guess it: approving the\n" +
        '  wrong contract does not unblock the UI and leaves a live allowance.'
    );
  }
  let spender: Address;
  let token: Address;
  try {
    spender = getAddress(spenderArg);
    token = getAddress(flag('token') ?? USDC_ARC);
  } catch {
    die('malformed --spender or --token address');
  }

  const pub = createPublicClient({ chain: arc, transport: http(ARC_RPC) });
  const wallet = createWalletClient({ chain: arc, transport: http(ARC_RPC), account });

  const chainId = await pub.getChainId();
  if (chainId !== ARC_CHAIN_ID) die(`Arc RPC returned chainId ${chainId}`);

  const [dec, sym, bal, current] = await Promise.all([
    pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' }),
    pub.readContract({ address: token, abi: ERC20, functionName: 'symbol' }).catch(() => '???'),
    pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] }),
    pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [account.address, spender] }),
  ]);

  console.log(`\n${C.bold('executor approve')}  ${LIVE ? C.red('LIVE') : C.green('READ ONLY')}\n`);
  console.log(`  wallet     ${account.address}`);
  console.log(`  token      ${sym} ${C.dim(token)} ${C.dim(`(${dec}-dec)`)}`);
  console.log(`  balance    ${formatUnits(bal, dec)}`);
  console.log(`  spender    ${spender}`);
  console.log(
    `  allowance  ${current === MAX_UINT256 ? C.green('unlimited') : formatUnits(current, dec)}\n`
  );

  if (!LIVE) {
    console.log(
      `${C.dim('Read only. Add --live to set it (unlimited unless --amount is given).')}\n`
    );
    return;
  }

  const amountArg = flag('amount');
  const value = amountArg === undefined ? MAX_UINT256 : parseUnits(amountArg, dec);
  if (value === current) {
    console.log(`${C.green('Already at that value.')} Nothing to do.\n`);
    return;
  }

  console.log(
    `  setting allowance to ${value === MAX_UINT256 ? 'unlimited' : formatUnits(value, dec)}...`
  );
  const hash = await wallet.sendTransaction({
    to: token,
    data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, value] }),
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });

  // A receipt is not a readable state. Confirm the allowance itself.
  const after = await pub.readContract({
    address: token, abi: ERC20, functionName: 'allowance', args: [account.address, spender],
  });
  console.log(
    `  mined in block ${receipt.blockNumber}: ${hash}\n` +
      `  allowance now ${after === MAX_UINT256 ? C.green('unlimited') : formatUnits(after, dec)}\n`
  );
}

main().catch((e) => {
  console.error(`\n${C.red('failed')} ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
