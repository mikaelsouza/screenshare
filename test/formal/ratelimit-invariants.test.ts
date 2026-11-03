import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { RateLimiter } from "@worker/ratelimit";

describe("Formal Invariants: Rate Limiting (Feature 38)", () => {
  /**
   * Feature 38: Formal Invariant: Rate Limits & Token Monotonicity
   * - Monotonic budget bounds: for any key, check() returns true at most `max` times within windowMs.
   * - Bounded capacity: limiter.size never exceeds maxEntries.
   * - Window progression: after windowMs elapses, quota is completely restored.
   */
  describe("Budget Ceiling & Window Expiration Invariants", () => {
    it("proves strict budget ceiling: check() allows at most `max` requests per window", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }), // max
          fc.integer({ min: 100, max: 10000 }), // windowMs
          fc.string({ minLength: 1, maxLength: 20 }), // key
          fc.integer({ min: 1, max: 200 }), // number of requests
          (max, windowMs, key, numRequests) => {
            const limiter = new RateLimiter(max, windowMs, 1000);
            const now = 100000;
            let allowedCount = 0;

            for (let i = 0; i < numRequests; i++) {
              // all requests happen at the exact same instant `now`
              const allowed = limiter.check(key, now);
              if (allowed) allowedCount++;
            }

            // Invariant 1: allowedCount must never exceed max
            expect(allowedCount).toBeLessThanOrEqual(max);
            // Invariant 2: allowedCount must exactly equal min(numRequests, max)
            expect(allowedCount).toBe(Math.min(numRequests, max));
            return true;
          }
        ),
        { numRuns: 500 }
      );
    });

    it("proves window reset: full budget restores when now >= resetAt", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1000, max: 10000 }),
          fc.string({ minLength: 1, maxLength: 10 }),
          (max, windowMs, key) => {
            const limiter = new RateLimiter(max, windowMs, 100);
            let time = 10000;

            // Exhaust budget
            for (let i = 0; i < max; i++) {
              expect(limiter.check(key, time)).toBe(true);
            }
            expect(limiter.check(key, time)).toBe(false);

            // Advance time past the window
            time += windowMs + 1;

            // Invariant: Next request must be allowed and start a fresh window
            expect(limiter.check(key, time)).toBe(true);

            // And can consume max - 1 additional requests
            for (let i = 0; i < max - 1; i++) {
              expect(limiter.check(key, time)).toBe(true);
            }
            // But max + 1 request in the new window is blocked
            expect(limiter.check(key, time)).toBe(false);
            return true;
          }
        ),
        { numRuns: 300 }
      );
    });
  });

  describe("Memory Boundedness & Eviction Invariants", () => {
    it("proves footprint invariance: limiter.size never exceeds maxEntries under arbitrary loads", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5, max: 30 }), // maxEntries
          fc.array(
            fc.record({
              key: fc.stringMatching(/^[a-z0-9]{1,5}$/),
              timeOffset: fc.integer({ min: 0, max: 50000 }),
            }),
            { minLength: 10, maxLength: 200 }
          ),
          (maxEntries, requests) => {
            const limiter = new RateLimiter(5, 5000, maxEntries);
            let baseTime = 10000;

            for (const req of requests) {
              const currentTime = baseTime + req.timeOffset;
              limiter.check(req.key, currentTime);

              // Invariant: Footprint must remain bounded at or below maxEntries
              expect(limiter.size).toBeLessThanOrEqual(maxEntries);
            }
            return true;
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});
