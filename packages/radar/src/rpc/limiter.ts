/** Token-bucket limiter: at most `rps` task starts per second, FIFO. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private queue: Array<() => void> = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly rps: number) {
    this.tokens = rps;
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => fn().then(resolve, reject));
      this.drain();
    });
  }

  private drain() {
    const now = Date.now();
    this.tokens = Math.min(this.rps, this.tokens + ((now - this.last) / 1000) * this.rps);
    this.last = now;
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, Math.ceil(1000 / this.rps));
    }
  }
}

/** Retry transient RPC failures (rate limits, timeouts) with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseMs = 250): Promise<T> {
  let err: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      if (!isTransient(e) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i + Math.random() * 100));
    }
  }
  throw err;
}

export function isTransient(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
  // "could not complete this request" = rpc.arc-scan.org burst throttling (observed 2026-09-14). Range errors are NOT
  // transient: callers split the range instead of retrying the same oversized request.
  // viem wording: -32005 "Request exceeds defined limit", -32603 "An internal error was received" (arc-scan 503s).
  return /429|rate|limit|timeout|timed out|econnreset|socket|503|502|fetch failed|could not complete|internal error/.test(msg) && !/range/.test(msg);
}
