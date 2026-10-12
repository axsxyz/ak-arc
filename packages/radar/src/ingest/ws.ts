import { EventEmitter } from 'node:events';
import type { Logger } from '../log.js';

export interface WsHead {
  number: bigint;
  timestamp: number; // seconds
  hash: string;
}

export interface WsSubscription {
  kind: 'newHeads' | 'logs';
  params?: unknown | (() => unknown);
  onData: (data: unknown) => void;
}

/**
 * Minimal JSON-RPC-over-WebSocket client with eth_subscribe, exponential backoff reconnect,
 * automatic resubscription and a stall watchdog. Emits 'open', 'reconnected', 'close'.
 */
export class WsRpc extends EventEmitter {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private subs: WsSubscription[] = [];
  private subIds = new Map<string, WsSubscription>();
  private attempt = 0;
  private stopped = false;
  private everOpened = false;
  private watchdog?: NodeJS.Timeout;
  private lastData = Date.now();

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly stallMs = 30_000,
  ) {
    super();
  }

  subscribe(sub: WsSubscription) {
    this.subs.push(sub);
    if (this.ws?.readyState === WebSocket.OPEN) void this.doSubscribe(sub);
  }

  start() {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastData > this.stallMs) {
        this.log.warn({ stallMs: Date.now() - this.lastData }, 'ws stalled; forcing reconnect');
        this.ws.close(4000, 'stall');
      }
    }, Math.min(5000, this.stallMs));
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    this.ws?.close(1000, 'stop');
  }

  /** Test hook: simulate a dropped connection. */
  drop() {
    this.ws?.close(4001, 'drop');
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = async () => {
      this.attempt = 0;
      this.lastData = Date.now();
      this.subIds.clear();
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.log.info({ reconnect }, 'ws connected');
      try {
        for (const s of this.subs) await this.doSubscribe(s);
        this.emit(reconnect ? 'reconnected' : 'open');
      } catch (e) {
        this.log.error({ err: String(e) }, 'ws subscribe failed');
        ws.close(4002, 'subscribe failed');
      }
    };
    ws.onmessage = (m) => {
      this.lastData = Date.now();
      let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { subscription: string; result: unknown } };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method === 'eth_subscription' && msg.params) {
        this.subIds.get(msg.params.subscription)?.onData(msg.params.result);
      }
    };
    ws.onerror = (e) => this.log.warn({ err: String((e as ErrorEvent).message ?? e) }, 'ws error');
    ws.onclose = (e) => {
      for (const p of this.pending.values()) p.reject(new Error('ws closed'));
      this.pending.clear();
      this.emit('close', e.code);
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt) + Math.floor(Math.random() * 500);
      this.attempt++;
      this.log.warn({ code: e.code, delay }, 'ws closed; reconnecting');
      setTimeout(() => this.connect(), delay);
    };
  }

  request(method: string, params: unknown[]): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('ws not open'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`ws request timeout: ${method}`));
      }, 15_000);
    });
  }

  private async doSubscribe(s: WsSubscription) {
    const params = s.kind === 'newHeads' ? ['newHeads'] : ['logs', typeof s.params === 'function' ? (s.params as () => unknown)() : s.params];
    const id = (await this.request('eth_subscribe', params)) as string;
    this.subIds.set(id, s);
  }
}
