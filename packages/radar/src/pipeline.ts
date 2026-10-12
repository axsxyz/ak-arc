import { zeroAddress, type Address, type Hex } from 'viem';
import type { Clock } from './clock.js';
import type { Config } from './config/env.js';
import type { Watchlists } from './config/watchlists.js';
import { decodeLog, logId } from './decode/index.js';
import type {
  BridgeBurnEv,
  BridgeMintEv,
  LiquidityEv,
  NormalizedEvent,
  PadGraduatedEv,
  PadTokenCreatedEv,
  PadTradeEv,
  PoolCreatedEv,
  RawLog,
  SwapEv,
  SyncEv,
  TransferEv,
} from './decode/types.js';
import type { RouteResult, Router } from './discord/router.js';
import { addrLink, fmtPct, fmtUsd, truncAddr } from './discord/embeds.js';
import { HolderTracker } from './features/holders.js';
import { signalLp, signalMcap, signalVelocity } from './features/signal-metrics.js';
import { MajorState } from './features/majors.js';
import { PadStats } from './features/pads.js';
import { PoolRegistry, type FactoryInfo, type PoolState } from './features/pools.js';
import { clusterByFunder, FunderMap, WalletBook } from './features/wallets.js';
import { MinuteBuckets } from './features/volume.js';
import { SeenSet } from './ingest/dedupe.js';
import type { Logger } from './log.js';
import { abs, toNumber, USDC_ERC20_DECIMALS, USDC_NATIVE_DECIMALS } from './math/units.js';
import { mcap as mcapOf, reservesPriceUsd, v3TokenPriceUsd, velocity } from './math/price.js';
import type { ChainReader } from './rpc/reader.js';
import { evaluateLp, type LpVerdict } from './score/rules/lp.js';
import { evaluateMigrate, type MigrateWatch } from './score/rules/migrate.js';
import { isWalletFast } from './score/rules/wallet.js';
import type { Field, Signal } from './score/types.js';

export interface PipelineDeps {
  cfg: Config;
  watchlists: Watchlists;
  reader: ChainReader;
  router: Router;
  clock: Clock;
  log: Logger;
  onRawEvent?: (ev: NormalizedEvent, eventTimeMs: number) => void; // cold path hook (non-blocking)
  onPoolResolved?: (p: PoolState) => void; // cold path hook (pool_meta cache, non-blocking)
}

const lc = (a: string) => a.toLowerCase() as Address;

export class Pipeline {
  readonly pools: PoolRegistry;
  readonly majors = new Map<string, MajorState>();
  readonly pads = new Map<string, PadStats>();
  readonly holders = new Map<string, HolderTracker>();
  readonly results: RouteResult[] = [];
  private seen = new SeenSet(200_000);
  private queue: Promise<void> = Promise.resolve();
  private factories = new Map<string, FactoryInfo>();
  /** Launcher contracts (non-AMM factories) -> pad + adapter. Only these emitters may produce launch events. */
  private launchers = new Map<string, { pad: string; kind: string }>();
  /** Warp-style bonding curves -> pad/token. trusted = learned from an authorized TokenCreated. */
  private curves = new Map<string, { pad: string; token: Address; createdAtMs?: number; trusted: boolean; usdIn: number }>();
  private rejectedCurves = new SeenSet(50_000);
  private padTokens = new Map<string, string>(); // pad protocol token -> pad name
  private wallets: WalletBook;
  private funders = new FunderMap();
  private bridges = new Map<string, string>();
  /** CCTP contracts on this chain, from config/watchlists/infra.yaml's cctp block. */
  private cctp?: { transmitter?: Address; tokenMessenger?: Address; sourceDomainDefault?: number; sourceDomainLabel?: string };
  /** MessageReceived.sourceDomain by tx hash, consumed by the paired USDC mint Transfer (either can arrive first over WS). Small bounded cache — falls back to cctp.sourceDomainDefault if evicted or never decoded. */
  private mintDomainByTx = new Map<Hex, number>();
  /** Wallets that just received a large bridged arrival, watched for BRIDGE_DEPLOY until they expire. */
  private followedWallets = new Map<Address, { arrivedAtMs: number; arrivedUsd: number; expiresAtMs: number }>();
  private lastInflowMs?: number;
  private bridgeInflow = new MinuteBuckets();
  private bridgeOutflow = new MinuteBuckets();
  private migrateWatches = new Map<string, MigrateWatch>(); // pool -> watch
  private graduatedPools = new Map<string, string>(); // post-migration pool -> pad (vol attribution)
  private usdcDecimals = USDC_ERC20_DECIMALS;
  /** Watchlist CAs with no code on this chain — excluded from loops (set by boot probe). */
  readonly missing = new Set<string>();
  lastBlock?: bigint;
  /** Earliest time the in-memory windows are complete from (boot, or warm-start history start). Digests show n/a for windows before it. */
  coverageFromMs: number;
  /** Observability counters (logged with the heartbeat). */
  readonly stats = { logs: 0, duplicates: 0, undecoded: 0, byKind: {} as Record<string, number> };

  constructor(private readonly d: PipelineDeps) {
    this.coverageFromMs = d.clock.now();
    this.wallets = new WalletBook([]);
    this.pools = new PoolRegistry(
      d.reader,
      this.factories,
      d.cfg.usdcMirror,
      () => this.usdcDecimals,
      Math.max(d.cfg.thresholds.lpWindowSec, 600) * 1000,
    );
    this.pools.onResolved = d.onPoolResolved;
    this.applyWatchlists(d.watchlists);
  }

  /** Confirm USDC mirror decimals on this chain (never assume). */
  async init() {
    const meta = await this.d.reader.erc20Meta(this.d.cfg.usdcMirror);
    if (meta.decimals !== undefined && meta.decimals !== this.usdcDecimals) {
      this.d.log.warn({ decimals: meta.decimals }, 'USDC mirror decimals differ from 6; using on-chain value');
      this.usdcDecimals = meta.decimals;
    }
    return this.usdcDecimals;
  }

  get watchlists() {
    return this.d.watchlists;
  }

  applyWatchlists(w: Watchlists) {
    this.d.watchlists = w;
    const f = new Map<string, FactoryInfo>();
    this.launchers.clear();
    for (const v of [...w.pads, ...w.dex]) {
      for (const fe of v.factories) {
        if (fe.kind === 'univ2' || fe.kind === 'univ3') f.set(fe.address, { name: v.name, kind: fe.kind, role: fe.role });
        else if (fe.kind !== 'todo') this.launchers.set(fe.address, { pad: v.name, kind: fe.kind });
        if (fe.role !== 'amm' && fe.kind !== 'todo' && !this.pads.has(v.name)) this.pads.set(v.name, new PadStats(v.name));
      }
    }
    for (const p of w.pads) if (!this.pads.has(p.name)) this.pads.set(p.name, new PadStats(p.name));
    this.factories = f;
    this.pools.setFactories(f);
    this.wallets = new WalletBook(w.wallets);
    this.padTokens = new Map(w.padTokens.map((t) => [t.address, t.pad]));
    for (const t of w.majors) {
      if (!this.majors.has(t.address)) this.majors.set(t.address, new MajorState(t.address, t.symbol));
      if (!this.holders.has(t.address)) this.holders.set(t.address, new HolderTracker(false));
    }
    this.bridges.clear();
    for (const b of w.infra.bridge ?? []) for (const c of b.contracts ?? []) this.bridges.set(c, b.name);
    const c = w.infra.cctp;
    this.cctp = c?.message_transmitter || c?.token_messenger
      ? { transmitter: c.message_transmitter ?? undefined, tokenMessenger: c.token_messenger ?? undefined, sourceDomainDefault: c.source_domain, sourceDomainLabel: c.source_domain_label }
      : undefined;
  }

  /** CCTP MessageTransmitter/TokenMessenger addresses to subscribe (address-filtered, see decode.CCTP_TOPICS). */
  cctpAddresses(): Address[] {
    const set = new Set<Address>();
    if (this.cctp?.transmitter) set.add(this.cctp.transmitter);
    if (this.cctp?.tokenMessenger) set.add(this.cctp.tokenMessenger);
    return [...set];
  }

  /** Allowlisted AMM factories (pool provenance roots). */
  ammFactories(): { address: Address; kind: 'univ2' | 'univ3' }[] {
    return [...this.factories.entries()].map(([address, f]) => ({ address: address as Address, kind: f.kind }));
  }

  /** Every factory/router/aux/launcher CA from the watchlists (never counted as a "holder" in top10%). */
  venueContracts(): Set<string> {
    const out = new Set<string>();
    for (const v of [...this.d.watchlists.pads, ...this.d.watchlists.dex]) {
      for (const f of v.factories) out.add(f.address);
      for (const r of v.routers) out.add(r);
      for (const a of Object.values(v.aux)) out.add(a);
    }
    for (const c of this.curves.keys()) out.add(c);
    return out;
  }

  /** Addresses whose Transfer logs we subscribe to (on-chain majors + pad tokens + bridges' USDC + the CCTP mint side). */
  transferAddresses(): Address[] {
    const set = new Set<Address>();
    for (const t of this.d.watchlists.majors) if (!this.missing.has(t.address)) set.add(t.address);
    for (const t of this.d.watchlists.padTokens) if (!this.missing.has(t.address)) set.add(t.address);
    if (this.bridges.size) set.add(lc(this.d.cfg.usdcMirror));
    // A CCTP mint's Transfer(0x0 -> recipient) is logged by the chain's system emitter, never by usdcMirror.
    if (this.cctp?.transmitter && this.d.cfg.network.usdcSystemEmitter) set.add(lc(this.d.cfg.network.usdcSystemEmitter));
    return [...set];
  }

  /** Serialize processing: WS and backfill both enqueue here. */
  enqueue(logs: RawLog[]): Promise<void> {
    this.queue = this.queue.then(async () => {
      await this.prefetchPools(logs);
      for (const l of logs) {
        try {
          await this.handleRaw(l);
        } catch (e) {
          this.d.log.error({ err: String((e as Error).stack ?? e), log: logId(l) }, 'pipeline error');
        }
      }
    });
    return this.queue;
  }

  /**
   * Resolve metadata/trust for pools first seen in this batch IN PARALLEL (bounded by the RPC limiter), so the
   * strictly-ordered processing loop below doesn't do one slow RPC round-trip per new pool (warm start, backfills).
   */
  private async prefetchPools(logs: RawLog[]) {
    if (logs.length < 2) return;
    const created = new Set<string>();
    const todo = new Map<Address, 'univ2' | 'univ3'>();
    for (const l of logs) {
      const ev = decodeLog(l);
      if (!ev) continue;
      if (ev.kind === 'pool_created') created.add(ev.pool);
      else if ((ev.kind === 'swap' || ev.kind === 'mint' || ev.kind === 'burn') && !this.pools.get(ev.pool) && !created.has(ev.pool)) todo.set(ev.pool, ev.dex);
    }
    if (!todo.size) return;
    await Promise.all([...todo].map(([pool, dex]) => this.pools.ensure(pool, dex).catch(() => undefined)));
  }

  idle() {
    return this.queue;
  }

  private async handleRaw(l: RawLog) {
    if (l.removed) return; // Arc has instant finality; ignore reorg notifications defensively.
    this.stats.logs++;
    if (!this.seen.add(logId(l))) {
      this.stats.duplicates++;
      return;
    }
    const ev = decodeLog(l);
    if (!ev) {
      this.stats.undecoded++;
      return;
    }
    this.stats.byKind[ev.kind] = (this.stats.byKind[ev.kind] ?? 0) + 1;
    if (this.lastBlock === undefined || l.blockNumber > this.lastBlock) this.lastBlock = l.blockNumber;
    const t = await this.eventTime(l);
    this.d.onRawEvent?.(ev, t);
    switch (ev.kind) {
      case 'pool_created':
        return this.onPoolCreated(ev, t);
      case 'pad_token_created':
        return this.onPadTokenCreated(ev, t);
      case 'pad_graduated':
        return this.onGraduated(ev, t);
      case 'pad_trade':
        return this.onPadTrade(ev, t);
      case 'swap':
        return this.onSwap(ev, t);
      case 'mint':
      case 'burn':
        return this.onLiquidity(ev, t);
      case 'sync':
        return this.onSync(ev);
      case 'transfer':
        return this.onTransfer(ev, t);
      case 'bridge_mint':
        return this.onBridgeMint(ev, t);
      case 'bridge_burn':
        return this.onBridgeBurn(ev, t);
    }
  }

  private async eventTime(l: RawLog): Promise<number> {
    const ts = l.blockTimestamp ?? (await this.d.reader.blockTimestamp(l.blockNumber));
    return ts !== undefined ? ts * 1000 : this.d.clock.now();
  }

  private async emit(s: Signal) {
    const r = await this.d.router.route(s);
    this.results.push(r);
    if (this.results.length > 1000) this.results.splice(0, this.results.length - 1000);
    return r;
  }

  private async symbolOf(token: Address | undefined): Promise<string | undefined> {
    if (!token) return undefined;
    const w = this.d.watchlists.majors.find((m) => m.address === token) ?? this.d.watchlists.padTokens.find((m) => m.address === token);
    if (w) return w.symbol;
    return (await this.d.reader.erc20Meta(token)).symbol;
  }

  /** Pad a pool's volume belongs to: launched on the pad, or the pad's post-graduation pool. */
  private padOf(p: PoolState): string | undefined {
    return p.padName ?? this.graduatedPools.get(p.pool);
  }

  private async lpOf(p: PoolState): Promise<number | undefined> {
    if (p.usdcSide === undefined) return undefined; // non-USDC pool: never price its liquidity
    return signalLp(await this.d.reader.balanceOf(this.d.cfg.usdcMirror, p.pool), p.usdcDecimals, true);
  }

  private specialty(p: PoolState) {
    if (this.padOf(p)) return 'launchpads' as const;
    if (p.token && this.majors.has(p.token)) return 'major-coins' as const;
    return undefined;
  }

  // ---------------- handlers ----------------

  private async onPoolCreated(ev: PoolCreatedEv, t: number) {
    const p = await this.pools.onCreated({ ...ev, t, block: ev.raw.blockNumber });
    if (!p.padName || this.factories.get(ev.factory)?.role !== 'launch') return; // tracked, not posted
    const stats = this.pads.get(p.padName);
    const launched = p.token ?? p.token0!;
    stats?.onLaunch(t, launched);
    await this.emit({
      type: 'NEW_LAUNCH',
      channel: 'launchpads',
      severity: 'info',
      dedupeKey: `LAUNCH|${launched}`,
      eventTimeMs: t,
      pool: p.pool,
      evidence: { usdCertain: p.usdcSide !== undefined, trusted: p.trusted },
      token: { address: launched, symbol: await this.symbolOf(launched) },
      venue: `${p.padName} (${p.dex}${p.fee !== undefined ? ` fee ${p.fee}` : ''})`,
      txHash: ev.raw.transactionHash,
      title: `NEW_LAUNCH · ${p.padName}`,
      extraFields: [
        { name: 'pool', value: addrLink(this.d.cfg.network, p.pool), inline: true },
        { name: 'quote', value: p.usdcSide !== undefined ? 'USDC' : 'non-USDC (usd uncertain)', inline: true },
      ],
    });
  }

  private async onPadTokenCreated(ev: PadTokenCreatedEv, t: number) {
    const launcher = this.launchers.get(ev.emitter);
    // Launch topics are spoofable: only the allowlisted launcher for THIS adapter counts.
    if (!launcher || launcher.kind !== ev.adapter) return;
    const pad = launcher.pad;
    this.pads.get(pad)?.onLaunch(t, ev.token);
    let pool: PoolState | undefined;
    if (ev.pool) {
      pool = await this.pools.ensure(ev.pool, 'univ3'); // Lift/Tolly/Radar launch into canonical UniV3 pools
      this.pools.attributePad(pool, pad, t, ev.raw.blockNumber);
    }
    if (ev.curve) this.curves.set(ev.curve, { pad, token: ev.token, createdAtMs: t, trusted: true, usdIn: 0 });
    const net = this.d.cfg.network;
    const extra = [
      ...(ev.name ? [{ name: 'name', value: ev.name.slice(0, 64), inline: true }] : []),
      { name: 'creator', value: addrLink(net, ev.creator), inline: true },
    ];
    if (pool) extra.push({ name: 'pool', value: addrLink(net, pool.pool), inline: true }, { name: 'pool trust', value: pool.trusted ? `verified (${pool.factory ? truncAddr(pool.factory) : 'factory'})` : 'unverified factory', inline: true });
    if (ev.curve) extra.push({ name: 'curve', value: addrLink(net, ev.curve), inline: true });
    await this.emit({
      type: 'NEW_LAUNCH',
      channel: 'launchpads',
      severity: 'info',
      dedupeKey: `LAUNCH|${ev.token}`,
      eventTimeMs: t,
      pool: pool?.pool ?? ev.curve,
      evidence: { usdCertain: pool ? pool.usdcSide !== undefined : ev.adapter === 'warp', trusted: pool ? pool.trusted : true },
      token: { address: ev.token, symbol: ev.symbol },
      venue: `${pad}${ev.adapter !== 'generic' ? ` (${ev.adapter})` : ''}`,
      usd: ev.initialBuyQuoteRaw !== undefined && pool?.usdcSide !== undefined ? toNumber(ev.initialBuyQuoteRaw, pool.usdcDecimals) : undefined,
      lp: pool ? await this.lpOf(pool) : undefined,
      txHash: ev.raw.transactionHash,
      title: `NEW_LAUNCH · ${pad}`,
      extraFields: extra,
    });
  }

  /** Warp bonding-curve trade. Quote is native USDC (18 dec, verified vs tx.value on mainnet). */
  private async onPadTrade(ev: PadTradeEv, t: number) {
    let c = this.curves.get(ev.emitter);
    if (!c) {
      if (this.rejectedCurves.has(ev.emitter)) return;
      // Curve created before we started: accept only if it names an allowlisted Warp launcher; never trusted for pings.
      const info = await this.d.reader.curveInfo(ev.emitter);
      const launcher = info.factory ? this.launchers.get(info.factory) : undefined;
      if (!launcher || launcher.kind !== ev.adapter || !info.token) {
        this.rejectedCurves.add(ev.emitter);
        return;
      }
      c = { pad: launcher.pad, token: info.token, trusted: false, usdIn: 0 };
      this.curves.set(ev.emitter, c);
    }
    const usd = toNumber(ev.quoteRaw, this.d.cfg.network.nativeDecimals);
    const meta = await this.d.reader.erc20Meta(c.token);
    const tokenDec = meta.decimals ?? 18;
    const tokens = toNumber(ev.tokenRaw, tokenDec);
    const price = tokens > 0 ? usd / tokens : undefined;
    const stats = this.pads.get(c.pad);
    stats?.vol.add(t, usd);
    if (ev.isBuy) c.usdIn += usd;
    const mc = signalMcap(price, meta.totalSupply, meta.decimals === undefined ? undefined : tokenDec);
    if (mc !== undefined) stats?.onMcap(t, c.token, mc, this.d.cfg.thresholds.padTimeToUsd);
    this.majors.get(c.token)?.onSwap(t, usd, ev.isBuy, price, ev.curve);

    if (ev.isBuy && this.followedWallets.has(ev.trader)) {
      await this.checkBridgeDeploy({ trader: ev.trader, t, token: c.token, symbol: meta.symbol, venue: `${c.pad} curve`, usd, txHash: ev.raw.transactionHash });
    }

    if (!this.wallets.size) return;
    const wallet = this.wallets.firstMatch([ev.trader]) ?? (ev.isBuy && c.createdAtMs !== undefined && t - c.createdAtMs <= this.d.cfg.thresholds.walletAgeSec * 1000
      ? this.wallets.get(await this.d.reader.txFrom(ev.raw.transactionHash))
      : undefined);
    if (!wallet) return;
    const ageMs = c.createdAtMs !== undefined ? t - c.createdAtMs : undefined;
    const fast = isWalletFast({ isBuy: ev.isBuy, usd, poolAgeMs: ageMs, maxAgeSec: this.d.cfg.thresholds.walletAgeSec, minUsd: this.d.cfg.thresholds.walletBuyUsd });
    await this.emit({
      type: fast ? 'WATCHLIST_WALLET_FAST' : 'WALLET_ACTIVITY',
      hardRule: fast ? 'WATCHLIST_WALLET_FAST' : undefined,
      channel: fast ? 'alerts' : 'smart-flow',
      fallbackChannel: 'smart-flow',
      severity: fast ? 'alert' : 'watch',
      dedupeKey: `WALLET|${wallet.address}|${ev.curve}|${ev.isBuy ? 'buy' : 'sell'}`,
      eventTimeMs: t,
      pool: ev.curve,
      evidence: { usdCertain: true, trusted: c.trusted },
      token: { address: c.token, symbol: meta.symbol },
      venue: `${c.pad} curve`,
      usd,
      // Only meaningful when we saw the curve's birth (usdIn counts from there); pre-boot curves → omitted.
      velocity: signalVelocity(c.createdAtMs !== undefined ? c.usdIn : undefined, c.createdAtMs, t),
      mcap: mc,
      txHash: ev.raw.transactionHash,
      title: `${fast ? 'WATCHLIST_WALLET_FAST' : 'WALLET_ACTIVITY'} · ${wallet.label}`,
      extraFields: [
        { name: 'wallet', value: addrLink(this.d.cfg.network, wallet.address, wallet.label), inline: true },
        { name: 'side', value: ev.isBuy ? 'buy' : 'sell', inline: true },
        ...(ageMs !== undefined ? [{ name: 'curve age', value: `${(ageMs / 1000).toFixed(0)}s`, inline: true }] : []),
      ],
    });
  }

  private async onGraduated(ev: PadGraduatedEv, t: number) {
    const launcher = this.launchers.get(ev.emitter);
    if (!launcher || launcher.kind !== 'generic') return; // placeholder ABI: generic pads only
    const pad = launcher.pad;
    this.pads.get(pad)?.onGraduate(t, ev.token);
    this.migrateWatches.set(ev.pool, { pad, token: ev.token, pool: ev.pool, startMs: t, volUsd: 0, fired: false });
    this.graduatedPools.set(ev.pool, pad);
    const stats = this.pads.get(pad)?.window(t, 24 * 3600_000);
    await this.emit({
      type: 'PAD_GRADUATED',
      channel: 'launchpads',
      severity: 'watch',
      dedupeKey: `GRAD|${ev.token}`,
      eventTimeMs: t,
      pool: ev.pool,
      evidence: { usdCertain: false, trusted: true },
      token: { address: ev.token, symbol: await this.symbolOf(ev.token) },
      venue: pad,
      txHash: ev.raw.transactionHash,
      title: `PAD_GRADUATED · ${pad}`,
      extraFields: [
        { name: 'pool', value: addrLink(this.d.cfg.network, ev.pool), inline: true },
        ...(stats?.migrateRatio !== undefined ? [{ name: 'migrate_ratio 24h', value: fmtPct(stats.migrateRatio), inline: true }] : []),
      ],
    });
  }

  private priceFrom(p: PoolState, ev?: SwapEv, usd?: number, tokenAmt?: bigint): number | undefined {
    if (p.usdcSide === undefined || p.tokenDecimals === undefined) return undefined;
    const [d0, d1] = p.usdcSide === 0 ? [p.usdcDecimals, p.tokenDecimals] : [p.tokenDecimals, p.usdcDecimals];
    if (ev?.sqrtPriceX96) return v3TokenPriceUsd(ev.sqrtPriceX96, d0, d1, p.usdcSide === 0);
    if (p.reserves) {
      const [r0, r1] = p.reserves;
      return p.usdcSide === 0 ? reservesPriceUsd(r1, p.tokenDecimals, r0, p.usdcDecimals) : reservesPriceUsd(r0, p.tokenDecimals, r1, p.usdcDecimals);
    }
    if (usd !== undefined && tokenAmt && tokenAmt !== 0n) return usd / toNumber(abs(tokenAmt), p.tokenDecimals);
    return undefined;
  }

  private async mcapFor(token: Address | undefined, price: number | undefined, decimals: number | undefined) {
    if (!token || price === undefined || decimals === undefined) return undefined;
    return signalMcap(price, (await this.d.reader.erc20Meta(token)).totalSupply, decimals);
  }

  private async onSwap(ev: SwapEv, t: number) {
    const p = await this.pools.ensure(ev.pool, ev.dex);
    if (p.usdcSide === undefined || !p.token) return; // token/token (no USDC side): usd uncertain, not scored in v1
    const usdcRaw = p.usdcSide === 0 ? ev.amount0 : ev.amount1;
    const tokenRaw = p.usdcSide === 0 ? ev.amount1 : ev.amount0;
    const isBuy = usdcRaw > 0n; // USDC into pool = token bought
    const usd = toNumber(abs(usdcRaw), p.usdcDecimals);
    const price = this.priceFrom(p, ev, usd, tokenRaw);
    if (price !== undefined) p.priceUsd = price;

    p.vol.add(t, usd);
    (isBuy ? p.buyUsd : p.sellUsd).add(t, usd);
    if (isBuy) p.usdInSinceBirth += usd;

    // --- LP_SURGE from swap flow, for pools whose Mint events never touch the USDC side (see onLiquidity) ---
    p.lpFromSwaps.push(t, isBuy ? usd : -usd);
    if (p.singleSidedSeed && isBuy) {
      // A sell isn't a liquidity removal (it doesn't pull an LP position) — only buys are evaluated here, same
      // as only Mint (never Burn-as-surge) is evaluated in onLiquidity. Sells still count in the window's net.
      const verdict = evaluateLp(p.lpFromSwaps, p.lastSurgeFireMs, t, usd, this.d.cfg.thresholds);
      if (verdict) await this.emitLpVerdict(p, verdict, t, ev.raw.transactionHash);
    }
    const padName = this.padOf(p);
    if (padName) this.pads.get(padName)?.vol.add(t, usd);
    const major = this.majors.get(p.token);
    major?.onSwap(t, usd, isBuy, p.priceUsd, p.pool);

    // --- BRIDGE_DEPLOY: a recently bridged-in wallet spending it ---
    if (isBuy && this.followedWallets.has(ev.recipient)) {
      await this.checkBridgeDeploy({ trader: ev.recipient, t, token: p.token, symbol: await this.symbolOf(p.token), venue: p.venue ?? truncAddr(p.pool), usd, txHash: ev.raw.transactionHash, pool: p });
    }

    // --- PAD_MIGRATE_HOT ---
    const watch = this.migrateWatches.get(p.pool);
    if (watch && evaluateMigrate(watch, t, usd, this.d.cfg.thresholds.migrateWindowSec * 1000, this.d.cfg.thresholds.migrateVolUsd)) {
      const mc = await this.mcapFor(p.token, p.priceUsd, p.tokenDecimals);
      await this.emit({
        type: 'PAD_MIGRATE_HOT',
        hardRule: 'PAD_MIGRATE_HOT',
        channel: 'alerts',
        fallbackChannel: 'launchpads',
        severity: 'alert',
        dedupeKey: `MIGRATE|${watch.token}`,
        eventTimeMs: t,
        pool: p.pool,
        evidence: { usdCertain: true, trusted: p.trusted, notes: [`post-migrate vol ${fmtUsd(watch.volUsd)} in ${((t - watch.startMs) / 1000).toFixed(0)}s`] },
        token: { address: watch.token, symbol: await this.symbolOf(watch.token) },
        venue: `${watch.pad} → ${p.venue ?? truncAddr(p.pool)}`,
        usd: watch.volUsd,
        velocity: signalVelocity(watch.volUsd, watch.startMs, t),
        lp: await this.lpOf(p),
        mcap: mc,
        txHash: ev.raw.transactionHash,
        description: `Graduated on ${watch.pad}; ${fmtUsd(watch.volUsd)} USDC traded within ${this.d.cfg.thresholds.migrateWindowSec}s window (threshold ${fmtUsd(this.d.cfg.thresholds.migrateVolUsd)}).`,
      });
    }

    const poolAgeMs = p.createdAtMs !== undefined ? t - p.createdAtMs : undefined;

    // --- wallets ---
    if (this.wallets.size) {
      let wallet = this.wallets.firstMatch([ev.recipient, ev.sender]);
      const young = poolAgeMs !== undefined && poolAgeMs <= this.d.cfg.thresholds.walletAgeSec * 1000;
      if (!wallet && young && isBuy) wallet = this.wallets.get(await this.d.reader.txFrom(ev.raw.transactionHash));
      if (wallet) {
        const fast = isWalletFast({
          isBuy,
          usd,
          poolAgeMs,
          maxAgeSec: this.d.cfg.thresholds.walletAgeSec,
          minUsd: this.d.cfg.thresholds.walletBuyUsd,
        });
        const symbol = await this.symbolOf(p.token);
        const mc = await this.mcapFor(p.token, p.priceUsd, p.tokenDecimals);
        await this.emit({
          type: fast ? 'WATCHLIST_WALLET_FAST' : 'WALLET_ACTIVITY',
          hardRule: fast ? 'WATCHLIST_WALLET_FAST' : undefined,
          channel: fast ? 'alerts' : 'smart-flow',
          fallbackChannel: 'smart-flow',
          severity: fast ? 'alert' : 'watch',
          dedupeKey: `WALLET|${wallet.address}|${p.pool}|${isBuy ? 'buy' : 'sell'}`,
          eventTimeMs: t,
          pool: p.pool,
          evidence: { usdCertain: true, trusted: p.trusted },
          token: { address: p.token, symbol },
          venue: p.venue ?? truncAddr(p.pool),
          usd,
          velocity: signalVelocity(p.usdInSinceBirth, p.createdAtMs, t),
          lp: fast ? await this.lpOf(p) : undefined,
          mcap: mc,
          txHash: ev.raw.transactionHash,
          title: `${fast ? 'WATCHLIST_WALLET_FAST' : 'WALLET_ACTIVITY'} · ${wallet.label}`,
          extraFields: [
            { name: 'wallet', value: addrLink(this.d.cfg.network, wallet.address, wallet.label), inline: true },
            { name: 'side', value: isBuy ? 'buy' : 'sell', inline: true },
            ...(poolAgeMs !== undefined ? [{ name: 'pool age', value: `${(poolAgeMs / 1000).toFixed(0)}s`, inline: true }] : []),
          ],
        });
      }
    }

    // --- early-buyer density (EARLY_BUYER_DENSITY) on new pools ---
    if (isBuy && p.createdBlock !== undefined && ev.raw.blockNumber - p.createdBlock <= BigInt(this.d.cfg.thresholds.earlyBuyerBlocks)) {
      p.earlyBuyers.set(ev.recipient, (p.earlyBuyers.get(ev.recipient) ?? 0n) + abs(tokenRaw));
      if (!p.earlyBuyerFired && p.earlyBuyers.size >= this.d.cfg.thresholds.earlyBuyerMinCount) {
        p.earlyBuyerFired = true;
        const meta = await this.d.reader.erc20Meta(p.token);
        const bought = [...p.earlyBuyers.values()].reduce((a, b) => a + b, 0n);
        const share = meta.totalSupply ? Number((bought * 1_000_000n) / meta.totalSupply) / 1_000_000 : undefined;
        const clusters = clusterByFunder([...p.earlyBuyers.keys()], (a) => this.funders.funderOf(a), this.d.cfg.thresholds.clusterMinWallets);
        await this.emit({
          type: 'EARLY_BUYER_DENSITY',
          channel: 'smart-flow',
          severity: 'watch',
          dedupeKey: `EARLY_BUYER|${p.pool}`,
          eventTimeMs: t,
          pool: p.pool,
          evidence: { usdCertain: true, trusted: p.trusted },
          token: { address: p.token, symbol: meta.symbol },
          venue: p.venue ?? truncAddr(p.pool),
          usd: p.usdInSinceBirth,
          txHash: ev.raw.transactionHash,
          extraFields: [
            { name: 'unique buyers', value: `${p.earlyBuyers.size} in ≤${this.d.cfg.thresholds.earlyBuyerBlocks} blocks`, inline: true },
            ...(share !== undefined ? [{ name: 'supply bought', value: fmtPct(share), inline: true }] : []),
            { name: 'funder clusters', value: clusters.length ? clusters.map((c) => `${truncAddr(c.funder)}×${c.members.length}`).join(', ') : 'none detected', inline: false },
          ],
        });
      }
    }

    // --- pad time-to-$X ---
    if (padName && p.priceUsd !== undefined) {
      const mc = await this.mcapFor(p.token, p.priceUsd, p.tokenDecimals);
      if (mc !== undefined) this.pads.get(padName)?.onMcap(t, p.token, mc, this.d.cfg.thresholds.padTimeToUsd);
    }

    // --- MAJOR_ANOMALY ---
    if (major && !this.missing.has(major.address)) {
      const th = this.d.cfg.thresholds;
      const r = major.evaluate(t, {
        z: th.anomalyZ,
        pct: th.anomalyPct,
        minSamples: th.anomalyMinSamples,
        minVolUsd: th.anomalyMinVolUsd,
        cooldownMs: th.anomalyCooldownSec * 1000,
      });
      if (r) {
        major.lastAnomalyMs = t;
        await this.emit({
          type: 'MAJOR_ANOMALY',
          hardRule: 'MAJOR_ANOMALY',
          channel: 'alerts',
          fallbackChannel: 'major-coins',
          severity: 'alert',
          dedupeKey: `ANOMALY|${major.address}`,
          eventTimeMs: t,
          pool: major.sourcePool ?? p.pool, // score on the price-source pool (dust pools never price a major)
          evidence: { usdCertain: true, trusted: p.trusted },
          token: { address: major.address, symbol: major.symbol },
          venue: p.venue ?? truncAddr(p.pool),
          usd: r.cur5,
          velocity: r.cur5 / 5,
          lp: await this.lpOf(p),
          mcap: await this.mcapFor(p.token, p.priceUsd, p.tokenDecimals),
          txHash: ev.raw.transactionHash,
          description:
            r.kind === 'vol_z'
              ? `5m vol ${fmtUsd(r.cur5)} vs 1h baseline ${fmtUsd(r.baselineMean5)}/5m → z=${r.z!.toFixed(1)} (threshold ${th.anomalyZ}).`
              : `price Δ ${r.pctChange!.toFixed(1)}% vs 60m ago (threshold ±${th.anomalyPct}%), 5m vol ${fmtUsd(r.cur5)}.`,
          extraFields: [{ name: 'baseline samples', value: `${r.samples} min`, inline: true }],
        });
      }
    }
  }

  private async onLiquidity(ev: LiquidityEv, t: number) {
    const p = await this.pools.ensure(ev.pool, ev.dex);
    if (p.usdcSide === undefined) return;
    const usdcRaw = p.usdcSide === 0 ? ev.amount0 : ev.amount1;
    const usd = toNumber(usdcRaw, p.usdcDecimals);
    const delta = ev.kind === 'mint' ? usd : -usd;
    p.lp.push(t, delta);
    // Decided once, from the pool's first mint: does this venue seed single-sided (Lift/Tolly/RadarDEX — the
    // USDC-side Mint amount is always 0, so `lp` can never see a surge here at any threshold) or two-sided?
    if (ev.kind === 'mint' && p.singleSidedSeed === undefined) p.singleSidedSeed = usd === 0;
    if (p.singleSidedSeed) return; // this pool's surges are read from swap flow instead — see onSwap
    const verdict = evaluateLp(p.lp, p.lastSurgeFireMs, t, delta, this.d.cfg.thresholds);
    if (!verdict) return;
    await this.emitLpVerdict(p, verdict, t, ev.raw.transactionHash);
  }

  private async emitLpVerdict(p: PoolState, verdict: NonNullable<LpVerdict>, t: number, txHash: Hex) {
    const lp = await this.lpOf(p);
    const symbol = await this.symbolOf(p.token);
    if (p.dex === 'univ3' && p.priceUsd === undefined) {
      const sp = await this.d.reader.v3SqrtPrice(p.pool);
      if (sp) p.priceUsd = this.priceFrom(p, { sqrtPriceX96: sp } as SwapEv);
    }
    const mc = await this.mcapFor(p.token, p.priceUsd, p.tokenDecimals);
    const base = {
      eventTimeMs: t,
      pool: p.pool,
      token: p.token ? { address: p.token, symbol } : undefined,
      venue: p.venue ?? `unverified ${p.dex} ${truncAddr(p.pool)}`,
      lp,
      mcap: mc,
      txHash,
      evidence: { usdCertain: true, trusted: p.trusted },
    };
    const poolField = { name: 'pool', value: addrLink(this.d.cfg.network, p.pool), inline: true };

    if (verdict.kind === 'surge') {
      p.lastSurgeFireMs = t;
      const since = Math.max(verdict.windowStartMs, p.createdAtMs ?? -Infinity, t - this.d.cfg.thresholds.lpWindowSec * 1000);
      await this.emit({
        ...base,
        type: 'LP_SURGE',
        hardRule: 'LP_SURGE',
        channel: 'alerts',
        fallbackChannel: this.specialty(p),
        severity: 'alert',
        dedupeKey: `LP|${p.pool}`,
        usd: verdict.netUsd,
        velocity: signalVelocity(verdict.netUsd, since, t),
        description: `Net ${fmtUsd(verdict.netUsd)} USDC liquidity added within ${this.d.cfg.thresholds.lpWindowSec}s (threshold ${fmtUsd(this.d.cfg.thresholds.lpUsd)}).`,
        extraFields: [poolField],
      });
    } else {
      // Below surge / removals: specialty channel only (pad pools, major tokens); everything else stays in logs.
      const ch = this.specialty(p);
      const usd = verdict.kind === 'watch' ? verdict.netUsd : verdict.usd;
      if (!ch) {
        this.d.log.info({ type: verdict.kind, pool: p.pool, usd, trusted: p.trusted }, 'lp signal (logs only: pool not pad/major)');
        return;
      }
      await this.emit({
        ...base,
        type: verdict.kind === 'watch' ? 'LP_WATCH' : 'LP_REMOVE',
        channel: ch,
        severity: 'watch',
        dedupeKey: verdict.kind === 'watch' ? `LP|${p.pool}` : `LPREM|${p.pool}`,
        usd,
        velocity: verdict.kind === 'watch' ? signalVelocity(usd, verdict.windowStartMs, t) : undefined,
        extraFields: [poolField],
      });
    }
  }

  private onSync(ev: SyncEv) {
    const p = this.pools.get(ev.pool);
    if (!p) return;
    p.reserves = [ev.reserve0, ev.reserve1];
    const price = this.priceFrom(p);
    if (price !== undefined) p.priceUsd = price;
  }

  private async onTransfer(ev: TransferEv, t: number) {
    this.holders.get(ev.token)?.onTransfer(t, ev.from, ev.to, ev.value, logId(ev.raw), ev.raw.blockNumber);
    // A CCTP mint is a Transfer(0x0 -> recipient) logged by the chain's system emitter, not by usdcMirror.
    const systemEmitter = this.d.cfg.network.usdcSystemEmitter;
    if (this.cctp?.transmitter && systemEmitter && ev.token === lc(systemEmitter) && ev.from === zeroAddress) {
      return this.onBridgeInflow(ev, t);
    }
    if (ev.token !== lc(this.d.cfg.usdcMirror)) return;
    this.funders.onUsdcTransfer(ev.from, ev.to);
    const bridge = this.bridges.get(ev.from) ?? this.bridges.get(ev.to);
    if (!bridge) return;
    const usd = toNumber(ev.value, this.usdcDecimals);
    const th = this.d.cfg.thresholds;
    if (usd < th.bridgeFlowUsd) return;
    const inflow = this.bridges.has(ev.from);
    await this.emit({
      type: 'BRIDGE_FLOW',
      channel: usd >= th.alertBridgeUsd ? 'alerts' : 'smart-flow',
      severity: usd >= th.alertBridgeUsd ? 'alert' : 'watch',
      dedupeKey: `BRIDGE|${ev.raw.transactionHash}`,
      eventTimeMs: t,
      evidence: { usdCertain: true, trusted: true },
      token: { address: ev.token, symbol: 'USDC' },
      venue: `${bridge} ${inflow ? 'inflow' : 'outflow'}`,
      usd,
      txHash: ev.raw.transactionHash,
      extraFields: [{ name: inflow ? 'to' : 'from', value: addrLink(this.d.cfg.network, inflow ? ev.to : ev.from), inline: true }],
    });
  }

  /** MessageTransmitter.MessageReceived: enrichment only (sourceDomain), gated to the configured transmitter. The
   * inflow signal itself fires from the paired mint Transfer (onBridgeInflow), which may arrive first or last. */
  private onBridgeMint(ev: BridgeMintEv, _t: number) {
    if (!this.cctp?.transmitter || ev.emitter !== this.cctp.transmitter) return;
    this.mintDomainByTx.set(ev.raw.transactionHash, ev.sourceDomain);
    if (this.mintDomainByTx.size > 500) {
      const oldest = this.mintDomainByTx.keys().next().value;
      if (oldest !== undefined) this.mintDomainByTx.delete(oldest);
    }
  }

  /**
   * BRIDGE_INFLOW: a CCTP mint, detected from its Transfer(0x0 -> recipient) on the system emitter.
   * The system emitter's Transfer.value is NATIVE (18-dec), never the 6-dec ERC-20 mirror scale
   * `this.usdcDecimals` resolves to — using that here undercounted the divisor by 1e12 and inflated
   * every inflow by the same factor (a real ~$1 mint priced as ~$1 trillion). Verified against a real
   * mint (fixtures/mainnet-real/receipts.json "cctp_mint"): value 999968000000000000 is $0.999968,
   * not $999,968,000,000.
   */
  private async onBridgeInflow(ev: TransferEv, t: number) {
    const usd = toNumber(ev.value, USDC_NATIVE_DECIMALS);
    this.bridgeInflow.add(t, usd); // total inflow rate counts every arrival, not just those above threshold
    const sourceDomain = this.mintDomainByTx.get(ev.raw.transactionHash);
    this.mintDomainByTx.delete(ev.raw.transactionHash);
    const sinceLastMs = this.lastInflowMs !== undefined ? t - this.lastInflowMs : undefined;
    this.lastInflowMs = t;

    this.pruneFollowed(t);
    const th = this.d.cfg.thresholds;
    if (usd >= th.bridgeFollowMinUsd) {
      this.followedWallets.set(ev.to, { arrivedAtMs: t, arrivedUsd: usd, expiresAtMs: t + th.bridgeFollowMinutes * 60_000 });
    }

    if (usd < th.bridgeFlowUsd) return;
    const domainLabel = sourceDomain !== undefined ? `domain ${sourceDomain}` : this.cctp?.sourceDomainLabel ? `${this.cctp.sourceDomainLabel} (assumed)` : this.cctp?.sourceDomainDefault !== undefined ? `domain ${this.cctp.sourceDomainDefault} (assumed)` : 'unknown';
    await this.emit({
      type: 'BRIDGE_INFLOW',
      channel: usd >= th.alertBridgeUsd ? 'alerts' : 'smart-flow',
      severity: usd >= th.alertBridgeUsd ? 'alert' : 'watch',
      dedupeKey: `BRIDGE_IN|${ev.raw.transactionHash}`,
      eventTimeMs: t,
      evidence: { usdCertain: true, trusted: true },
      token: { address: ev.token, symbol: 'USDC' },
      venue: `CCTP inflow (${domainLabel})`,
      usd,
      txHash: ev.raw.transactionHash,
      extraFields: [
        { name: 'recipient', value: addrLink(this.d.cfg.network, ev.to), inline: true },
        { name: 'since prev arrival', value: sinceLastMs !== undefined ? `${(sinceLastMs / 1000).toFixed(0)}s` : 'first seen', inline: true },
        { name: 'inflow 5m', value: fmtUsd(this.bridgeInflow.sumWindow(t, 5)), inline: true },
        { name: 'inflow 1h', value: fmtUsd(this.bridgeInflow.sumWindow(t, 60)), inline: true },
      ],
    });
  }

  /** BRIDGE_OUTFLOW: TokenMessenger.DepositForBurn — USDC leaving this chain. */
  private async onBridgeBurn(ev: BridgeBurnEv, t: number) {
    if (!this.cctp?.tokenMessenger || ev.emitter !== this.cctp.tokenMessenger) return;
    if (ev.burnToken !== lc(this.d.cfg.usdcMirror)) return; // not USDC: not our corridor
    const usd = toNumber(ev.amount, this.usdcDecimals);
    this.bridgeOutflow.add(t, usd);
    const th = this.d.cfg.thresholds;
    if (usd < th.bridgeFlowUsd) return;
    await this.emit({
      type: 'BRIDGE_OUTFLOW',
      channel: usd >= th.alertBridgeUsd ? 'alerts' : 'smart-flow',
      severity: usd >= th.alertBridgeUsd ? 'alert' : 'watch',
      dedupeKey: `BRIDGE_OUT|${ev.raw.transactionHash}`,
      eventTimeMs: t,
      evidence: { usdCertain: true, trusted: true },
      token: { address: ev.burnToken, symbol: 'USDC' },
      venue: `CCTP outflow (domain ${ev.destinationDomain})`,
      usd,
      txHash: ev.raw.transactionHash,
      extraFields: [
        { name: 'depositor', value: addrLink(this.d.cfg.network, ev.depositor), inline: true },
        { name: 'outflow 5m', value: fmtUsd(this.bridgeOutflow.sumWindow(t, 5)), inline: true },
        { name: 'outflow 1h', value: fmtUsd(this.bridgeOutflow.sumWindow(t, 60)), inline: true },
      ],
    });
  }

  private pruneFollowed(now: number) {
    for (const [addr, w] of this.followedWallets) if (now > w.expiresAtMs) this.followedWallets.delete(addr);
  }

  /** BRIDGE_DEPLOY: a followed (recently bridged-in) wallet buys a token. Called from onSwap/onPadTrade. */
  private async checkBridgeDeploy(o: { trader: Address; t: number; token: Address; symbol?: string; venue: string; usd: number; txHash: Hex; pool?: PoolState }) {
    this.pruneFollowed(o.t);
    const arrival = this.followedWallets.get(o.trader);
    if (!arrival) return;
    const sinceArrivalMs = o.t - arrival.arrivedAtMs;
    await this.emit({
      type: 'BRIDGE_DEPLOY',
      channel: 'smart-flow',
      severity: 'watch',
      dedupeKey: `BRIDGE_DEPLOY|${o.txHash}`,
      eventTimeMs: o.t,
      evidence: { usdCertain: true, trusted: o.pool?.trusted ?? true },
      token: { address: o.token, symbol: o.symbol },
      venue: o.venue,
      usd: o.usd,
      txHash: o.txHash,
      title: `BRIDGE_DEPLOY · ${o.symbol ?? truncAddr(o.token)}`,
      extraFields: [
        { name: 'wallet', value: addrLink(this.d.cfg.network, o.trader), inline: true },
        { name: 'bridged in', value: `${fmtUsd(arrival.arrivedUsd)} · ${(sinceArrivalMs / 60_000).toFixed(1)}m ago`, inline: true },
        ...(await this.tokenMetricsFields(o.token, o.t, o.pool)),
      ],
    });
  }

  /** "What the radar already computes" for a token, so BRIDGE_DEPLOY can be judged without opening a browser. */
  private async tokenMetricsFields(token: Address, t: number, p?: PoolState): Promise<Field[]> {
    const fields: Field[] = [];
    if (p) {
      const depth = await this.lpOf(p);
      if (depth !== undefined) fields.push({ name: 'pool depth', value: fmtUsd(depth), inline: true });
      if (p.createdAtMs !== undefined) fields.push({ name: 'pool age', value: `${((t - p.createdAtMs) / 60_000).toFixed(1)}m`, inline: true });
      const buys = p.buyUsd.sumWindow(t, 60);
      const sells = p.sellUsd.sumWindow(t, 60);
      if (buys > 0 || sells > 0) fields.push({ name: 'buy/sell 1h', value: sells > 0 ? (buys / sells).toFixed(2) : 'buys only', inline: true });
    }
    const holders = this.holders.get(token);
    if (holders?.sinceBirth) {
      fields.push({ name: 'holders≈', value: String(holders.holderCount()), inline: true });
      const meta = await this.d.reader.erc20Meta(token);
      const supply = meta.totalSupply;
      if (supply !== undefined) {
        const exclude = new Set<string>([token, ...this.venueContracts(), ...(p ? [p.pool] : [])]);
        const share = holders.top10Share(supply, exclude);
        if (share !== undefined) fields.push({ name: 'top10% (ex LP/venues)', value: fmtPct(share), inline: true });
      }
    }
    return fields;
  }

  /** Rolling bridge inflow/outflow, for the periodic net-flow digest (jobs/digests.ts). */
  bridgeInflowWindow(nowMs: number, minutes: number): number {
    return this.bridgeInflow.sumWindow(nowMs, minutes);
  }

  bridgeOutflowWindow(nowMs: number, minutes: number): number {
    return this.bridgeOutflow.sumWindow(nowMs, minutes);
  }

  /** Emit a pre-built signal (jobs: digests, boot probe). */
  publish(s: Signal) {
    return this.emit(s);
  }

  isPadToken(a: string) {
    return this.padTokens.get(a);
  }
}
