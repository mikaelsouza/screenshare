import { describe, expect, it } from "vitest";
import { ipKey } from "../../worker/ipkey";

describe("ipKey", () => {
  it("keys IPv4 addresses as they are", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("keys every address in one IPv6 /64 the same", () => {
    const a = ipKey("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    const b = ipKey("2001:db8:1234:5678::1");
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:1234:5678::/64");
  });

  it("keys different /64s differently", () => {
    expect(ipKey("2001:db8:1234:5678::1")).not.toBe(ipKey("2001:db8:1234:5679::1"));
  });

  it("normalises case and leading zeros", () => {
    expect(ipKey("2001:0DB8:0000:0001::1")).toBe("2001:db8:0:1::/64");
  });

  it("handles a compressed prefix", () => {
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("2001:db8::")).toBe("2001:db8:0:0::/64");
  });

  it("keys IPv4-mapped IPv6 as the IPv4 address", () => {
    expect(ipKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(ipKey("0:0:0:0:0:ffff:198.51.100.4")).toBe("198.51.100.4");
  });

  it("passes through something it cannot parse rather than throwing", () => {
    expect(ipKey("not:an:address::x::y")).toBe("not:an:address::x::y");
  });

  it("preserves tail hextets needed for the /64 prefix", () => {
    expect(ipKey("1::2:3:4:5:6:7")).toBe("1:0:2:3::/64");
  });

  it("rejects addresses with invalid characters in the tail", () => {
    expect(ipKey("2001:db8::zzzz")).toBe("2001:db8::zzzz");
  });

  it("handles trimming, zone IDs, exact 8-group validation, and invalid compression lengths", () => {
    expect(ipKey("  203.0.113.7  ")).toBe("203.0.113.7");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    // 7 groups without :: is invalid -> pass through
    expect(ipKey("1:2:3:4:5:6:7")).toBe("1:2:3:4:5:6:7");
    // 9 groups without :: is invalid -> pass through
    expect(ipKey("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    // 8 groups WITH :: (missing === 0) is invalid -> pass through
    expect(ipKey("1:2:3:4::5:6:7:8")).toBe("1:2:3:4::5:6:7:8");
    // Hextet > 4 chars -> pass through
    expect(ipKey("2001:db8::12345")).toBe("2001:db8::12345");
    // Non-IPv4-mapped ffff prefix does not match IPv4-mapped regex
    expect(ipKey("1:0:0:0:0:ffff:198.51.100.4")).toBe("1:0:0:0:0:ffff:198.51.100.4");
  });
});

