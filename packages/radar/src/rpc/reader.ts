import type { Address, Hex } from 'viem';
import type { Dex, RawLog } from '../decode/types.js';

export interface Erc20Meta {
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  /** Some field is missing because of a transient RPC failure (not a revert) — callers may retry later. */
  incomplete?: boolean;
}

export interface PoolOnchain {
  factory?: Address;
  token0?: Address;
  token1?: Address;
  fee?: number;
  /** Some field is missing because of a transient RPC failure (not a revert). */
  incomplete?: boolean;
}

export interface LogFilter {
  fromBlock: bigint;
  toBlock: bigint;
  address?: Address[];
  topics: (Hex | Hex[] | null)[];
}

/** Everything the pipeline reads from chain. Mocked in tests; RPC-backed in prod. All methods must not throw for "absent" data. */
export interface ChainReader {
  chainId(): Promise<number>;
  getCode(address: Address): Promise<Hex>;
  /** Historical code (archive state). Throws if the RPC can't serve that block. */
  getCodeAt(address: Address, block: bigint): Promise<Hex>;
  /** Fresh totalSupply (not cached — supply can change). */
  totalSupply(token: Address): Promise<bigint | undefined>;
  blockNumber(): Promise<bigint>;
  blockTimestamp(block: bigint): Promise<number | undefined>;
  txFrom(txHash: Hex): Promise<Address | undefined>;
  erc20Meta(token: Address): Promise<Erc20Meta>;
  poolOnchain(pool: Address, dex: Dex): Promise<PoolOnchain>;
  /** factory.getPool / getPair — used to prove a pool really belongs to an allowlisted factory. */
  factoryLookup(factory: Address, dex: Dex, token0: Address, token1: Address, fee?: number): Promise<Address | undefined>;
  v3SqrtPrice(pool: Address): Promise<bigint | undefined>;
  balanceOf(token: Address, holder: Address): Promise<bigint | undefined>;
  /** Bonding-curve self-description (Warp curves: factory() + token()). */
  curveInfo(curve: Address): Promise<{ factory?: Address; token?: Address }>;
  getLogs(filter: LogFilter): Promise<RawLog[]>;
}
