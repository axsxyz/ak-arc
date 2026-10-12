import type { Config } from '../config/env.js';
import type { WatchedContract } from '../config/watchlists.js';
import type { ChainReader } from './reader.js';

export class ChainMismatchError extends Error {}

/** Hard boot assertion: the RPC must be the chain the config says. */
export async function assertChain(reader: ChainReader, cfg: Config): Promise<number> {
  const id = await reader.chainId();
  if (id !== cfg.network.chainId) {
    throw new ChainMismatchError(
      `RPC chainId ${id} != expected ${cfg.network.chainId} for ARC_NETWORK=${cfg.network.name}. ` +
        (cfg.network.name === 'mainnet' ? 'You are pointing mainnet config at a non-mainnet RPC.' : 'Check ARC_TESTNET_HTTP_URL.'),
    );
  }
  return id;
}

export interface ProbeRow extends WatchedContract {
  codeBytes: number;
  chainId: number;
  status: 'OK' | 'MISSING_ON_CHAIN' | 'ERROR';
  error?: string;
}

export async function probeContracts(reader: ChainReader, chainId: number, contracts: WatchedContract[]): Promise<ProbeRow[]> {
  return Promise.all(
    contracts.map(async (c): Promise<ProbeRow> => {
      try {
        const code = await reader.getCode(c.address);
        const codeBytes = code && code !== '0x' ? (code.length - 2) / 2 : 0;
        return { ...c, codeBytes, chainId, status: codeBytes > 0 ? 'OK' : 'MISSING_ON_CHAIN' };
      } catch (e) {
        return { ...c, codeBytes: -1, chainId, status: 'ERROR', error: String((e as Error).message ?? e).split('\n')[0]!.slice(0, 80) };
      }
    }),
  );
}

/** Gate from the brief: fail if ALL critical majors are missing (errors count as missing). */
export function criticalMajorsAllMissing(rows: ProbeRow[]): boolean {
  const crit = rows.filter((r) => r.kind === 'major' && r.priority === 'critical');
  return crit.length > 0 && crit.every((r) => r.status !== 'OK');
}
