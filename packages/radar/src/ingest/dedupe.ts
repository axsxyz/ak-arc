/** Bounded set of seen ids (insertion-ordered eviction). WS + backfill overlap never double-processes a log. */
export class SeenSet {
  private s = new Set<string>();
  constructor(private readonly max = 100_000) {}
  /** Returns true if newly added, false if already seen. */
  add(id: string): boolean {
    if (this.s.has(id)) return false;
    this.s.add(id);
    if (this.s.size > this.max) {
      const first = this.s.values().next().value;
      if (first !== undefined) this.s.delete(first);
    }
    return true;
  }
  has(id: string) {
    return this.s.has(id);
  }
}
