/** Injectable clock so fixtures/tests are deterministic. Milliseconds since epoch. */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  set(t: number) {
    this.t = t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}
