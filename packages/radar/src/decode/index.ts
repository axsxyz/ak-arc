import { decodeEventLog, hexToBigInt, toEventSelector, type Abi, type Address, type Hex } from 'viem';
import { erc20Abi } from '../abi/erc20.js';
import { univ2FactoryAbi, univ2PairAbi } from '../abi/univ2.js';
import { univ3FactoryAbi, univ3PoolAbi } from '../abi/univ3.js';
import { genericPadAbi } from '../abi/pads.js';
import { cctpMessageTransmitterAbi, cctpTokenMessengerAbi } from '../abi/cctp.js';
import type { NormalizedEvent, RawLog } from './types.js';
import { ADAPTER_TOPIC_LIST, decodeAdapterLog } from './adapters.js';

const sel = (sig: string) => toEventSelector(sig);

export const TOPICS = {
  transfer: sel('Transfer(address,address,uint256)'),
  v2PairCreated: sel('PairCreated(address,address,address,uint256)'),
  v2Swap: sel('Swap(address,uint256,uint256,uint256,uint256,address)'),
  v2Mint: sel('Mint(address,uint256,uint256)'),
  v2Burn: sel('Burn(address,uint256,uint256,address)'),
  v2Sync: sel('Sync(uint112,uint112)'),
  v3PoolCreated: sel('PoolCreated(address,address,uint24,int24,address)'),
  v3Swap: sel('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  v3Mint: sel('Mint(address,address,int24,int24,uint128,uint256,uint256)'),
  v3Burn: sel('Burn(address,int24,int24,uint128,uint256,uint256)'),
  padTokenCreated: sel('TokenCreated(address,address,string,string)'),
  padGraduated: sel('Graduated(address,address,uint256)'),
  bridgeMessageReceived: sel('MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)'),
  bridgeDepositForBurn: sel('DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)'),
} as const;

/** Topics subscribed without an address filter (DEX + pad lifecycle). Transfer is address-filtered separately. */
export const DEX_TOPICS: Hex[] = [
  TOPICS.v2PairCreated,
  TOPICS.v2Swap,
  TOPICS.v2Mint,
  TOPICS.v2Burn,
  TOPICS.v2Sync,
  TOPICS.v3PoolCreated,
  TOPICS.v3Swap,
  TOPICS.v3Mint,
  TOPICS.v3Burn,
  TOPICS.padTokenCreated,
  TOPICS.padGraduated,
  ...ADAPTER_TOPIC_LIST, // mainnet launchers (Lift/Tolly/Radar/Warp); emitter-gated in the pipeline
];

/** CCTP MessageTransmitter/TokenMessenger topics, address-filtered to config/watchlists/infra.yaml's cctp addresses (see pipeline.cctpAddresses()). */
export const CCTP_TOPICS: Hex[] = [TOPICS.bridgeMessageReceived, TOPICS.bridgeDepositForBurn];

const lc = (a: string) => a.toLowerCase() as Address;

function dec<T>(abi: Abi, log: RawLog): { args: T } {
  const r = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
  return r as unknown as { args: T };
}

/** Decode one raw log. Returns undefined for unknown/malformed logs (never throws). */
export function decodeLog(log: RawLog): NormalizedEvent | undefined {
  const t0 = log.topics[0];
  if (!t0) return undefined;
  const emitter = lc(log.address);
  const base = { raw: log, emitter };
  try {
    switch (t0) {
      case TOPICS.transfer: {
        // ERC-721 Transfer shares topic0 but has 4 topics; ERC-20 has 3.
        if (log.topics.length !== 3) return undefined;
        const { args } = dec<{ from: Address; to: Address; value: bigint }>(erc20Abi, log);
        return { ...base, kind: 'transfer', token: emitter, from: lc(args.from), to: lc(args.to), value: args.value };
      }
      case TOPICS.v3PoolCreated: {
        const { args } = dec<{ token0: Address; token1: Address; fee: number; pool: Address }>(univ3FactoryAbi, log);
        return {
          ...base,
          kind: 'pool_created',
          dex: 'univ3',
          factory: emitter,
          pool: lc(args.pool),
          token0: lc(args.token0),
          token1: lc(args.token1),
          fee: Number(args.fee),
        };
      }
      case TOPICS.v2PairCreated: {
        const { args } = dec<{ token0: Address; token1: Address; pair: Address }>(univ2FactoryAbi, log);
        return {
          ...base,
          kind: 'pool_created',
          dex: 'univ2',
          factory: emitter,
          pool: lc(args.pair),
          token0: lc(args.token0),
          token1: lc(args.token1),
        };
      }
      case TOPICS.v3Swap: {
        const { args } = dec<{ sender: Address; recipient: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint }>(univ3PoolAbi, log);
        return {
          ...base,
          kind: 'swap',
          dex: 'univ3',
          pool: emitter,
          sender: lc(args.sender),
          recipient: lc(args.recipient),
          amount0: args.amount0,
          amount1: args.amount1,
          sqrtPriceX96: args.sqrtPriceX96,
        };
      }
      case TOPICS.v2Swap: {
        const { args } = dec<{ sender: Address; to: Address; amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint }>(univ2PairAbi, log);
        return {
          ...base,
          kind: 'swap',
          dex: 'univ2',
          pool: emitter,
          sender: lc(args.sender),
          recipient: lc(args.to),
          amount0: args.amount0In - args.amount0Out,
          amount1: args.amount1In - args.amount1Out,
        };
      }
      case TOPICS.v3Mint: {
        const { args } = dec<{ owner: Address; amount0: bigint; amount1: bigint }>(univ3PoolAbi, log);
        return { ...base, kind: 'mint', dex: 'univ3', pool: emitter, owner: lc(args.owner), amount0: args.amount0, amount1: args.amount1 };
      }
      case TOPICS.v3Burn: {
        const { args } = dec<{ owner: Address; amount0: bigint; amount1: bigint }>(univ3PoolAbi, log);
        return { ...base, kind: 'burn', dex: 'univ3', pool: emitter, owner: lc(args.owner), amount0: args.amount0, amount1: args.amount1 };
      }
      case TOPICS.v2Mint: {
        const { args } = dec<{ sender: Address; amount0: bigint; amount1: bigint }>(univ2PairAbi, log);
        return { ...base, kind: 'mint', dex: 'univ2', pool: emitter, owner: lc(args.sender), amount0: args.amount0, amount1: args.amount1 };
      }
      case TOPICS.v2Burn: {
        const { args } = dec<{ to: Address; amount0: bigint; amount1: bigint }>(univ2PairAbi, log);
        return { ...base, kind: 'burn', dex: 'univ2', pool: emitter, owner: lc(args.to), amount0: args.amount0, amount1: args.amount1 };
      }
      case TOPICS.v2Sync: {
        const { args } = dec<{ reserve0: bigint; reserve1: bigint }>(univ2PairAbi, log);
        return { ...base, kind: 'sync', pool: emitter, reserve0: args.reserve0, reserve1: args.reserve1 };
      }
      case TOPICS.padTokenCreated: {
        const { args } = dec<{ token: Address; creator: Address; name: string; symbol: string }>(genericPadAbi, log);
        return { ...base, kind: 'pad_token_created', adapter: 'generic', token: lc(args.token), creator: lc(args.creator), name: args.name, symbol: args.symbol };
      }
      case TOPICS.padGraduated: {
        const { args } = dec<{ token: Address; pool: Address; quoteRaised: bigint }>(genericPadAbi, log);
        return { ...base, kind: 'pad_graduated', token: lc(args.token), pool: lc(args.pool), quoteRaised: args.quoteRaised };
      }
      case TOPICS.bridgeMessageReceived: {
        const { args } = dec<{ caller: Address; sourceDomain: number; nonce: Hex; sender: Hex; finalityThresholdExecuted: number; messageBody: Hex }>(cctpMessageTransmitterAbi, log);
        return { ...base, kind: 'bridge_mint', caller: lc(args.caller), nonce: args.nonce, sourceDomain: Number(args.sourceDomain) };
      }
      case TOPICS.bridgeDepositForBurn: {
        const { args } = dec<{ burnToken: Address; amount: bigint; depositor: Address; mintRecipient: Hex; destinationDomain: number }>(cctpTokenMessengerAbi, log);
        return {
          ...base,
          kind: 'bridge_burn',
          burnToken: lc(args.burnToken),
          amount: args.amount,
          depositor: lc(args.depositor),
          mintRecipient: lc(`0x${args.mintRecipient.slice(26)}`),
          destinationDomain: Number(args.destinationDomain),
        };
      }
      default:
        return decodeAdapterLog(log);
    }
  } catch {
    return undefined;
  }
}

/** Parse an RPC-shaped log (hex quantities) into RawLog. */
export function parseRpcLog(l: {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | bigint | number;
  transactionHash: string;
  logIndex: string | number;
  blockTimestamp?: string | number;
  removed?: boolean;
}): RawLog {
  const q = (v: string | number | bigint): bigint =>
    typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : v.startsWith('0x') ? hexToBigInt(v as Hex) : BigInt(v);
  return {
    address: lc(l.address),
    topics: l.topics.map((t) => t.toLowerCase() as Hex),
    data: l.data as Hex,
    blockNumber: q(l.blockNumber),
    transactionHash: l.transactionHash.toLowerCase() as Hex,
    logIndex: Number(q(l.logIndex)),
    blockTimestamp: l.blockTimestamp === undefined ? undefined : Number(q(l.blockTimestamp)),
    removed: l.removed,
  };
}

export const logId = (l: RawLog) => `${l.transactionHash}:${l.logIndex}`;
