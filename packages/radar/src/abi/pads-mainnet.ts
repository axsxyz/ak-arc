import { parseAbi, parseAbiParameters, type Hex } from 'viem';

/**
 * Arc MAINNET launcher ABIs, reverse-engineered 2026-09-14 from on-chain bytecode + real logs
 * (600k blocks via rpc.arc-scan.org) + public signature DB. Every topic below was observed on chain.
 * Parameter NAMES beyond the verified ones are placeholders (p*, meta*): only verified fields are consumed.
 *
 * Verified semantics:
 *  - Lift / Tolly / RadarDEX-launcher create a USDC-quoted pool on the canonical Uniswap V3 factory
 *    0xf0db…3918 in the same tx; the initial/dev buy is ALSO a V3 Swap on that pool, so InitialBuy/DevBuy
 *    events are informational only (never counted as volume).
 *  - Warp is a bonding curve: TokenCreated names a per-token curve; curves emit Trade whose quote amount
 *    is NATIVE USDC (18 decimals) — equals tx.value on direct buys; no 6-dec mirror transfer occurs.
 */

// ---- Lift factory 0x3f29…9153 ----
/** Unnamed launch event (not in signature DBs). topics: [t0, token, creator, pool]. */
export const LIFT_LAUNCH_TOPIC: Hex = '0x71582b1e394dd933fcf7022c7300634213054be56aacc2f5becdc88fd79d664e';
/** data: quote (USDC mirror), p1..p5 (tick/sqrtPrice/range/liquidity — unverified), initialBuyQuote (== InitialBuyExecuted amount), name, symbol, uri */
export const LIFT_LAUNCH_DATA = parseAbiParameters(
  'address quote, int256 p1, uint256 p2, int256 p3, int256 p4, uint256 p5, uint256 initialBuyQuote, string name, string symbol, string uri',
);
export const liftAbi = parseAbi(['event InitialBuyExecuted(address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokensOut)']);

// ---- TollyPad mainnet 0xcad7…8c9b (custom pad; testnet same CA is a UniV3 factory) ----
export const tollyAbi = parseAbi([
  'event TokenCreated(address indexed token, address indexed creator, string name, string symbol, address pool, string meta1, string meta2, string meta3, string meta4)',
  'event Launched(address indexed token, address indexed pool, uint256 p0, uint128 p1, uint256 p2)',
  'event DevBuy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokensOut)',
]);

// ---- RadarDEX token launcher 0x4B63…C93a ----
export const radarAbi = parseAbi([
  'event TokenLaunched(address indexed token, address indexed creator, address pool, uint256 p0, string name, string symbol)',
  'event InitialBuy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokensOut)',
]);

// ---- Warp launch factory proxy 0x0dCa…1255 + per-token bonding curves ----
export const warpAbi = parseAbi([
  'event TokenCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadata)',
  /** emitted by the curve; quoteAmount = native USDC (18 dec), tokenAmount = token (18 dec); p2/p3 unverified */
  'event Trade(address indexed trader, bool indexed isBuy, uint256 quoteAmount, uint256 tokenAmount, uint256 p2, uint256 p3)',
]);
export const WARP_QUOTE_DECIMALS = 18;
/** Curves expose factory() == launch proxy and token(). Used to lazily verify curves created before boot. */
export const warpCurveAbi = parseAbi(['function factory() view returns (address)', 'function token() view returns (address)']);
