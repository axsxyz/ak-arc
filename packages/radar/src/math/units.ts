import { formatUnits, parseUnits } from 'viem';

export const USDC_ERC20_DECIMALS = 6; // Arc ERC-20 mirror 0x3600…0000 (decimals() verified = 6 on testnet)
export const USDC_NATIVE_DECIMALS = 18; // native gas balance

/** Raw integer amount → decimal number. Precision is fine for USD display/thresholds (< 2^53 cents). */
export function toNumber(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

export function fromNumber(v: string | number, decimals: number): bigint {
  return parseUnits(typeof v === 'number' ? v.toString() : v, decimals);
}

/** Convert native 18-dec USDC to the 6-dec ERC-20 representation (truncates sub-micro dust). */
export function nativeToErc20Usdc(raw18: bigint): bigint {
  return raw18 / 10n ** BigInt(USDC_NATIVE_DECIMALS - USDC_ERC20_DECIMALS);
}

export function erc20ToNativeUsdc(raw6: bigint): bigint {
  return raw6 * 10n ** BigInt(USDC_NATIVE_DECIMALS - USDC_ERC20_DECIMALS);
}

export const abs = (x: bigint) => (x < 0n ? -x : x);
