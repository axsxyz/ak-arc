import type { Address } from 'viem';
import type { Wallet } from '../config/watchlists.js';

export class WalletBook {
  private byAddr = new Map<string, Wallet>();
  constructor(wallets: Wallet[]) {
    for (const w of wallets) this.byAddr.set(w.address.toLowerCase(), w);
  }
  get size() {
    return this.byAddr.size;
  }
  get(a: string | undefined): Wallet | undefined {
    return a ? this.byAddr.get(a.toLowerCase()) : undefined;
  }
  firstMatch(addrs: (string | undefined)[]): Wallet | undefined {
    for (const a of addrs) {
      const w = this.get(a);
      if (w) return w;
    }
    return undefined;
  }
}

/** First observed USDC funder per address (bounded). Fed from USDC mirror Transfers the radar subscribes to. */
export class FunderMap {
  private m = new Map<Address, Address>();
  constructor(private readonly max = 100_000) {}
  onUsdcTransfer(from: Address, to: Address) {
    if (this.m.has(to)) return;
    if (this.m.size >= this.max) {
      const first = this.m.keys().next().value;
      if (first) this.m.delete(first);
    }
    this.m.set(to, from);
  }
  funderOf(a: Address) {
    return this.m.get(a);
  }
}

/** Group buyers by common funder; return clusters with >= minSize members. */
export function clusterByFunder(
  buyers: Address[],
  funderOf: (a: Address) => Address | undefined,
  minSize: number,
): { funder: Address; members: Address[] }[] {
  const groups = new Map<Address, Address[]>();
  for (const b of new Set(buyers)) {
    const f = funderOf(b);
    if (!f) continue;
    const g = groups.get(f) ?? [];
    g.push(b);
    groups.set(f, g);
  }
  return [...groups.entries()].filter(([, m]) => m.length >= minSize).map(([funder, members]) => ({ funder, members }));
}
