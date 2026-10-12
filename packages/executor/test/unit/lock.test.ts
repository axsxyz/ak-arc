import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tryAcquireLock } from '../../src/chain.js';
import type { Address } from 'viem';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'executor-lock-'));
}

describe('lock: keyed per wallet, so unrelated signers never block each other', () => {
  it('the lock file name includes the (lowercased) signer address', () => {
    const cwd = tmpCwd();
    const r = tryAcquireLock(cwd, A);
    expect('release' in r).toBe(true);
    if ('release' in r) {
      expect(fs.existsSync(path.join(cwd, 'data', `executor-${A.toLowerCase()}.lock`))).toBe(true);
      r.release();
    }
  });
  it('two DIFFERENT wallets acquire concurrently in the same cwd without blocking each other', () => {
    const cwd = tmpCwd();
    const ra = tryAcquireLock(cwd, A);
    const rb = tryAcquireLock(cwd, B);
    expect('release' in ra).toBe(true);
    expect('release' in rb).toBe(true);
    if ('release' in ra) ra.release();
    if ('release' in rb) rb.release();
  });
  it('a mixed-case address collides with its lowercase counterpart (same wallet, same lock)', () => {
    const cwd = tmpCwd();
    const r1 = tryAcquireLock(cwd, A);
    expect('release' in r1).toBe(true);
    const upper = A.toUpperCase() as Address;
    const r2 = tryAcquireLock(cwd, upper);
    expect('holder' in r2).toBe(true); // same underlying lock file, already held
    if ('release' in r1) r1.release();
  });
  it('the SAME wallet cannot acquire twice while the first holder is live', () => {
    const cwd = tmpCwd();
    const r1 = tryAcquireLock(cwd, A);
    expect('release' in r1).toBe(true);
    const r2 = tryAcquireLock(cwd, A);
    expect('holder' in r2).toBe(true);
    if ('holder' in r2) expect(r2.holder).toBe(process.pid); // our own pid: reads as alive
    if ('release' in r1) r1.release();
  });
  it('a stale lock (pid not found) is taken over automatically', () => {
    const cwd = tmpCwd();
    const dir = path.join(cwd, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `executor-${A.toLowerCase()}.lock`);
    fs.writeFileSync(file, '999999999'); // a pid essentially guaranteed not to exist
    const r = tryAcquireLock(cwd, A);
    expect('release' in r).toBe(true);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(String(process.pid));
    if ('release' in r) r.release();
  });
  it('release() removes the lock file, freeing it for the next acquire', () => {
    const cwd = tmpCwd();
    const file = path.join(cwd, 'data', `executor-${A.toLowerCase()}.lock`);
    const r1 = tryAcquireLock(cwd, A);
    if ('release' in r1) r1.release();
    expect(fs.existsSync(file)).toBe(false);
    const r2 = tryAcquireLock(cwd, A);
    expect('release' in r2).toBe(true);
    if ('release' in r2) r2.release();
  });
});
