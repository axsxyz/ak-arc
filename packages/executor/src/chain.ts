/**
 * chain — clients, ABIs, preflight, nonce tracking, receipt semantics and the
 * single-instance lock. Every signing stage goes through here.
 *
 * Verified on chain 2026-09-15 (see README "Ground truth"): Arc chain 5042,
 * fee units 18-dec, USDC ERC-20 mirror 6-dec at 0x3600…0000.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseAbi,
  webSocket,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { ChainReader } from '../../radar/src/rpc/reader.js';
import { isTransient } from '../../radar/src/rpc/limiter.js';
import { classifyError, RpcExhausted, RpcPool, type Pub } from './rpc-pool.js';

export { classifyError, RpcExhausted } from './rpc-pool.js';

export type { Pub } from './rpc-pool.js';
import { NETWORKS } from '../../radar/src/config/networks.js';
import { erc20ToNativeUsdc, nativeToErc20Usdc } from '../../radar/src/math/units.js';
import type { Config } from './config.js';
import { C, die, log, sleep } from './log.js';

// ── constants ───────────────────────────────────────────────────────────

export const USDC_BASE = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
/** Uniform CREATE2 address across EVM mainnets (verified on Base and Arc). */
export const TOKEN_MESSENGER = getAddress('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
/** Arc's USDC ERC-20 interface (6 decimals). Native gas balance uses 18. Sourced from the radar's network table. */
export const USDC_ARC = getAddress(NETWORKS.mainnet.usdcMirror);
export const USDC_DECIMALS = 6;

// ── abis ────────────────────────────────────────────────────────────────

export const ERC20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const TOKEN_MESSENGER_ABI = parseAbi([
  'function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
  'function localMessageTransmitter() view returns (address)',
  'function remoteTokenMessengers(uint32) view returns (bytes32)',
]);

export const TRANSMITTER_ABI = parseAbi([
  'function receiveMessage(bytes,bytes)',
  'function usedNonces(bytes32) view returns (uint256)',
]);

/** SwapRouter02 shape (verified on 0x53bf…6f77: exactInputSingle 0x04e45aaf, multicall(deadline) 0x5ae401dc). */
export const ROUTER02_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function factory() view returns (address)',
]);

export const POOL_ABI = parseAbi([
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);

let activePool: RpcPool | undefined;

/** Tests only: route rpc() through a pool without makeCtx. */
export function _setActivePoolForTests(p: RpcPool | undefined): void {
  activePool = p;
}

/** Base is a single endpoint: plain transient retry, no rotation. */
export const baseRpc = <T>(fn: () => Promise<T>): Promise<T> => withRetryLocal(fn, 4, 300);

async function withRetryLocal<T>(fn: () => Promise<T>, attempts: number, baseMs: number): Promise<T> {
  let err: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      if (!isTransient(e) || i === attempts - 1) break;
      await sleep(baseMs * 2 ** i + Math.random() * 100);
    }
  }
  throw err;
}

/**
 * Raw Arc read with transient-error retry AND endpoint rotation. The closure
 * must read `ctx.arcPub` on each attempt (it is a getter for the active
 * endpoint), so a rotation moves the retry to the next endpoint. A read that
 * still fails throws; it is never turned into a zero.
 */
export const rpc = <T>(fn: () => Promise<T>, what = 'the chain'): Promise<T> => {
  if (!activePool) throw new Error('rpc(): no Arc pool (makeCtx not called)');
  return activePool.call(what, () => fn());
};

// ── clients ─────────────────────────────────────────────────────────────

export function arcChain(cfg: Config): Chain {
  return defineChain({
    id: cfg.route.arcChainId,
    name: 'Arc',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: cfg.arcHttpUrls, webSocket: cfg.arcWssUrl ? [cfg.arcWssUrl] : undefined } },
  });
}

export type Wallet = WalletClient<Transport, Chain, PrivateKeyAccount>;

export interface Ctx {
  cfg: Config;
  account: PrivateKeyAccount;
  basePub: PublicClient<Transport, typeof base>;
  baseWallet: Wallet;
  /** Rotating Arc endpoints. `arcPub` / `arcReader` below are getters onto its ACTIVE endpoint. */
  pool: RpcPool;
  /** Client for the active Arc endpoint. Never capture it in a closure; read it per attempt. */
  readonly arcPub: Pub;
  /** radar ChainReader over the pool: chainId-asserted, rotating, rate-limited (no cached "absent"). */
  readonly arcReader: ChainReader;
  /** Set only when ARC_MAINNET_WSS_URL is configured. */
  arcWs?: Pub;
}

/** Read handle for pool.ts: getters, so every attempt sees the active endpoint. */
export function readHandle(ctx: Ctx): { readonly reader: ChainReader; readonly client: Pub } {
  return {
    get reader() {
      return ctx.arcReader;
    },
    get client() {
      return ctx.arcPub;
    },
  };
}

export function makeCtx(cfg: Config): Ctx {
  const account = privateKeyToAccount(cfg.privateKey);
  const arc = arcChain(cfg);
  // Rate from config (default 5: the public RPC throttles bursts with "could not complete this request"). Long backoff rides
  // out throttle windows; a private endpoint at 50 rps rarely needs it.
  const pool = new RpcPool({ urls: cfg.arcHttpUrls, chainId: cfg.route.arcChainId, rotateAfter: cfg.arcRpcRotateAfter, readerRps: cfg.arcRpcMaxRps, readerRetryBaseMs: cfg.arcRpcRetryBaseMs, chain: arc });
  activePool = pool;
  return {
    cfg,
    account,
    basePub: createPublicClient({ chain: base, transport: http(cfg.baseRpcUrl) }),
    baseWallet: createWalletClient({ chain: base, transport: http(cfg.baseRpcUrl), account }),
    pool,
    get arcPub() {
      return pool.client;
    },
    get arcReader() {
      return pool.reader;
    },
    arcWs: cfg.arcWssUrl ? createPublicClient({ chain: arc, transport: webSocket(cfg.arcWssUrl) }) : undefined,
  };
}

export function gasParams(cfg: Config) {
  // Arc fee units are 18-decimal; the mempool enforces a 20 Gwei floor.
  const gwei = 1_000_000_000n;
  return {
    maxFeePerGas: BigInt(Math.round(cfg.gas.arcMaxFeePerGasGwei * 1e6)) * (gwei / 1_000_000n),
    maxPriorityFeePerGas: BigInt(Math.round(cfg.gas.arcPriorityFeeGwei * 1e6)) * (gwei / 1_000_000n),
  };
}

// ── gas floor ───────────────────────────────────────────────────────────

export interface GasFloor {
  ok: boolean;
  /** all 18-dec */
  native: bigint;
  reserve: bigint;
  ownGas: bigint;
  spend: bigint;
  remaining: bigint;
  perTx: bigint;
}

/**
 * Pure. After spending `spend6` (ERC-20, 6-dec) and paying for `ownTxs` of our
 * own transactions, at least gas.reserveTxCount transactions' worth of gas
 * must remain, priced at what a tx pays NOW (`gasPriceWei` = live gas price +
 * priority), not at the maxFee cap. Native USDC and the ERC-20 mirror are ONE
 * balance in two decimal systems: spending through the ERC-20 drains the gas.
 */
export function gasFloorCheck(cfg: Config, o: { native18: bigint; spend6: bigint; ownTxs: number; gasPriceWei: bigint }): GasFloor {
  const perTx = BigInt(cfg.gas.reserveGasPerTx) * o.gasPriceWei;
  const reserve = BigInt(cfg.gas.reserveTxCount) * perTx;
  const ownGas = BigInt(o.ownTxs) * perTx;
  const spend = erc20ToNativeUsdc(o.spend6);
  const remaining = o.native18 - spend - ownGas;
  return { ok: remaining >= reserve, native: o.native18, reserve, ownGas, spend, remaining, perTx };
}

const fmt18 = (v: bigint) => `${v < 0n ? '-' : ''}${(Number(nativeToErc20Usdc(v < 0n ? -v : v)) / 1e6).toFixed(6)}`;

/** Gas floor as a hard rule: a position you cannot sell is worse than one you did not take. Aborts, never warns. */
export function assertGasFloor(cfg: Config, o: { native18: bigint; spend6: bigint; ownTxs: number; gasPriceWei: bigint; what: string }): GasFloor {
  const g = gasFloorCheck(cfg, o);
  const line =
    `gas floor (${o.what}): balance ${fmt18(g.native)} − spend ${fmt18(g.spend)} − own ${o.ownTxs} tx ${fmt18(g.ownGas)} = ${fmt18(g.remaining)} USDC ` +
    `vs reserve ${fmt18(g.reserve)} (${cfg.gas.reserveTxCount} tx × ${cfg.gas.reserveGasPerTx} gas × ${Number(o.gasPriceWei) / 1e9} Gwei)`;
  if (!g.ok) die(`${line}. Refusing to spend the USDC that funds the exit.`);
  log(line);
  return g;
}

// ── preflight ───────────────────────────────────────────────────────────

export interface Preflight {
  transmitter: Address;
  arcGas: bigint;
  arcGasPrice: bigint;
}

/**
 * Asserts, before any signing: both chainIds, the route is wired both ways,
 * the Arc transmitter resolves, Arc gas is non-zero and the network gas price
 * is non-zero. Any failure aborts (exit 2). Never warns.
 */
/**
 * `spend`: what this run intends to spend on Arc through the ERC-20 interface
 * and how many of its own txs it pays for; the gas floor must survive it.
 * With no spend the floor still has to hold (the exit must be fundable).
 */
export async function preflight(ctx: Ctx, o: { base: boolean; route?: boolean; spend?: { usdc6: bigint; ownTxs: number; what: string } }): Promise<Preflight> {
  const { cfg } = ctx;
  const [baseChainId, arcChainId] = await Promise.all([o.base ? baseRpc(() => ctx.basePub.getChainId()) : Promise.resolve(cfg.route.baseChainId), rpc(() => ctx.arcPub.getChainId(), 'chainId')]);
  if (baseChainId !== cfg.route.baseChainId) die(`Base RPC chainId ${baseChainId} != ${cfg.route.baseChainId}`);
  if (arcChainId !== cfg.route.arcChainId) die(`Arc RPC chainId ${arcChainId} != ${cfg.route.arcChainId}`);
  log(`chainIds asserted: Base ${cfg.route.baseChainId}${o.base ? '' : C.dim(' (not contacted)')}, Arc ${cfg.route.arcChainId}`);

  if (o.base) {
    const route = await baseRpc(() => ctx.basePub.readContract({ address: TOKEN_MESSENGER, abi: TOKEN_MESSENGER_ABI, functionName: 'remoteTokenMessengers', args: [cfg.route.arcDomain] }));
    if (/^0x0+$/.test(route)) die(`domain ${cfg.route.arcDomain} is not wired on Base. Burning now would destroy the USDC.`);
    log(`route wired: domain ${cfg.route.arcDomain} -> 0x${route.slice(26)}`);
  }
  let transmitter: Address = '0x0000000000000000000000000000000000000000';
  if (o.route !== false) {
    const back = await rpc(() => ctx.arcPub.readContract({ address: TOKEN_MESSENGER, abi: TOKEN_MESSENGER_ABI, functionName: 'remoteTokenMessengers', args: [cfg.route.baseDomain] }));
    if (/^0x0+$/.test(back)) die(`domain ${cfg.route.baseDomain} is not wired on Arc.`);
    // Resolve the destination transmitter on chain rather than hardcoding it.
    transmitter = getAddress(await rpc(() => ctx.arcPub.readContract({ address: TOKEN_MESSENGER, abi: TOKEN_MESSENGER_ABI, functionName: 'localMessageTransmitter' })));
    if (/^0x0+$/.test(transmitter)) die('Arc localMessageTransmitter is unset');
    log(`Arc MessageTransmitter: ${transmitter}`);
  } else {
    log(C.dim('route checks skipped: nothing crosses the bridge in this session'));
  }

  // Sequential on purpose: the public RPC throttles bursts, and a throttled read must never read as zero.
  const arcGas = await rpc(() => ctx.arcPub.getBalance({ address: ctx.account.address }));
  const arcGasPrice = await rpc(() => ctx.arcPub.getGasPrice());
  if (arcGas === 0n) die('zero gas on Arc. This wallet submits its own txs and needs USDC for gas. Seed it first.');
  if (arcGasPrice === 0n) die('Arc reports a zero gas price; refusing to sign against an RPC in that state.');
  const cap = gasParams(cfg).maxFeePerGas;
  if (arcGasPrice > cap) die(`Arc gas price ${arcGasPrice / 1_000_000_000n} Gwei exceeds gas.arcMaxFeePerGasGwei (${cfg.gas.arcMaxFeePerGasGwei}). Raise the cap consciously.`);
  log(`Arc gas: balance ${arcGas} wei-USDC (18-dec), price ${arcGasPrice / 1_000_000_000n} Gwei ${C.dim(`via ${ctx.pool.describe()}`)}`);
  assertGasFloor(cfg, {
    native18: arcGas,
    spend6: o.spend?.usdc6 ?? 0n,
    ownTxs: o.spend?.ownTxs ?? 0,
    gasPriceWei: arcGasPrice + gasParams(cfg).maxPriorityFeePerGas,
    what: o.spend?.what ?? 'exit must stay fundable',
  });
  return { transmitter, arcGas, arcGasPrice };
}

// ── nonce ───────────────────────────────────────────────────────────────

/**
 * Explicit in-memory nonce counter for Arc. Read ONCE at session start
 * (pending), then incremented locally. Never call eth_getTransactionCount
 * between the mint and the buy: a public RPC can serve a stale count and
 * the second tx would replace the first.
 *
 * On a revert the nonce is consumed (keep counting). On "no receipt" the
 * chain never took the tx: the counter is now wrong and the process aborts
 * rather than guessing. Single-flight is the caller's job (sell.ts).
 */
export class NonceTracker {
  private constructor(private n: number, readonly address: Address) {}

  static async init(client: Pub, address: Address): Promise<NonceTracker> {
    const n = await rpc(() => client.getTransactionCount({ address, blockTag: 'pending' }), 'nonce');
    log(`nonce counter initialised at ${n} ${C.dim('(read once; local increments from here)')}`);
    return new NonceTracker(n, address);
  }

  static fixed(n: number, address: Address): NonceTracker {
    return new NonceTracker(n, address);
  }

  peek(): number {
    return this.n;
  }

  /** Reserve the next nonce. */
  next(): number {
    const v = this.n;
    this.n += 1;
    return v;
  }
}

/**
 * Display-only nonce read for the read-only status board. Never feeds a
 * signing path: signing stages take their nonce from NonceTracker only.
 */
export function readNonceForDisplay(client: { getTransactionCount: (a: { address: Address }) => Promise<number> }, address: Address): Promise<number> {
  return client.getTransactionCount({ address });
}

// ── signing + broadcast ─────────────────────────────────────────────────

export interface SignedTx {
  raw: Hex;
  /** keccak256 of the raw bytes: known BEFORE the send, so a lost ack can still be resolved. */
  hash: Hex;
  nonce: number;
}

/** Sign an Arc EIP-1559 tx locally with the configured fee caps. No RPC. */
export async function signTx(ctx: Ctx, tx: { to: Address; data: Hex; nonce: number; gas: bigint }): Promise<SignedTx> {
  const raw = await ctx.account.signTransaction({ chainId: ctx.cfg.route.arcChainId, type: 'eip1559', to: tx.to, data: tx.data, nonce: tx.nonce, gas: tx.gas, ...gasParams(ctx.cfg) });
  return { raw, hash: keccak256(raw), nonce: tx.nonce };
}

/**
 * Broadcast pre-signed bytes and RESOLVE the outcome.
 *
 * A transport error from the public RPC ("could not complete this request",
 * timeouts, 5xx) says nothing about whether the node took the tx. Identical
 * bytes are idempotent (same hash, same nonce), so on a transport error the
 * SAME bytes are re-sent after checking by hash. A node rejection (nonce too
 * low, underpriced, insufficient funds, revert) is final and is thrown to the
 * caller unchanged: nothing is ever re-sent to paper over a revert.
 */
export async function broadcast(ctx: Ctx, s: SignedTx, what: string): Promise<{ hash: Hex; attempts: number }> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i += 1) {
    const via = ctx.pool.describe();
    try {
      // One attempt on the ACTIVE endpoint; a transport error counts toward rotation (pool.once), a node rejection does not.
      const hash = await ctx.pool.once(`${what} broadcast`, (c) => c.sendRawTransaction({ serializedTransaction: s.raw }));
      return { hash, attempts: i + 1 };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/already known|known transaction|already imported/i.test(msg)) return { hash: s.hash, attempts: i + 1 };
      const k = classifyError(e);
      if (k.kind === 'rejected' || k.kind === 'onchain') throw e; // nonce too low / underpriced / revert: final, never re-sent, never rotates
      lastErr = e;
      log(C.dim(`${what}: broadcast attempt ${i + 1} via ${via} hit a ${k.kind} error (${k.detail.slice(0, 70)}); resolving by hash ${s.hash}`));
      // Same bytes, same hash: ask (whichever endpoint is active now) whether the node already has it before re-sending.
      const seen = await rpc(() => ctx.arcPub.getTransaction({ hash: s.hash }), 'tx lookup').then(() => true, () => false);
      if (seen) {
        log(`${what}: tx ${s.hash} is known to the node after all`);
        return { hash: s.hash, attempts: i + 1 };
      }
      await sleep(400 * 2 ** i);
    }
  }
  throw new Error(`${what}: nonce ${s.nonce} not accepted after 5 attempts (${classifyError(lastErr).detail}). Check nonce ${s.nonce} on chain before signing again.`);
}

// ── receipts ────────────────────────────────────────────────────────────

export type ReceiptOutcome =
  | { status: 'success'; receipt: TransactionReceipt }
  | { status: 'reverted'; receipt: TransactionReceipt }
  | { status: 'no_receipt' };

/**
 * "no receipt" and "reverted with receipt" are distinct outcomes: a
 * blocklist revert on Arc produces no receipt at all. Never throws on timeout.
 */
export async function waitReceipt(client: Pub | PublicClient<Transport, typeof base>, hash: Hex, timeoutMs: number, o: { arc?: boolean } = {}): Promise<ReceiptOutcome> {
  const until = Date.now() + timeoutMs;
  const arc = o.arc !== false;
  while (Date.now() < until) {
    let receipt: TransactionReceipt | undefined;
    try {
      // Arc: through the pool (rotation + accounting; the closure re-reads the active client). Base: single endpoint.
      const fn = () => (arc ? (activePool!.client as Pub) : client).getTransactionReceipt({ hash });
      receipt = arc ? await rpc(fn, 'receipt') : await baseRpc(fn);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/could not be found|not found|not be processed/i.test(msg)) log(C.dim(`receipt poll: ${msg.split('\n')[0]!.slice(0, 80)}`));
    }
    if (receipt) return receipt.status === 'success' ? { status: 'success', receipt } : { status: 'reverted', receipt };
    await sleep(500);
  }
  return { status: 'no_receipt' };
}

/**
 * Sub-second preconfirmation receipts (Base) and lagging public RPCs (Arc)
 * mean a receipt does NOT mean the new state is readable. Poll the actual
 * state until `ok` holds. Returns the last value, or undefined on RPC error
 * (a failed read is not an on-chain zero).
 */
export async function pollState<T>(read: () => Promise<T>, ok: (v: T) => boolean, o: { intervalMs: number; maxMs: number }): Promise<T | undefined> {
  const until = Date.now() + o.maxMs;
  let last: T | undefined;
  let lastErr: unknown;
  while (Date.now() < until) {
    try {
      last = await read();
      lastErr = undefined;
      if (ok(last)) return last;
    } catch (e) {
      lastErr = e;
    }
    await sleep(o.intervalMs);
  }
  if (lastErr) log(C.red(`state poll ended on RPC error: ${String((lastErr as Error)?.message ?? lastErr).split('\n')[0]}`));
  return lastErr ? undefined : last;
}

// ── single-instance lock ────────────────────────────────────────────────

/**
 * One signing process PER WALLET at a time — the lock file is keyed by the
 * signer address, so unrelated wallets never block each other (a single
 * global data/executor.lock blocked six unrelated bridges run with different
 * keys). PID-stamped, removed on exit AND on SIGINT, stale if the PID is
 * gone. Liveness is kill(pid, 0): a PID from another OS namespace (a
 * Windows process seen from WSL) always reads as gone and is taken over.
 *
 * The SIGINT handler matters for stages without raw-mode stdin (bridge,
 * bridge-out, buy, run, mint-watch): they can sit for minutes waiting on an
 * attestation, and Ctrl+C there is a real SIGINT. sell.ts's TUI puts stdin
 * in raw mode, which suppresses signal generation for Ctrl+C entirely (it
 * arrives as a plain byte instead — see its own CTRL_C handling), so this
 * handler is simply never invoked there. Once ANY 'SIGINT' listener is
 * registered, Node stops exiting on Ctrl+C by default, so this handler must
 * call process.exit() itself or an interrupted run would hang forever.
 */
export function tryAcquireLock(cwd: string, address: Address, name = 'executor'): { release: () => void } | { holder: number; file: string } {
  const dir = path.join(cwd, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${address.toLowerCase()}.lock`);
  const tryWrite = () => fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  try {
    tryWrite();
  } catch {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) return { holder: pid, file };
    log(C.yellow(`stale lock ${file} (pid ${pid} not found from this OS); taking it over`));
    fs.unlinkSync(file);
    tryWrite();
  }
  const release = () => {
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      // best effort
    }
  };
  process.once('exit', release);
  process.once('SIGINT', () => {
    release();
    process.exit(130); // 128 + SIGINT, the conventional Ctrl+C exit code
  });
  return { release };
}

/** Acquire or abort (buy / sell / run / bridge / bridge-out hold the lock for their whole life). */
export function acquireLock(cwd: string, address: Address, name = 'executor'): () => void {
  const r = tryAcquireLock(cwd, address, name);
  if ('holder' in r) die(`another executor process (pid ${r.holder}) holds ${r.file}. Refusing to run two signers for this wallet.`);
  return r.release;
}

/** Acquire, waiting up to maxMs for a live holder to finish (mint-watch takes the lock only at mint time). */
export async function acquireLockWait(cwd: string, address: Address, maxMs: number, name = 'executor'): Promise<() => void> {
  const until = Date.now() + maxMs;
  let last = '';
  for (;;) {
    const r = tryAcquireLock(cwd, address, name);
    if ('release' in r) return r.release;
    const msg = `waiting for lock held by pid ${r.holder}`;
    if (msg !== last) {
      last = msg;
      log(C.yellow(msg));
    }
    if (Date.now() >= until) die(`${r.file} still held by pid ${r.holder} after ${maxMs} ms. Not minting on top of another signer.`);
    await sleep(500);
  }
}
