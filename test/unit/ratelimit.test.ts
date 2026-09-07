import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../worker/ratelimit";

describe("RateLimiter", () => {
  it("allows up to the limit and then refuses, per key", () => {
    const rl = new RateLimiter(3, 60_000, 100);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false);
    // A different key has its own budget.
    expect(rl.check("b", 0)).toBe(true);
  });

  it("starts a fresh window once the old one expires", () => {
    const rl = new RateLimiter(1, 1_000, 100);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 500)).toBe(false);
    expect(rl.check("a", 1_001)).toBe(true);
  });

  it("does not grow past its entry cap", () => {
    // The bug this guards: one entry per distinct IP, never removed, so a scan from
    // many source addresses inflated the map for the isolate's whole lifetime.
    const rl = new RateLimiter(20, 60_000, 10);
    for (let i = 0; i < 500; i++) {
      rl.check(`ip-${i}`, 0);
    }
    expect(rl.size).toBeLessThanOrEqual(10);
  });

  it("reclaims expired entries before evicting live ones", () => {
    const rl = new RateLimiter(20, 1_000, 10);
    for (let i = 0; i < 10; i++) rl.check(`old-${i}`, 0);
    expect(rl.size).toBe(10);

    // Every entry above has expired by now, so the newcomer costs nothing live.
    rl.check("fresh", 5_000);
    expect(rl.size).toBe(1);
    // And its budget is intact, i.e. it was inserted rather than swallowed by eviction.
    expect(rl.check("fresh", 5_000)).toBe(true);
  });

  it("keeps counting correctly for a key that survives an eviction sweep", () => {
    const rl = new RateLimiter(2, 60_000, 4);
    // "keep" expires last, so the "drop the soonest-expiring half" rule spares it.
    rl.check("a", 0);
    rl.check("b", 1);
    rl.check("c", 2);
    rl.check("keep", 3);
    expect(rl.check("keep", 3)).toBe(true);
    expect(rl.check("keep", 3)).toBe(false);
  });
});
