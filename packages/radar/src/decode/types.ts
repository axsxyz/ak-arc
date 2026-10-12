import type { Address, Hex } from 'viem';

/** Canonical raw log (RPC shape with numeric fields parsed). */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  /** Some RPCs include it; otherwise resolved from heads/getBlock. Seconds. */
  blockTimestamp?: number;
  removed?: boolean;
}

export type Dex = 'univ2' | 'univ3';

interface Base {
  raw: RawLog;
  emitter: Address; // lowercased
}

export interface PoolCreatedEv extends Base {
  kind: 'pool_created';
  dex: Dex;
  factory: Address;
  pool: Address;
  token0: Address;
  token1: Address;
  fee?: number;
}

/** amounts are from the pool's perspective: positive = pool received that token. */
export interface SwapEv extends Base {
  kind: 'swap';
  dex: Dex;
  pool: Address;
  sender: Address;
  recipient: Address;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96?: bigint;
}

export interface LiquidityEv extends Base {
  kind: 'mint' | 'burn';
  dex: Dex;
  pool: Address;
  owner: Address;
  amount0: bigint; // always >= 0
  amount1: bigint;
}

export interface SyncEv extends Base {
  kind: 'sync';
  pool: Address;
  reserve0: bigint;
  reserve1: bigint;
}

export interface TransferEv extends Base {
  kind: 'transfer';
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
}

export type AdapterName = 'generic' | 'lift' | 'tolly' | 'radar' | 'warp';

export interface PadTokenCreatedEv extends Base {
  kind: 'pad_token_created';
  adapter: AdapterName;
  token: Address;
  creator: Address;
  name: string;
  symbol: string;
  /** Launchers that open a (UniV3) pool at launch. */
  pool?: Address;
  /** Bonding-curve launchers (Warp): the per-token curve contract. */
  curve?: Address;
  quote?: Address;
  initialBuyQuoteRaw?: bigint;
}

/** Bonding-curve trade (Warp). quoteRaw is native USDC (18 dec) for Warp. */
export interface PadTradeEv extends Base {
  kind: 'pad_trade';
  adapter: AdapterName;
  curve: Address;
  trader: Address;
  isBuy: boolean;
  quoteRaw: bigint;
  tokenRaw: bigint;
}

export interface PadGraduatedEv extends Base {
  kind: 'pad_graduated';
  token: Address;
  pool: Address;
  quoteRaised: bigint;
}

/** CCTP MessageTransmitter.MessageReceived. Enrichment only (sourceDomain/caller) — the inflow signal itself comes from the paired mint Transfer. */
export interface BridgeMintEv extends Base {
  kind: 'bridge_mint';
  caller: Address;
  nonce: Hex;
  sourceDomain: number;
}

/** CCTP TokenMessengerV2.DepositForBurn: USDC leaving this chain. mintRecipient is the destination-chain address (last 20 bytes of the bytes32 field). */
export interface BridgeBurnEv extends Base {
  kind: 'bridge_burn';
  burnToken: Address;
  amount: bigint;
  depositor: Address;
  mintRecipient: Address;
  destinationDomain: number;
}

export type NormalizedEvent =
  | PoolCreatedEv
  | SwapEv
  | LiquidityEv
  | SyncEv
  | TransferEv
  | PadTokenCreatedEv
  | PadTradeEv
  | PadGraduatedEv
  | BridgeMintEv
  | BridgeBurnEv;
