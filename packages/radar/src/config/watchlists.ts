import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { getAddress, isAddress, type Address } from 'viem';
import type { NetworkName } from './networks.js';

const addr = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), 'invalid address')
  .transform((v) => v.toLowerCase() as Address);
const nullableAddr = z.union([addr, z.null()]).optional().transform((v) => v ?? null);
const priority = z.enum(['critical', 'high', 'medium', 'low']).default('medium');

const majorSchema = z.object({
  tokens: z
    .array(
      z.object({
        symbol: z.string(),
        address: addr,
        decimals: z.number().int().optional(),
        /** Optional token creation block (skips the archive binary search for the holders backfill). */
        created_block: z.number().int().nonnegative().optional(),
        priority,
        venues: z.array(z.string()).optional(),
        pair_hint: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .nullable()
    .default([])
    .transform((v) => v ?? []),
});

const padTokenSchema = z.object({
  tokens: z
    .array(z.object({ symbol: z.string(), address: addr, pad: z.string() }))
    .nullable()
    .default([])
    .transform((v) => v ?? []),
});

/**
 * Adapter kind per contract.
 *  univ2 / univ3  AMM factories (pool provenance roots for the ping gate)
 *  lift / tolly / warp / radar  mainnet launcher adapters (src/decode/adapters.ts)
 *  generic        placeholder TokenCreated/Graduated ABI (src/abi/pads.ts)
 *  todo           code verified but no decoder yet: probed, never trusted, never decoded
 */
export const VENUE_KINDS = ['univ3', 'univ2', 'generic', 'lift', 'tolly', 'warp', 'radar', 'todo'] as const;
const venueKind = z.enum(VENUE_KINDS);
export type VenueKind = z.infer<typeof venueKind>;

/** launch = pools/tokens it creates are launches (NEW_LAUNCH); amm = liquidity venue; migration = post-graduation pools. */
const factoryRole = z.enum(['launch', 'amm', 'migration']);
const factoryEntry = z.object({
  address: addr,
  kind: venueKind,
  role: factoryRole.optional(),
  label: z.string().optional(),
});

const venueFields = {
  factory: nullableAddr, // legacy single factory (+ kind)
  router: nullableAddr,
  bonding: nullableAddr,
  kind: venueKind.optional(),
  factories: z.array(factoryEntry).optional(),
  routers: z.array(addr).optional(),
  /** Verified auxiliary contracts (fee lockers, vaults, impls): probed only. */
  aux: z.record(z.string(), addr).optional(),
};
/** Same CA can be a different contract per chain (e.g. TollyPad: V3 factory on testnet, custom pad on mainnet). */
const networkOverride = z.object(venueFields).partial();
const networksField = z.partialRecord(z.enum(['testnet', 'mainnet']), networkOverride).optional();

const venueBase = z.object({
  name: z.string(),
  url: z.string().optional(),
  ...venueFields,
  networks: networksField,
  priority,
  notes: z.string().optional(),
});

const padSchema = venueBase.extend({
  example_token_page: z.string().optional(),
  pad_token: nullableAddr,
  graduate_event: z.string().optional(),
});

const dexSchema = venueBase.extend({ example_pair_or_token: z.string().optional() });

const launchpadSchema = z.object({
  pads: z.array(padSchema).nullable().default([]).transform((v) => v ?? []),
  dex: z.array(dexSchema).nullable().default([]).transform((v) => v ?? []),
});

const walletSchema = z.object({
  wallets: z
    .array(z.object({ address: addr, label: z.string(), tags: z.array(z.string()).default([]) }))
    .nullable()
    .default([])
    .transform((v) => v ?? []),
});

const infraSchema = z
  .object({
    explorer: z.object({ name: z.string(), url: z.string() }).partial().optional(),
    bridge: z
      .array(
        z.object({
          name: z.string(),
          url: z.string().optional(),
          watch: z.boolean().default(true),
          channel: z.string().optional(),
          contracts: z.array(addr).optional(),
          note: z.string().optional(),
        }),
      )
      .optional()
      .default([]),
    usdc: z.object({ erc20_mirror: addr }).partial().optional(),
    /** CCTP V2 contracts on THIS chain — drives BRIDGE_INFLOW (MessageTransmitter) and BRIDGE_OUTFLOW (TokenMessenger). */
    cctp: z
      .object({
        message_transmitter: nullableAddr,
        token_messenger: nullableAddr,
        local_minter: nullableAddr,
        /** Fallback sourceDomain label when MessageReceived's own field isn't decoded (best-effort ABI; see decode/index.ts). */
        source_domain: z.number().int().nonnegative().optional(),
        source_domain_label: z.string().optional(),
        note: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

export type MajorToken = z.infer<typeof majorSchema>['tokens'][number];
export type PadToken = z.infer<typeof padTokenSchema>['tokens'][number];
export type FactoryEntry = { address: Address; kind: VenueKind; role: 'launch' | 'amm' | 'migration'; label?: string };
/** Network-resolved venue: `factories`/`routers` are the only fields runtime code should use. */
type Resolved<T> = Omit<T, 'factories' | 'routers' | 'networks'> & { factories: FactoryEntry[]; routers: Address[]; aux: Record<string, Address> };
export type Pad = Resolved<z.infer<typeof padSchema>>;
export type Dex = Resolved<z.infer<typeof dexSchema>>;
export type Wallet = z.infer<typeof walletSchema>['wallets'][number];
export type Infra = z.infer<typeof infraSchema>;

export interface Watchlists {
  majors: MajorToken[];
  padTokens: PadToken[];
  pads: Pad[];
  dex: Dex[];
  wallets: Wallet[];
  infra: Infra;
}

export interface WatchedContract {
  address: Address;
  symbol: string;
  kind: 'major' | 'pad-token' | 'factory' | 'router' | 'bonding' | 'aux' | 'usdc';
  priority: string;
  owner?: string;
}

function readYaml<S extends z.ZodType>(dir: string, file: string, s: S, fallback: unknown): z.output<S> {
  const p = path.join(dir, file);
  const raw = fs.existsSync(p) ? parse(fs.readFileSync(p, 'utf8')) ?? fallback : fallback;
  const r = s.safeParse(raw);
  if (!r.success) {
    throw new Error(`watchlist ${file}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

type RawVenue = z.infer<typeof padSchema> | z.infer<typeof dexSchema>;

/** Merge the network override, then normalize legacy factory/bonding/router into factories[]/routers[]. */
function resolveVenue<T extends RawVenue>(v: T, network: NetworkName, section: 'pad' | 'dex'): Resolved<T> {
  const o = v.networks?.[network] ?? {};
  const merged: Record<string, unknown> = { ...v };
  for (const [k, val] of Object.entries(o)) if (val !== undefined) merged[k] = val;
  const m = merged as T;
  let factories: FactoryEntry[];
  if (m.factories) {
    factories = m.factories.map((f) => ({ ...f, role: f.role ?? (f.kind === 'univ2' || f.kind === 'univ3' ? 'amm' : 'launch') }));
  } else {
    factories = [];
    // Legacy form: a pad's own AMM factory creates its launches; a dex factory is liquidity.
    const kind = m.kind ?? (section === 'pad' ? 'generic' : 'univ2');
    if (m.factory) factories.push({ address: m.factory, kind, role: section === 'pad' ? 'launch' : 'amm' });
    if (m.bonding) factories.push({ address: m.bonding, kind: m.kind ?? 'generic', role: 'launch' });
  }
  const routers = [...new Set([...(m.routers ?? []), ...(m.router ? [m.router] : [])])];
  const { networks: _n, ...rest } = m;
  return { ...rest, factories, routers, aux: m.aux ?? {} } as Resolved<T>;
}

export function loadWatchlists(dir: string, network: NetworkName): Watchlists {
  const raw = readYaml(dir, 'launchpads.yaml', launchpadSchema, { pads: [] });
  const lp = { pads: raw.pads.map((p) => resolveVenue(p, network, 'pad')), dex: raw.dex.map((d) => resolveVenue(d, network, 'dex')) };
  return {
    majors: readYaml(dir, 'major-coins.yaml', majorSchema, { tokens: [] }).tokens,
    padTokens: readYaml(dir, 'pad-tokens.yaml', padTokenSchema, { tokens: [] }).tokens,
    pads: lp.pads,
    dex: lp.dex,
    wallets: readYaml(dir, 'wallets.yaml', walletSchema, { wallets: [] }).wallets,
    infra: readYaml(dir, 'infra.yaml', infraSchema, {}),
  };
}

/** Every CA the radar depends on, for the boot getCode probe. Deduped by address (first wins). */
export function watchedContracts(w: Watchlists, usdcMirror: Address): WatchedContract[] {
  const out = new Map<string, WatchedContract>();
  const add = (c: WatchedContract) => {
    if (!out.has(c.address)) out.set(c.address, c);
  };
  add({ address: usdcMirror.toLowerCase() as Address, symbol: 'USDC', kind: 'usdc', priority: 'critical' });
  for (const t of w.majors) add({ address: t.address, symbol: t.symbol, kind: 'major', priority: t.priority });
  for (const t of w.padTokens) add({ address: t.address, symbol: t.symbol, kind: 'pad-token', priority: 'high', owner: t.pad });
  for (const p of [...w.pads, ...w.dex]) {
    for (const f of p.factories) add({ address: f.address, symbol: `${p.name}:${f.label ?? f.kind}`, kind: 'factory', priority: p.priority, owner: p.name });
    for (const r of p.routers) add({ address: r, symbol: `${p.name}:router`, kind: 'router', priority: p.priority, owner: p.name });
    for (const [k, a] of Object.entries(p.aux)) add({ address: a, symbol: `${p.name}:${k}`, kind: 'aux', priority: 'low', owner: p.name });
  }
  const cctp = w.infra.cctp;
  if (cctp?.message_transmitter) add({ address: cctp.message_transmitter, symbol: 'CCTP:message_transmitter', kind: 'aux', priority: 'critical', owner: 'CCTP' });
  if (cctp?.token_messenger) add({ address: cctp.token_messenger, symbol: 'CCTP:token_messenger', kind: 'aux', priority: 'critical', owner: 'CCTP' });
  return [...out.values()];
}

/** Watch the directory; debounce and invoke onChange with fresh lists. Invalid YAML keeps the previous lists. */
export function watchWatchlists(dir: string, network: NetworkName, onChange: (w: Watchlists) => void, onError: (e: unknown) => void): () => void {
  let t: NodeJS.Timeout | undefined;
  const watcher = fs.watch(dir, () => {
    clearTimeout(t);
    t = setTimeout(() => {
      try {
        onChange(loadWatchlists(dir, network));
      } catch (e) {
        onError(e);
      }
    }, 500);
  });
  return () => {
    clearTimeout(t);
    watcher.close();
  };
}

export const checksum = (a: string) => getAddress(a);
