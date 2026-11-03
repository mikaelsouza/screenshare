import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ipKey } from "@worker/ipkey";

describe("Fuzzing Suite: IP Key Normalizer (Feature 43)", () => {
  /**
   * Feature 43: Fuzz: IP Key Normalizer
   * Invariants:
   * 1. Never throws on arbitrary text, invalid hex, weird colons, percent signs.
   * 2. Idempotence: ipKey(ipKey(ip)) === ipKey(ip).
   * 3. IPv4 preservation.
   * 4. Mapped IPv6 unwrapping.
   * 5. IPv6 /64 CIDR canonicalization.
   */
  it("never throws on arbitrary strings or unicode", () => {
    fc.assert(
      fc.property(fc.string(), (ip) => {
        let result: string | undefined;
        expect(() => {
          result = ipKey(ip);
        }).not.toThrow();
        expect(typeof result).toBe("string");
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("proves idempotence: ipKey(ipKey(x)) === ipKey(x) for any input", () => {
    fc.assert(
      fc.property(fc.string(), (ip) => {
        const first = ipKey(ip);
        const second = ipKey(first);
        expect(second).toBe(first);
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("proves standard IPv4 addresses pass through unchanged", () => {
    const ipv4Arb = fc
      .tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 })
      )
      .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

    fc.assert(
      fc.property(ipv4Arb, (ipv4) => {
        expect(ipKey(ipv4)).toBe(ipv4);
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it("proves IPv4-mapped IPv6 unwraps to pure IPv4", () => {
    const mappedPrefixArb = fc.constantFrom("::ffff:", "0000:0000:0000:0000:0000:ffff:", "0:0:0:0:0:ffff:");
    const ipv4Arb = fc
      .tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 })
      )
      .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

    fc.assert(
      fc.property(mappedPrefixArb, ipv4Arb, (prefix, ipv4) => {
        const mapped = `${prefix}${ipv4}`;
        expect(ipKey(mapped)).toBe(ipv4);
        return true;
      }),
      { numRuns: 300 }
    );
  });

  it("proves IPv6 addresses with zone IDs or arbitrary hex map to /64 subnet", () => {
    const hextet = () => fc.stringMatching(/^[0-9a-f]{1,4}$/);
    const fullIpv6Arb = fc
      .tuple(hextet(), hextet(), hextet(), hextet(), hextet(), hextet(), hextet(), hextet())
      .map((parts) => parts.join(":"));
    const zoneIdArb = fc.constantFrom("", "%eth0", "%wlan0", "%12");

    fc.assert(
      fc.property(fullIpv6Arb, zoneIdArb, (ipv6, zone) => {
        const input = `${ipv6}${zone}`;
        const result = ipKey(input);
        expect(result).toMatch(/^[0-9a-f:]+::\/64$/);
        return true;
      }),
      { numRuns: 500 }
    );
  });
});
