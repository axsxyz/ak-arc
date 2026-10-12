import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEnv } from '../../src/config/load-env.js';
import { loadConfig } from '../../src/config/env.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const files = (m: Record<string, string>) => (p: string) => m[path.relative('/repo', p).replaceAll('\\', '/')];

describe('env precedence: shell > profile > .env', () => {
  it('profile overrides .env; shell overrides both', () => {
    const env: NodeJS.ProcessEnv = { ARC_PROFILE: 'mainnet-poll', RPC_MAX_RPS: '2' };
    const loaded = applyEnv(env, '/repo', files({
      '.env': 'ARC_NETWORK=testnet\nDISCORD_DRY_RUN=1\nRPC_MAX_RPS=10\nDISCORD_WH_ALERTS=https://secret',
      'config/profiles/mainnet-poll.env': 'ARC_NETWORK=mainnet\nRPC_MAX_RPS=8\nARC_MAINNET_WSS_URL=',
    }));
    expect(loaded).toMatch(/mainnet-poll\.env$/);
    expect(env).toMatchObject({ ARC_NETWORK: 'mainnet', RPC_MAX_RPS: '2', DISCORD_DRY_RUN: '1', DISCORD_WH_ALERTS: 'https://secret', ARC_MAINNET_WSS_URL: '' });
  });
  it('no profile = .env only; unknown profile fails loudly; names are sanitized', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyEnv(env, '/repo', files({ '.env': 'ARC_NETWORK=testnet' }))).toBeUndefined();
    expect(env.ARC_NETWORK).toBe('testnet');
    expect(() => applyEnv({ ARC_PROFILE: 'nope' }, '/repo', files({}))).toThrow(/not found/);
    expect(() => applyEnv({ ARC_PROFILE: '../.env' }, '/repo', files({}))).toThrow(/simple name/);
  });
  it('the shipped mainnet-poll profile yields a valid live mainnet HTTP-polling config', () => {
    const env: NodeJS.ProcessEnv = { ARC_PROFILE: 'mainnet-poll' };
    applyEnv(env, ROOT, (p) => (p.endsWith('.env') && !p.includes('profiles') ? '' : fs.readFileSync(p, 'utf8')));
    const c = loadConfig(env, { requireRpc: true, requireWssOnMainnet: true, cwd: ROOT });
    expect(c.network.chainId).toBe(5042);
    expect(c.httpUrl).toBe('https://rpc.arc-scan.org');
    expect(c.wssUrl).toBeUndefined();
    expect(c.allowMainnetHttpPolling).toBe(true);
    expect(c.warmStartHours).toBeGreaterThan(0);
    expect(c.discordDryRun).toBe(true); // profile does not touch kill-switches; default stays safe
  });
});
