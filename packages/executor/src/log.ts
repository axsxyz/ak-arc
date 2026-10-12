/**
 * Timestamped console logging shared by every stage. Same shape as the
 * original bridge.ts: `[+1.23s] message`, red ABORT on die (exit 2).
 */

export const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const t0 = Date.now();
export const elapsedMs = () => Date.now() - t0;
export const stamp = () => C.dim(`[+${(elapsedMs() / 1000).toFixed(2)}s]`);
export const log = (msg: string) => console.log(`${stamp()} ${msg}`);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AbortError extends Error {
  readonly exitCode = 2;
}

/** Registered by the entrypoint so an abort can still reach Discord (error.abort) before exit. */
let onAbort: ((msg: string) => Promise<void>) | undefined;
export function setAbortHook(fn: ((msg: string) => Promise<void>) | undefined) {
  onAbort = fn;
}

/**
 * Hard abort: print, notify (best effort, bounded), exit 2. Never a warning, never a retry.
 * Throws AbortError synchronously so callers' control flow stops even before the exit lands.
 */
export function die(msg: string): never {
  console.error(`\n${C.red('ABORT')} ${msg}\n`);
  const hook = onAbort;
  onAbort = undefined; // never recurse
  const finish = () => process.exit(2);
  if (hook) {
    void Promise.race([hook(msg).catch(() => undefined), sleep(3000)]).then(finish, finish);
  } else {
    finish();
  }
  throw new AbortError(msg);
}

export const fmtMs = (ms: number) => `${ms} ms`;
