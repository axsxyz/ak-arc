import type { Address } from 'viem';

export type NetworkName = 'testnet' | 'mainnet';

export interface NetworkDef {
  name: NetworkName;
  chainId: number;
  label: string; // used in embed footers
  explorer: string;
  usdcMirror: Address; // ERC-20 USDC mirror (6 decimals — confirmed via decimals() at boot)
  nativeDecimals: number; // native gas balance is USDC with 18 decimals on Arc
  /** Logs Transfer for ALL USDC movement (mints/burns/native), not just calls through the ERC-20 interface. A CCTP
   * mint's Transfer(0x0 -> recipient) is emitted here, never at usdcMirror — verified on mainnet 2026-09-15. */
  usdcSystemEmitter?: Address;
}

export const NETWORKS: Record<NetworkName, NetworkDef> = {
  testnet: {
    name: 'testnet',
    chainId: 5042002,
    label: 'arc-testnet',
    explorer: 'https://testnet.arcscan.app',
    usdcMirror: '0x3600000000000000000000000000000000000000',
    nativeDecimals: 18,
  },
  mainnet: {
    name: 'mainnet',
    chainId: 5042,
    label: 'arc-mainnet',
    explorer: 'https://www.arcexplorer.org',
    usdcMirror: '0x3600000000000000000000000000000000000000',
    nativeDecimals: 18,
    usdcSystemEmitter: '0xfffffffffffffffffffffffffffffffffffffffe',
  },
};

export function isNetworkName(v: string): v is NetworkName {
  return v === 'testnet' || v === 'mainnet';
}
