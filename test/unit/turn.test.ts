import { afterEach, describe, expect, it, vi } from "vitest";
import { PORT_53, dropPort53, hasTurnServer, hasUrls } from "@shared/ice";
import type { IceServerConfig } from "@shared/protocol";
import { FAILED_MINT_CACHE_MS, TURN_TTL_SECONDS, getIceServers } from "../../worker/turn";


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

describe("hasTurnServer", () => {
  it("is false for a STUN-only list", () => {
    // This is exactly what the client receives when TURN_KEY_ID/TURN_API_TOKEN are
    // unset, when minting throws, and whenever the STUN-only fallback is used.
    expect(hasTurnServer([{ urls: "stun:stun.cloudflare.com:3478" }])).toBe(false);
    expect(hasTurnServer([])).toBe(false);
  });

  it("finds a relay however the list is shaped", () => {
    expect(hasTurnServer([{ urls: "turn:turn.cloudflare.com:3478?transport=udp" }])).toBe(true);
    expect(hasTurnServer([{ urls: "turns:turn.cloudflare.com:443?transport=tcp" }])).toBe(true);
    expect(
      hasTurnServer([{ urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478"] }]),
    ).toBe(true);
    expect(
      hasTurnServer([{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "turns:h:5349" }]),
    ).toBe(true);
  });

  it("does not mistake a hostname containing 'turn' for a relay", () => {
    expect(hasTurnServer([{ urls: "stun:returning.example.com:3478" }])).toBe(false);
  });
});

describe("getIceServers caching", () => {
  const OK_RESPONSE = {
    iceServers: [
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" },
    ],
  };

  function fakeFetch(queue: Array<Response | Error>): { calls: number } {
    const state = { calls: 0 };
    vi.stubGlobal("fetch", async () => {
      const next = queue[Math.min(state.calls, queue.length - 1)];
      state.calls++;
      if (next instanceof Error) throw next;
      return next!.clone();
    });
    return state;
  }

  afterEach(() => vi.unstubAllGlobals());

  const env = { TURN_KEY_ID: "k", TURN_API_TOKEN: "t" };

  it("serves a successful mint from cache instead of re-minting", async () => {
    const calls = fakeFetch([Response.json(OK_RESPONSE)]);
    const cache: { current: null | { iceServers: IceServerConfig[]; expiresAt: number } } = { current: null };
    await getIceServers(env, cache);
    await getIceServers(env, cache);
    expect(calls.calls).toBe(1);
  });

  it("retries a failed mint in seconds, not after the credential TTL", async () => {
    // A mint that fails falls back to STUN only. Caching that for the full TTL left the
    // room with no relay for nearly two hours on one transient error: every pair behind
    // a symmetric NAT silently fails, and relay-only is unavailable to everyone.
    const calls = fakeFetch([new Error("network down"), Response.json(OK_RESPONSE)]);
    const cache: { current: null | { iceServers: IceServerConfig[]; expiresAt: number } } = { current: null };

    const first = await getIceServers(env, cache);
    expect(hasTurnServer(first)).toBe(false);

    const ttl = cache.current!.expiresAt - Date.now();
    expect(ttl).toBeLessThanOrEqual(FAILED_MINT_CACHE_MS);
    // Emphatically shorter than the success TTL, which is close to two hours.
    expect(ttl).toBeLessThan(TURN_TTL_SECONDS * 1000 / 10);

    // Once that short window lapses the next join mints again, and now succeeds.
    cache.current!.expiresAt = Date.now() - 1;
    const second = await getIceServers(env, cache);
    expect(hasTurnServer(second)).toBe(true);
    expect(calls.calls).toBe(2);
  });

  it("gives a successful mint the long TTL", async () => {
    fakeFetch([Response.json(OK_RESPONSE)]);
    const cache: { current: null | { iceServers: IceServerConfig[]; expiresAt: number } } = { current: null };
    await getIceServers(env, cache);
    expect(cache.current!.expiresAt - Date.now()).toBeGreaterThan(TURN_TTL_SECONDS * 1000 / 2);
  });
});
