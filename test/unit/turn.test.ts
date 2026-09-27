import { afterEach, describe, expect, it, vi } from "vitest";
import { PORT_53, dropPort53, hasTurnServer, hasUrls } from "@shared/ice";
import {
  DIAGNOSTICS_TURN_TTL_SECONDS,
  FAILED_MINT_CACHE_MS,
  TURN_TTL_SECONDS,
  getIceServers,
  revokeCredential,
} from "../../worker/turn";


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

  it("mintIceServers returns the TURN username so it can be revoked", async () => {
    const { mintIceServers } = await import("@worker/turn");
    vi.stubGlobal("fetch", async () =>
      Response.json({ iceServers: [{ urls: ["turn:h:3478"], username: "user-1", credential: "c" }] }),
    );
    try {
      const res = await mintIceServers({ TURN_KEY_ID: "k", TURN_API_TOKEN: "t" });
      expect(res.username).toBe("user-1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mintIceServers makes no API call with the kill switch on", async () => {
    const { mintIceServers } = await import("@worker/turn");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const res = await mintIceServers({ TURN_KEY_ID: "k", TURN_API_TOKEN: "t", TURN_DISABLED: "true" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(hasTurnServer(res.iceServers)).toBe(false);
      expect(res.username).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
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

describe("getIceServers per peer", () => {
  function fakeFetch(queue: Array<Response | Error>): { calls: { url: string; body: unknown }[] } {
    const state = { calls: [] as { url: string; body: unknown }[] };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const next = queue[Math.min(state.calls.length, queue.length - 1)];
      state.calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (next instanceof Error) throw next;
      return next!.clone();
    });
    return state;
  }

  const ok = (username: string) =>
    Response.json({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username, credential: "c" }] });

  afterEach(() => vi.unstubAllGlobals());

  const env = { TURN_KEY_ID: "k", TURN_API_TOKEN: "t" };

  it("mints a fresh credential for every join", async () => {
    const state = fakeFetch([ok("a"), ok("b")]);
    const backoff = { failedUntil: 0 };
    const first = await getIceServers(env, backoff);
    const second = await getIceServers(env, backoff);
    expect(state.calls.length).toBe(2);
    expect([first.username, second.username]).toEqual(["a", "b"]);
  });

  it("asks for the TTL it is given", async () => {
    const state = fakeFetch([ok("a")]);
    await getIceServers(env, { failedUntil: 0 }, DIAGNOSTICS_TURN_TTL_SECONDS);
    expect(state.calls[0]?.body).toEqual({ ttl: DIAGNOSTICS_TURN_TTL_SECONDS });
  });

  it("backs off for seconds, not the credential TTL, after a failed mint", async () => {
    // A mint that fails falls back to STUN only. The backoff spares Cloudflare one call
    // per join during an outage, but must be short: while it lasts nobody gets a relay.
    const state = fakeFetch([new Error("network down"), ok("a")]);
    const backoff = { failedUntil: 0 };

    const first = await getIceServers(env, backoff);
    expect(hasTurnServer(first.iceServers)).toBe(false);
    const wait = backoff.failedUntil - Date.now();
    expect(wait).toBeLessThanOrEqual(FAILED_MINT_CACHE_MS);
    expect(wait).toBeLessThan((TURN_TTL_SECONDS * 1000) / 10);

    // Inside the window: STUN only, no API call.
    const during = await getIceServers(env, backoff);
    expect(hasTurnServer(during.iceServers)).toBe(false);
    expect(state.calls.length).toBe(1);

    backoff.failedUntil = Date.now() - 1;
    const after = await getIceServers(env, backoff);
    expect(hasTurnServer(after.iceServers)).toBe(true);
    expect(state.calls.length).toBe(2);
  });

  it("does not back off when TURN is simply not configured", async () => {
    const backoff = { failedUntil: 0 };
    await getIceServers({ TURN_KEY_ID: "", TURN_API_TOKEN: "" }, backoff);
    expect(backoff.failedUntil).toBe(0);
  });
});

describe("revokeCredential", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the revoke endpoint for that username", async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(null, { status: 204 });
    });
    expect(await revokeCredential({ TURN_KEY_ID: "k", TURN_API_TOKEN: "t" }, "u/1")).toBe(true);
    expect(calls).toEqual([
      { url: "https://rtc.live.cloudflare.com/v1/turn/keys/k/credentials/u%2F1/revoke", method: "POST" },
    ]);
  });

  it("reports failure without throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    expect(await revokeCredential({ TURN_KEY_ID: "k", TURN_API_TOKEN: "t" }, "u")).toBe(false);
  });
});
