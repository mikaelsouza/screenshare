import { describe, expect, it, vi } from "vitest";
import { PORT_53, dropPort53, hasUrls } from "@shared/ice";


describe("PORT_53", () => {
  it("matches a bare port 53", () => {
    expect(PORT_53.test("stun:stun.cloudflare.com:53")).toBe(true);
    expect(PORT_53.test("turn:turn.cloudflare.com:53?transport=udp")).toBe(true);
  });

  // The trap: a naive ":53" substring match also hits ":5349", which would silently
  // delete the TLS relay that restrictive networks depend on.
  it("does not match port 5349", () => {
    expect(PORT_53.test("turns:turn.cloudflare.com:5349?transport=tcp")).toBe(false);
  });

  it("does not match other ports containing 53", () => {
    for (const u of [
      "turn:turn.cloudflare.com:5300?transport=udp",
      "stun:stun.example.com:1053",
      "turns:turn.cloudflare.com:443?transport=tcp",
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:80?transport=tcp",
    ]) {
      expect(PORT_53.test(u), u).toBe(false);
    }
  });
});

describe("dropPort53", () => {
  it("removes only the port-53 endpoints from a Cloudflare-shaped entry", () => {
    // Exactly what Cloudflare's generate-ice-servers returns.
    const server = {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "u",
      credential: "c",
    };
    const out = dropPort53(server);
    expect(out.urls).toEqual([
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turn:turn.cloudflare.com:80?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turns:turn.cloudflare.com:443?transport=tcp",
    ]);
  });

  it("preserves credentials", () => {
    const out = dropPort53({ urls: ["turn:h:3478"], username: "u", credential: "c" });
    expect(out.username).toBe("u");
    expect(out.credential).toBe("c");
  });

  it("retains the TLS-on-443 fallback that restrictive networks need", () => {
    const out = dropPort53({ urls: ["turn:h:53?transport=udp", "turns:h:443?transport=tcp"] });
    expect(out.urls).toContain("turns:h:443?transport=tcp");
  });

  it("handles a single string url", () => {
    expect(dropPort53({ urls: "stun:stun.cloudflare.com:53" }).urls).toEqual([]);
    expect(dropPort53({ urls: "stun:stun.cloudflare.com:3478" }).urls).toEqual([
      "stun:stun.cloudflare.com:3478",
    ]);
  });
});

describe("hasUrls", () => {
  it("drops entries left with nothing after filtering", () => {
    expect(hasUrls({ urls: [] })).toBe(false);
    expect(hasUrls({ urls: ["stun:h:3478"] })).toBe(true);
    expect(hasUrls({ urls: "stun:h:3478" })).toBe(true);
  });
});

describe("worker turn credentials", () => {
  it("mintIceServers falls back to STUN when secrets are not configured", async () => {
    const { mintIceServers } = await import("@worker/turn");
    const env = { TURN_KEY_ID: "", TURN_API_TOKEN: "" } as unknown as import("@worker/turn").TurnEnv;
    const res = await mintIceServers(env);
    expect(res.iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
  });

  it("mintIceServers fetches from Cloudflare TURN API and drops port 53", async () => {
    const { mintIceServers } = await import("@worker/turn");
    const originalFetch = globalThis.fetch;
    const mockResponse = {
      iceServers: [
        { urls: ["turn:turn.cloudflare.com:53?transport=udp", "turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" },
      ],
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    try {
      const env = { TURN_KEY_ID: "key123", TURN_API_TOKEN: "token123" } as unknown as import("@worker/turn").TurnEnv;
      const res = await mintIceServers(env);
      expect(res.iceServers.length).toBe(2);
      expect(res.iceServers[0]?.urls).toEqual(["stun:stun.cloudflare.com:3478"]);
      expect(res.iceServers[1]?.urls).toEqual(["turn:turn.cloudflare.com:3478?transport=udp"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mintIceServers degrades to STUN when Cloudflare TURN API returns error", async () => {
    const { mintIceServers } = await import("@worker/turn");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
    });

    try {
      const env = { TURN_KEY_ID: "key123", TURN_API_TOKEN: "token123" } as unknown as import("@worker/turn").TurnEnv;
      const res = await mintIceServers(env);
      expect(res.iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mintIceServers degrades to STUN when fetch throws an error", async () => {
    const { mintIceServers } = await import("@worker/turn");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network failure"));

    try {
      const env = { TURN_KEY_ID: "key123", TURN_API_TOKEN: "token123" } as unknown as import("@worker/turn").TurnEnv;
      const res = await mintIceServers(env);
      expect(res.iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mintIceServers handles response when iceServers field is missing or not an array", async () => {
    const { mintIceServers } = await import("@worker/turn");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    try {
      const env = { TURN_KEY_ID: "key123", TURN_API_TOKEN: "token123" } as unknown as import("@worker/turn").TurnEnv;
      const res = await mintIceServers(env);
      expect(res.iceServers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getIceServers returns cached servers when valid", async () => {
    const { getIceServers } = await import("@worker/turn");
    const env = { TURN_KEY_ID: "", TURN_API_TOKEN: "" } as unknown as import("@worker/turn").TurnEnv;
    const cache = {
      current: {
        iceServers: [{ urls: "stun:cached.com" }],
        expiresAt: Date.now() + 100_000,
      },
    };

    const servers = await getIceServers(env, cache);
    expect(servers).toEqual([{ urls: "stun:cached.com" }]);
  });

  it("getIceServers refreshes cache when expired", async () => {
    const { getIceServers } = await import("@worker/turn");
    const env = { TURN_KEY_ID: "", TURN_API_TOKEN: "" } as unknown as import("@worker/turn").TurnEnv;
    const cache = {
      current: {
        iceServers: [{ urls: "stun:expired.com" }],
        expiresAt: Date.now() - 1000,
      },
    };

    const servers = await getIceServers(env, cache);
    expect(servers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
    expect(cache.current?.expiresAt).toBeGreaterThan(Date.now());
  });
});
