import { decodeAbiParameters, decodeEventLog, toEventSelector, type Abi, type Address, type Hex } from 'viem';
import { LIFT_LAUNCH_DATA, LIFT_LAUNCH_TOPIC, radarAbi, tollyAbi, warpAbi } from '../abi/pads-mainnet.js';
import type { PadTokenCreatedEv, PadTradeEv, RawLog } from './types.js';

const lc = (a: string) => a.toLowerCase() as Address;
const topicAddr = (t: Hex | undefined) => (t ? lc(`0x${t.slice(26)}`) : undefined);

export const ADAPTER_TOPICS = {
  liftLaunch: LIFT_LAUNCH_TOPIC,
  tollyTokenCreated: toEventSelector('TokenCreated(address,address,string,string,address,string,string,string,string)'),
  radarTokenLaunched: toEventSelector('TokenLaunched(address,address,address,uint256,string,string)'),
  warpTokenCreated: toEventSelector('TokenCreated(address,address,address,string,string,string)'),
  warpTrade: toEventSelector('Trade(address,bool,uint256,uint256,uint256,uint256)'),
} as const;

export const ADAPTER_TOPIC_LIST: Hex[] = Object.values(ADAPTER_TOPICS);

function ev<T>(abi: Abi, log: RawLog): T {
  return (decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }) as unknown as { args: T }).args;
}

/**
 * Structural decode of mainnet launcher logs by topic0. Emitter authorization (is this address really
 * the Lift/Tolly/Radar/Warp launcher, is this curve really Warp's) is enforced by the pipeline.
 */
export function decodeAdapterLog(log: RawLog): PadTokenCreatedEv | PadTradeEv | undefined {
  const t0 = log.topics[0];
  const base = { raw: log, emitter: lc(log.address) };
  try {
    switch (t0) {
      case ADAPTER_TOPICS.liftLaunch: {
        if (log.topics.length !== 4) return undefined;
        const [quote, , , , , , initialBuyQuote, name, symbol] = decodeAbiParameters(LIFT_LAUNCH_DATA, log.data);
        return {
          ...base,
          kind: 'pad_token_created',
          adapter: 'lift',
          token: topicAddr(log.topics[1])!,
          creator: topicAddr(log.topics[2])!,
          pool: topicAddr(log.topics[3])!,
          quote: lc(quote),
          initialBuyQuoteRaw: initialBuyQuote,
          name,
          symbol,
        };
      }
      case ADAPTER_TOPICS.tollyTokenCreated: {
        const a = ev<{ token: Address; creator: Address; name: string; symbol: string; pool: Address }>(tollyAbi, log);
        return { ...base, kind: 'pad_token_created', adapter: 'tolly', token: lc(a.token), creator: lc(a.creator), pool: lc(a.pool), name: a.name, symbol: a.symbol };
      }
      case ADAPTER_TOPICS.radarTokenLaunched: {
        const a = ev<{ token: Address; creator: Address; pool: Address; name: string; symbol: string }>(radarAbi, log);
        return { ...base, kind: 'pad_token_created', adapter: 'radar', token: lc(a.token), creator: lc(a.creator), pool: lc(a.pool), name: a.name, symbol: a.symbol };
      }
      case ADAPTER_TOPICS.warpTokenCreated: {
        const a = ev<{ token: Address; curve: Address; creator: Address; name: string; symbol: string }>(warpAbi, log);
        return { ...base, kind: 'pad_token_created', adapter: 'warp', token: lc(a.token), creator: lc(a.creator), curve: lc(a.curve), name: a.name, symbol: a.symbol };
      }
      case ADAPTER_TOPICS.warpTrade: {
        const a = ev<{ trader: Address; isBuy: boolean; quoteAmount: bigint; tokenAmount: bigint }>(warpAbi, log);
        return { ...base, kind: 'pad_trade', adapter: 'warp', curve: base.emitter, trader: lc(a.trader), isBuy: a.isBuy, quoteRaw: a.quoteAmount, tokenRaw: a.tokenAmount };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
