import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Cold path store. Never on the alert hot path: writes are small and synchronous-local, reads only in jobs/tools. */
export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reported_missing (
        chain_id INTEGER NOT NULL, address TEXT NOT NULL, symbol TEXT, reported_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, address));
      CREATE TABLE IF NOT EXISTS events (
        chain_id INTEGER NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, block INTEGER NOT NULL,
        t_ms INTEGER NOT NULL, emitter TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (chain_id, id));
      CREATE TABLE IF NOT EXISTS alert_fires (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chain_id INTEGER NOT NULL, type TEXT NOT NULL, channel TEXT,
        ping INTEGER NOT NULL, token TEXT, pool TEXT, usd REAL, price_at_fire REAL, lp_at_fire REAL,
        event_ms INTEGER NOT NULL, fired_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS holder_balances (
        chain_id INTEGER NOT NULL, token TEXT NOT NULL, holder TEXT NOT NULL, balance TEXT NOT NULL,
        PRIMARY KEY (chain_id, token, holder));
      CREATE TABLE IF NOT EXISTS precision_samples (
        fire_id INTEGER NOT NULL, horizon_sec INTEGER NOT NULL, due_ms INTEGER NOT NULL,
        price REAL, lp REAL, sampled_ms INTEGER, PRIMARY KEY (fire_id, horizon_sec));
      -- Edge scorecard (paper only). Every routed, scorable signal; sampled at SIGNAL_HORIZONS_SEC.
      CREATE TABLE IF NOT EXISTS signal_fires (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chain_id INTEGER NOT NULL, type TEXT NOT NULL, channel TEXT, ping INTEGER NOT NULL,
        token TEXT, symbol TEXT, venue TEXT, pool TEXT, direction TEXT NOT NULL, usd REAL, price_at_fire REAL, price_source TEXT,
        pool_fee INTEGER, pool_usdc_depth REAL, event_ms INTEGER NOT NULL, fired_ms INTEGER NOT NULL, detect_lag_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS signal_fires_chain_fired ON signal_fires (chain_id, fired_ms);
      CREATE TABLE IF NOT EXISTS signal_samples (
        fire_id INTEGER NOT NULL, horizon_sec INTEGER NOT NULL, due_ms INTEGER NOT NULL,
        price REAL, lp REAL, sampled_ms INTEGER, PRIMARY KEY (fire_id, horizon_sec));
      -- Pool metadata cache (written when PoolRegistry resolves a pool; filled by calibrate for history).
      CREATE TABLE IF NOT EXISTS pool_meta (
        chain_id INTEGER NOT NULL, pool TEXT NOT NULL, dex TEXT NOT NULL, token0 TEXT, token1 TEXT, fee INTEGER, factory TEXT,
        trusted INTEGER NOT NULL DEFAULT 0, usdc_side INTEGER, usdc_depth REAL, depth_ms INTEGER, updated_ms INTEGER NOT NULL,
        PRIMARY KEY (chain_id, pool));
    `);
  }

  /** Read-side index for scorecard/calibrate (price series by pool). Tools only — the live bot never needs it. */
  ensureScorecardIndexes() {
    this.db.exec('CREATE INDEX IF NOT EXISTS events_chain_emitter_t ON events (chain_id, emitter, t_ms)');
  }

  recordSignalFire(f: SignalFireRow, horizonsSec: number[]): number {
    const r = this.db
      .prepare(
        `INSERT INTO signal_fires (chain_id, type, channel, ping, token, symbol, venue, pool, direction, usd, price_at_fire, price_source,
           pool_fee, pool_usdc_depth, event_ms, fired_ms, detect_lag_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        f.chainId, f.type, f.channel ?? null, f.ping ? 1 : 0, f.token ?? null, f.symbol ?? null, f.venue ?? null, f.pool ?? null, f.direction,
        f.usd ?? null, f.priceAtFire ?? null, f.priceSource ?? null, f.poolFee ?? null, f.poolUsdcDepth ?? null, f.eventMs, f.firedMs, f.firedMs - f.eventMs,
      );
    const id = Number(r.lastInsertRowid);
    const ins = this.db.prepare('INSERT OR IGNORE INTO signal_samples (fire_id, horizon_sec, due_ms) VALUES (?, ?, ?)');
    for (const h of horizonsSec) ins.run(id, h, f.firedMs + h * 1000);
    return id;
  }

  dueSignalSamples(nowMs: number) {
    return this.db
      .prepare(
        `SELECT s.fire_id, s.horizon_sec, f.token, f.pool FROM signal_samples s JOIN signal_fires f ON f.id = s.fire_id
         WHERE s.sampled_ms IS NULL AND s.due_ms <= ? ORDER BY s.due_ms LIMIT 500`,
      )
      .all(nowMs) as { fire_id: number; horizon_sec: number; token: string | null; pool: string | null }[];
  }

  fillSignalSample(fireId: number, horizonSec: number, price: number | undefined, lp: number | undefined, nowMs: number) {
    this.db
      .prepare('UPDATE signal_samples SET price = ?, lp = ?, sampled_ms = ? WHERE fire_id = ? AND horizon_sec = ?')
      .run(price ?? null, lp ?? null, nowMs, fireId, horizonSec);
  }

  /** Upsert pool metadata. Known fields are never overwritten by unknown ones; trust follows the latest resolution. */
  upsertPoolMeta(chainId: number, m: PoolMetaInput, nowMs: number) {
    this.db
      .prepare(
        `INSERT INTO pool_meta (chain_id, pool, dex, token0, token1, fee, factory, trusted, usdc_side, usdc_depth, depth_ms, updated_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(chain_id, pool) DO UPDATE SET dex = excluded.dex, token0 = COALESCE(excluded.token0, token0),
           token1 = COALESCE(excluded.token1, token1), fee = COALESCE(excluded.fee, fee), factory = COALESCE(excluded.factory, factory),
           trusted = excluded.trusted, usdc_side = COALESCE(excluded.usdc_side, usdc_side),
           usdc_depth = COALESCE(excluded.usdc_depth, usdc_depth), depth_ms = COALESCE(excluded.depth_ms, depth_ms), updated_ms = excluded.updated_ms`,
      )
      .run(
        chainId, m.pool.toLowerCase(), m.dex, m.token0 ?? null, m.token1 ?? null, m.fee ?? null, m.factory ?? null, m.trusted ? 1 : 0,
        m.usdcSide ?? null, m.usdcDepth ?? null, m.usdcDepth !== undefined ? nowMs : null, nowMs,
      );
  }

  /** Record a USDC depth observation for an already-known pool (no-op if the pool has no meta row). */
  setPoolDepth(chainId: number, pool: string, depthUsd: number, nowMs: number) {
    this.db.prepare('UPDATE pool_meta SET usdc_depth = ?, depth_ms = ? WHERE chain_id = ? AND pool = ?').run(depthUsd, nowMs, chainId, pool.toLowerCase());
  }

  getPoolMeta(chainId: number, pool: string): PoolMetaRow | undefined {
    return this.db.prepare('SELECT * FROM pool_meta WHERE chain_id = ? AND pool = ?').get(chainId, pool.toLowerCase()) as PoolMetaRow | undefined;
  }

  getKv(k: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
    return r?.v;
  }

  setKv(k: string, v: string) {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  /** Returns only addresses not previously reported for this chain, and records them. */
  claimMissing(chainId: number, rows: { address: string; symbol: string }[], nowMs: number): { address: string; symbol: string }[] {
    const sel = this.db.prepare('SELECT 1 FROM reported_missing WHERE chain_id = ? AND address = ?');
    const ins = this.db.prepare('INSERT OR IGNORE INTO reported_missing (chain_id, address, symbol, reported_at) VALUES (?, ?, ?, ?)');
    const fresh = rows.filter((r) => !sel.get(chainId, r.address));
    for (const r of fresh) ins.run(chainId, r.address, r.symbol, nowMs);
    return fresh;
  }

  /** A CA that now has code clears its missing mark so a future disappearance re-reports. */
  clearMissing(chainId: number, address: string) {
    this.db.prepare('DELETE FROM reported_missing WHERE chain_id = ? AND address = ?').run(chainId, address);
  }

  insertEvent(chainId: number, id: string, kind: string, block: bigint, tMs: number, emitter: string, json: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO events (chain_id, id, kind, block, t_ms, emitter, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(chainId, id, kind, Number(block), tMs, emitter, json);
  }

  recordFire(f: {
    chainId: number;
    type: string;
    channel?: string;
    ping: boolean;
    token?: string;
    pool?: string;
    usd?: number;
    price?: number;
    lp?: number;
    eventMs: number;
    firedMs: number;
    horizonsSec: number[];
  }): number {
    const r = this.db
      .prepare(
        'INSERT INTO alert_fires (chain_id, type, channel, ping, token, pool, usd, price_at_fire, lp_at_fire, event_ms, fired_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(f.chainId, f.type, f.channel ?? null, f.ping ? 1 : 0, f.token ?? null, f.pool ?? null, f.usd ?? null, f.price ?? null, f.lp ?? null, f.eventMs, f.firedMs);
    const id = Number(r.lastInsertRowid);
    const ins = this.db.prepare('INSERT OR IGNORE INTO precision_samples (fire_id, horizon_sec, due_ms) VALUES (?, ?, ?)');
    for (const h of f.horizonsSec) ins.run(id, h, f.firedMs + h * 1000);
    return id;
  }

  dueSamples(nowMs: number) {
    return this.db
      .prepare(
        `SELECT s.fire_id, s.horizon_sec, f.token, f.pool FROM precision_samples s JOIN alert_fires f ON f.id = s.fire_id
         WHERE s.sampled_ms IS NULL AND s.due_ms <= ? ORDER BY s.due_ms LIMIT 200`,
      )
      .all(nowMs) as { fire_id: number; horizon_sec: number; token: string | null; pool: string | null }[];
  }

  fillSample(fireId: number, horizonSec: number, price: number | undefined, lp: number | undefined, nowMs: number) {
    this.db
      .prepare('UPDATE precision_samples SET price = ?, lp = ?, sampled_ms = ? WHERE fire_id = ? AND horizon_sec = ?')
      .run(price ?? null, lp ?? null, nowMs, fireId, horizonSec);
  }

  /** Atomic holder checkpoint: changed balances + snapshot (cursor, recent ids) in one transaction. */
  saveHolders(chainId: number, token: string, dirty: [string, bigint][], snapshot: object) {
    const up = this.db.prepare(
      'INSERT INTO holder_balances (chain_id, token, holder, balance) VALUES (?, ?, ?, ?) ON CONFLICT(chain_id, token, holder) DO UPDATE SET balance = excluded.balance',
    );
    const del = this.db.prepare('DELETE FROM holder_balances WHERE chain_id = ? AND token = ? AND holder = ?');
    this.db.exec('BEGIN');
    try {
      for (const [h, b] of dirty) {
        if (b === 0n) del.run(chainId, token, h);
        else up.run(chainId, token, h, b.toString());
      }
      this.setKv(`holders:${chainId}:${token}`, JSON.stringify(snapshot));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  loadHolders(chainId: number, token: string): { snapshot?: unknown; balances: [string, bigint][] } {
    const raw = this.getKv(`holders:${chainId}:${token}`);
    if (!raw) return { balances: [] };
    const rows = this.db.prepare('SELECT holder, balance FROM holder_balances WHERE chain_id = ? AND token = ?').all(chainId, token) as { holder: string; balance: string }[];
    return { snapshot: JSON.parse(raw), balances: rows.map((r) => [r.holder, BigInt(r.balance)]) };
  }

  clearHolders(chainId: number, token: string) {
    this.db.prepare('DELETE FROM holder_balances WHERE chain_id = ? AND token = ?').run(chainId, token);
    this.db.prepare('DELETE FROM kv WHERE k = ?').run(`holders:${chainId}:${token}`);
  }

  close() {
    this.db.close();
  }
}

export interface SignalFireRow {
  chainId: number;
  type: string;
  channel?: string;
  ping: boolean;
  token?: string;
  symbol?: string;
  venue?: string;
  pool?: string;
  direction: 'long' | 'avoid';
  usd?: number;
  priceAtFire?: number;
  priceSource?: string;
  poolFee?: number;
  poolUsdcDepth?: number;
  eventMs: number;
  firedMs: number;
}

export interface PoolMetaInput {
  pool: string;
  dex: 'univ2' | 'univ3';
  token0?: string;
  token1?: string;
  fee?: number;
  factory?: string;
  trusted: boolean;
  usdcSide?: 0 | 1;
  usdcDepth?: number;
}

export interface PoolMetaRow {
  chain_id: number;
  pool: string;
  dex: 'univ2' | 'univ3';
  token0: string | null;
  token1: string | null;
  fee: number | null;
  factory: string | null;
  trusted: number;
  usdc_side: 0 | 1 | null;
  usdc_depth: number | null;
  depth_ms: number | null;
  updated_ms: number;
}
