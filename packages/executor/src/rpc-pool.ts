/**
 * rpc-pool — rotating Arc HTTP endpoints.
 *
 * ARC_MAINNET_HTTP_URL is a comma-separated list. The pool starts on the
 * first entry and rotates to the next after `rotateAfter` CONSECUTIVE
 * transport failures (the "An internal error was received." class,
 * timeouts, 5xx, "could not complete this request"). A node rejection
 * (nonce too low, underpriced, insufficient funds, revert) is never a
 * transport failure: it neither counts nor rotates.
 *
 * Every endpoint's chainId is asserted at first use. A wrong-chain
 * endpoint is DROPPED from the pool, not skipped once. When every
 * endpoint is dropped the process aborts.
 *
 * Rotation is per call, never per process: the active client is read
 * through a getter on every attempt, so a retry after a rotation lands on
 * the new endpoint without a restart. broadcast() keeps its invariant on
 * top of this: the SAME signed bytes are re-sent and the hash is checked
 * first; the pool only decides which endpoint answers.
 */

import { createPublicClient, http, type Chain, type PublicClient, type Transport } from 'viem';
import type { Address, Hex } from 'viem';
import { RpcChainReader } from '../../radar/src/rpc/clients.js';
import { isTransient, RateLimiter } from '../../radar/src/rpc/limiter.js';
import type { ChainReader, Erc20Meta, LogFilter, PoolOnchain } from '../../radar/src/rpc/reader.js';
import type { Dex, RawLog } from '../../radar/src/decode/types.js';
import { C, die, log, sleep } from './log.js';

export type Pub = PublicClient<Transport, Chain>;

/**
 * What an error MEANS, decided before anything reacts to it:
 *   transient  the endpoint did not answer usefully (network, timeout, 5xx, burst throttle, internal error): retry, count toward rotation
 *   quota      the endpoint refuses this key/plan persistently (401/402/403, or 429 with a quota body): DROP it for the session
 *   onchain    the node answered and the contract said no (revert, returned no data): this IS data
 *   rejected   the node refused a transaction on its merits (nonce too low, underpriced, insufficient funds): final, never re-sent
 *   unknown    none of the above: treated like transient for reads (never interpreted as data)
 */
export type ErrorKind = 'transient' | 'quota' | 'onchain' | 'rejected' | 'unknown';

export function classifyError(e: unknown): { kind: ErrorKind; detail: string } {
  const msgs: string[] = [];
  let status: number | undefined;
  let code: number | undefined;
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 8; depth += 1) {
    const o = cur as { message?: string; shortMessage?: string; details?: string; status?: number; code?: number; name?: string; cause?: unknown };
    for (const m of [o.name, o.shortMessage, o.message, o.details]) if (typeof m === 'string' && m) msgs.push(m);
    if (typeof o.status === 'number') status ??= o.status;
    if (typeof o.code === 'number') code ??= o.code;
    cur = o.cause;
  }
  const text = msgs.join(' | ');
  const lc = text.toLowerCase();
  const plain = msgs.filter((m) => m && !/^[A-Za-z]+Error$/.test(m));
  const detail = (plain[plain.length - 1] ?? text).split('\n')[0]!.slice(0, 120);
  if (/nonce too low|already known|known transaction|replacement transaction underpriced|underpriced|insufficient funds|intrinsic gas|exceeds block gas limit|invalid signature|nonce is too low/.test(lc)) return { kind: 'rejected', detail };
  // Quota / auth: the endpoint refuses this key or plan. Checked before the generic transport rule.
  const quotaBody = /quota|daily request|request count|exceeded|credits|payment required|plan|unauthorized|forbidden|invalid project|api key|not allowed|access denied|key is|suspended/.test(lc);
  if (status === 401 || status === 402 || status === 403 || ((status === 429 || code === -32005 || /too many requests/.test(lc)) && quotaBody)) return { kind: 'quota', detail };
  // Transport markers ANYWHERE in the cause chain win over an outer "reverted": viem wraps a -32603 "internal error" from
  // a throttling node as ContractFunctionRevertedError with an empty reason (seen live on rpc.arc-scan.org).
  const transportMarker = /internal error|could not complete|timeout|timed out|fetch failed|econn|socket hang|network error|rate limit|rate-limit|ratelimit|too many requests|http request failed|status: 5\d\d|bad gateway|service unavailable|gateway time/.test(lc);
  if (status === 429 || (status !== undefined && status >= 500) || code === -32603 || code === -32005 || transportMarker) return { kind: 'transient', detail };
  // On-chain answer: the node executed the call and the contract said no, or returned nothing. A revert needs a reason,
  // data or the node's own "execution reverted"; a bare "reverted with the following reason:" with nothing after it is not one.
  const hasReason = /reverted with the following reason:\s*\S|execution reverted|revert reason|custom error|error signature|reverted with (?:custom )?error|data:\s*0x[0-9a-f]{8}/.test(lc);
  if (/returned no data|zero data|contractfunctionzerodataerror|abidecodingzerodataerror|invalid opcode|out of gas/.test(lc) || hasReason) return { kind: 'onchain', detail };
  if (isTransient(e)) return { kind: 'transient', detail };
  return { kind: 'unknown', detail };
}

/** Every alive endpoint was tried for one read and none answered. Never a statement about chain state. */
export class RpcExhausted extends Error {
  constructor(readonly what: string, readonly tried: number, readonly total: number, readonly last: { kind: ErrorKind; detail: string }) {
    super(`all ${tried}/${total} endpoints failed to read ${what} (last: ${last.kind}: ${last.detail}). This is an RPC failure, not on-chain data.`);
  }
}

export interface PoolOptions {
  urls: string[];
  chainId: number;
  rotateAfter: number;
  readerRps: number;
  readerRetryBaseMs: number;
  chain: Chain;
  /** Injection point for tests. */
  makeClient?: (url: string) => Pub;
  makeReader?: (url: string) => RpcChainReader;
  logFn?: (msg: string) => void;
}

export const hostOf = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return '(malformed)';
  }
};

export class RpcPool {
  private readonly urls: string[];
  private active = 0;
  private readonly dropped = new Set<number>();
  private readonly verified = new Set<number>();
  private verifying = new Map<number, Promise<void>>();
  private consecutiveFailures = 0;
  private readonly clients = new Map<number, Pub>();
  private readonly readers = new Map<number, RpcChainReader>();
  /** Raw reads share one token bucket at the configured rps, so parallel callers cannot burst the endpoint. */
  private readonly limiter: RateLimiter;
  /** Rotation history for the header: `host` of each endpoint used, in order. */
  readonly history: string[] = [];
  readonly rotations: { from: string; to: string; why: string; failures: number; atMs: number }[] = [];
  private readonly logFn: (msg: string) => void;

  constructor(private readonly o: PoolOptions) {
    this.urls = o.urls;
    if (!this.urls.length) throw new Error('RpcPool: no endpoints');
    this.logFn = o.logFn ?? log;
    this.limiter = new RateLimiter(Math.max(1, o.readerRps));
    this.history.push(hostOf(this.urls[0]!));
  }

  get size(): number {
    return this.urls.length;
  }

  get activeUrl(): string {
    return this.urls[this.active]!;
  }

  get activeHost(): string {
    return hostOf(this.activeUrl);
  }

  /** True once the session has moved off the first endpoint at least once. */
  get changed(): boolean {
    return this.rotations.length > 0;
  }

  get alive(): number {
    return this.urls.length - this.dropped.size;
  }

  /** Human header fragment: host, "*" when rotated, "(2/3)" when more than one endpoint. */
  describe(): string {
    const n = this.urls.length > 1 ? ` (${this.active + 1}/${this.urls.length}${this.dropped.size ? `, ${this.dropped.size} dropped` : ''})` : '';
    return `${this.activeHost}${this.changed ? '*' : ''}${n}`;
  }

  /** The client for the ACTIVE endpoint. Read it on every attempt, never cache it in a closure. */
  get client(): Pub {
    let c = this.clients.get(this.active);
    if (!c) {
      c = this.o.makeClient ? this.o.makeClient(this.activeUrl) : createPublicClient({ chain: this.o.chain, transport: http(this.activeUrl, { timeout: 15_000, retryCount: 0 }) });
      this.clients.set(this.active, c);
    }
    return c;
  }

  /** The raw radar reader for the ACTIVE endpoint (one instance per endpoint). Internal: not chainId-checked. */
  private rawReader(): RpcChainReader {
    let r = this.readers.get(this.active);
    if (!r) {
      r = this.o.makeReader ? this.o.makeReader(this.activeUrl) : new RpcChainReader(this.activeUrl, this.o.readerRps, { attempts: 6, baseMs: this.o.readerRetryBaseMs });
      this.readers.set(this.active, r);
    }
    return r;
  }

  /**
   * radar ChainReader over the pool: every method first asserts the active
   * endpoint's chainId (so a wrong-chain endpoint is never read, even when it
   * is listed first), then delegates to that endpoint's rate-limited reader.
   * A result flagged `incomplete` (transient throttling inside the reader)
   * counts toward rotation like any other transport failure.
   */
  readonly reader: ChainReader = {
    chainId: () => this.viaReader('chainId', (r) => r.chainId()),
    getCode: (a) => this.viaReader('getCode', (r) => r.getCode(a)),
    getCodeAt: (a, b) => this.viaReader('getCodeAt', (r) => r.getCodeAt(a, b)),
    totalSupply: (t) => this.viaReader('totalSupply', (r) => r.totalSupply(t)),
    blockNumber: () => this.viaReader('blockNumber', (r) => r.blockNumber()),
    blockTimestamp: (b) => this.viaReader('blockTimestamp', (r) => r.blockTimestamp(b)),
    txFrom: (h: Hex) => this.viaReader('txFrom', (r) => r.txFrom(h)),
    erc20Meta: (t: Address) => this.viaReader('erc20Meta', (r) => r.erc20Meta(t), (m: Erc20Meta) => Boolean(m.incomplete)),
    poolOnchain: (p: Address, d: Dex) => this.viaReader('poolOnchain', (r) => r.poolOnchain(p, d), (m: PoolOnchain) => Boolean(m.incomplete)),
    factoryLookup: (f: Address, d: Dex, t0: Address, t1: Address, fee?: number) => this.viaReader('factoryLookup', (r) => r.factoryLookup(f, d, t0, t1, fee)),
    v3SqrtPrice: (p: Address) => this.viaReader('v3SqrtPrice', (r) => r.v3SqrtPrice(p)),
    balanceOf: (t: Address, h: Address) => this.viaReader('balanceOf', (r) => r.balanceOf(t, h)),
    curveInfo: (c: Address) => this.viaReader('curveInfo', (r) => r.curveInfo(c)),
    getLogs: (f: LogFilter): Promise<RawLog[]> => this.viaReader('getLogs', (r) => r.getLogs(f)),
  };

  private async viaReader<T>(what: string, fn: (r: RpcChainReader) => Promise<T>, throttled?: (v: T) => boolean): Promise<T> {
    await this.ensureVerified();
    const v = await fn(this.rawReader());
    if (throttled?.(v)) this.noteFailureSync(`reader ${what} throttled on ${this.activeHost}`);
    else this.consecutiveFailures = 0;
    return v;
  }

  /** Assert the active endpoint's chainId once. A mismatch drops it and rotates; no endpoint left aborts. */
  async ensureVerified(): Promise<void> {
    for (;;) {
      const i = this.active;
      if (this.verified.has(i)) return;
      let p = this.verifying.get(i);
      if (!p) {
        p = (async () => {
          let id: number;
          try {
            id = await this.client.getChainId();
          } catch (e) {
            const k = classifyError(e);
            if (k.kind === 'quota') {
              this.dropSync(i, `quota/auth: ${k.detail}`);
              return;
            }
            this.logFn(C.dim(`rpc ${hostOf(this.urls[i]!)}: chainId probe hit a ${k.kind} error (${k.detail.slice(0, 60)})`));
            this.noteFailureSync(`chainId probe failed on ${hostOf(this.urls[i]!)}`);
            return;
          }
          if (id !== this.o.chainId) {
            this.dropSync(i, `chainId ${id} != ${this.o.chainId}`);
            return;
          }
          this.verified.add(i);
          this.logFn(C.dim(`rpc ${hostOf(this.urls[i]!)}: chainId ${id} asserted`));
        })().finally(() => this.verifying.delete(i));
        this.verifying.set(i, p);
      }
      await p;
      if (this.verified.has(this.active)) return;
      await sleep(200);
    }
  }

  /**
   * One attempt against the active endpoint, with failure accounting.
   * transient/unknown: counted toward rotation, rethrown. quota: endpoint
   * DROPPED and rotated, rethrown. onchain/rejected: rethrown untouched, no
   * accounting (the node answered; that answer is the caller's business).
   */
  async once<T>(what: string, fn: (c: Pub) => Promise<T>): Promise<T> {
    await this.ensureVerified();
    const i = this.active;
    try {
      const v = await this.limiter.schedule(() => fn(this.client));
      if (this.active === i) this.consecutiveFailures = 0;
      return v;
    } catch (e) {
      const k = classifyError(e);
      if (k.kind === 'quota') this.dropSync(i, `quota/auth on ${what}: ${k.detail}`);
      else if (k.kind === 'transient' || k.kind === 'unknown') this.noteFailureSync(`${what}: ${k.detail.slice(0, 60)}`);
      throw e;
    }
  }

  /**
   * A read that must come from SOME endpoint: retried with backoff, rotating
   * through the pool, until every alive endpoint has had `rotateAfter`
   * tries. Only then it throws RpcExhausted, which no caller may read as
   * chain state. onchain/rejected errors are thrown immediately: the node
   * answered.
   */
  async call<T>(what: string, fn: (c: Pub) => Promise<T>, minAttempts = 6, baseMs = 400): Promise<T> {
    let attempt = 0;
    const tried = new Set<number>();
    for (;;) {
      tried.add(this.active);
      try {
        return await this.once(what, fn);
      } catch (e) {
        const k = classifyError(e);
        if (k.kind === 'onchain' || k.kind === 'rejected') throw e;
        attempt += 1;
        const budget = Math.max(minAttempts, this.o.rotateAfter * Math.max(1, this.alive));
        if (this.alive === 0 || attempt >= budget) throw new RpcExhausted(what, tried.size, this.urls.length, k);
        await sleep(Math.min(baseMs * 2 ** Math.min(attempt - 1, 4), 4000) + Math.random() * 100);
      }
    }
  }

  /** Drop endpoint `i` for the session (wrong chain, persistent quota/auth) and move on. */
  private dropSync(i: number, reason: string): void {
    if (this.dropped.has(i)) return;
    this.dropped.add(i);
    this.logFn(`${C.bold('RPC DROPPED')} ${hostOf(this.urls[i]!)}: ${reason}. Removed from the pool for this session.`);
    if (this.alive === 0) die(`every Arc RPC endpoint was dropped: ${this.urls.map(hostOf).join(', ')} (last: ${reason})`);
    if (this.active === i) this.rotateSync(`dropped: ${reason}`);
  }

  /** Report a transport failure observed outside `once` (reader throttling, a lost broadcast ack). */
  noteFailure(why: string): void {
    this.noteFailureSync(why);
  }

  private noteFailureSync(why: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.o.rotateAfter) this.rotateSync(why);
  }

  private rotateSync(why: string): void {
    const failures = this.consecutiveFailures;
    const from = this.active;
    let next = from;
    for (let step = 1; step <= this.urls.length; step += 1) {
      const cand = (from + step) % this.urls.length;
      if (!this.dropped.has(cand)) {
        next = cand;
        break;
      }
    }
    this.consecutiveFailures = 0;
    if (this.alive === 0) die(`every Arc RPC endpoint was dropped (wrong chain): ${this.urls.map(hostOf).join(', ')}`);
    if (next === from) {
      this.logFn(C.bold(`RPC rotate: ${hostOf(this.urls[from]!)} is the only endpoint left; staying (${why}, ${failures} consecutive failures)`));
      return;
    }
    this.active = next;
    this.history.push(hostOf(this.urls[next]!));
    this.rotations.push({ from: hostOf(this.urls[from]!), to: hostOf(this.urls[next]!), why, failures, atMs: Date.now() });
    this.logFn(C.bold(`RPC rotate: ${hostOf(this.urls[from]!)} -> ${hostOf(this.urls[next]!)} (${why}; ${failures} consecutive failures; endpoint ${next + 1}/${this.urls.length})`));
  }
}
