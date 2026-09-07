/**
 * Fixed-window per-key request throttle with a bounded footprint.
 *
 * Extracted from the Worker entry point so the eviction path can be tested with a
 * small capacity instead of ten thousand synthetic requests.
 *
 * A caveat that applies wherever this is used from a Worker: an instance lives and
 * dies with its isolate and is not shared between them, so the effective ceiling is
 * `max` multiplied by however many isolates Cloudflare has running, not a global
 * `max`. That is acceptable for blunting a trivial flood; a genuinely global limit
 * would need a Durable Object.
 */
export class RateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    /**
     * Cap on tracked keys. Without one the map only ever grows — an entry is created
     * per distinct client address and otherwise never removed — so a scan from many
     * source addresses inflates it for the isolate's whole lifetime.
     */
    private readonly maxEntries: number,
  ) {}

  /** Visible for tests: how many keys are currently tracked. */
  get size(): number {
    return this.entries.size;
  }

  /** True if the request is allowed; false if the key is over its budget. */
  check(key: string, now: number = Date.now()): boolean {
    if (this.entries.size >= this.maxEntries) {
      this.evict(now);
    }

    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) {
      return false;
    }
    entry.count++;
    return true;
  }

  private evict(now: number): void {
    // Expired entries first: they carry no information and are free to drop. The walk
    // is O(n), which is why it runs only when the map is actually large rather than on
    // every request.
    for (const [key, value] of this.entries) {
      if (value.resetAt <= now) this.entries.delete(key);
    }
    if (this.entries.size < this.maxEntries) return;

    // Everything is still live. Drop the half closest to expiring: losing a few
    // counters lets some requests through that would have been throttled, which is a
    // much better failure than growing without bound.
    const victims = [...this.entries.entries()]
      .sort((a, b) => a[1].resetAt - b[1].resetAt)
      .slice(0, Math.ceil(this.maxEntries / 2));
    for (const [key] of victims) this.entries.delete(key);
  }
}
