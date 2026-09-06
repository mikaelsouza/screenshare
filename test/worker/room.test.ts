import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ROOM_SIZE, PING, PONG, type ServerMessage } from "@shared/protocol";

const CODE2 = "JKMNPQRS";

/**
 * Every test gets its own room code, so a Durable Object is never shared between
 * tests. Sockets are closed without awaiting the server's webSocketClose, so a
 * shared code let one test's peers still occupy the room when the next one started —
 * which made the room-full test read `room-full` where it expected `welcome`.
 */
let roomCounter = 0;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function freshRoom(): string {
  roomCounter++;
  let n = roomCounter;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[n % ALPHABET.length] + out;
    n = Math.floor(n / ALPHABET.length);
  }
  return out;
}

let CODE = freshRoom();
beforeEach(() => {
  CODE = freshRoom();
});

/** A connected client with a queue, so tests can await specific messages. */
class Client {
  private queue: ServerMessage[] = [];
  private waiters: Array<(m: ServerMessage) => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const raw = String((ev as MessageEvent).data);
      if (raw === PONG || raw === PING) return;
      const msg = JSON.parse(raw) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  static async connect(room?: string, extraHeaders?: Record<string, string>): Promise<Client> {
    room = room ?? CODE;
    const res = await SELF.fetch(`https://example.com/ws/${room}`, {
      headers: { Upgrade: "websocket", ...extraHeaders },
    });
    if (!res.webSocket) throw new Error(`no webSocket on response (status ${res.status})`);
    res.webSocket.accept();
    return new Client(res.webSocket);
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next message, or throw on timeout so a missing message fails loudly. */
  next(timeoutMs = 2000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = (m: ServerMessage): void => {
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(() => {
        // Remove the waiter, or the next message is handed to this already-settled
        // promise and lost instead of being queued — which silently breaks any read
        // that follows a deliberate timeout such as silentFor().
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error("timed out waiting for message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Await the next message of a given type, discarding others. */
  async nextOf<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    for (let i = 0; i < 10; i++) {
      const m = await this.next();
      if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
    }
    throw new Error(`never received a "${t}" message`);
  }

  async join(name = "tester"): Promise<Extract<ServerMessage, { t: "welcome" }>> {
    this.send({ t: "join", room: CODE, displayName: name });
    return this.nextOf("welcome");
  }

  /** True if nothing arrives within the window — used to assert isolation. */
  async silentFor(ms = 300): Promise<boolean> {
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

describe("HTTP routing", () => {
  it("rejects an invalid room code before reaching the Durable Object", async () => {
    const res = await SELF.fetch("https://example.com/ws/nope", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(400);
  });

  it("rejects a room code that could traverse into another object's namespace", async () => {
    const res = await SELF.fetch("https://example.com/ws/../secret", { headers: { Upgrade: "websocket" } });
    expect(res.status).not.toBe(101);
  });

  it("rejects a non-websocket request to the room endpoint", async () => {
    const res = await SELF.fetch(`https://example.com/ws/${CODE}`);
    expect(res.status).toBe(426);
  });

  it("mints a valid room code", async () => {
    const res = await SELF.fetch("https://example.com/api/room");
    expect(res.status).toBe(200);
    const { code } = (await res.json()) as { code: string };
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });

  it("rejects cross-origin websocket upgrade attempts", async () => {
    const res = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: {
        Upgrade: "websocket",
        Origin: "https://evil-attacker.com",
      },
    });
    expect(res.status).toBe(403);
  });

  it("accepts same-origin websocket upgrade attempts", async () => {
    const res = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: {
        Upgrade: "websocket",
        Origin: "https://example.com",
      },
    });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("enforces rate limits on room creation per IP", async () => {
    const ip = "198.51.100.42";
    for (let i = 0; i < 20; i++) {
      const res = await SELF.fetch("https://example.com/api/room", {
        headers: { "CF-Connecting-IP": ip },
      });
      expect(res.status).toBe(200);
    }
    // 21st request should be rate limited
    const limited = await SELF.fetch("https://example.com/api/room", {
      headers: { "CF-Connecting-IP": ip },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    const body = (await limited.json()) as { error: string };
    expect(body.error).toBe("Rate limit exceeded");

    // A different IP should still be allowed
    const otherIpRes = await SELF.fetch("https://example.com/api/room", {
      headers: { "CF-Connecting-IP": "198.51.100.99" },
    });
    expect(otherIpRes.status).toBe(200);
  });

  it("rejects malformed origin header", async () => {
    const res = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: {
        Upgrade: "websocket",
        Origin: "http://[invalid-url",
      },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Invalid origin");
  });

  it("applies strict security headers to static asset responses", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Permissions-Policy")).toContain("display-capture=(self)");
  });
});

describe("RoomDO membership", () => {
  it("welcomes the first peer to an empty room", async () => {
    const a = await Client.connect();
    const welcome = await a.join("alice");
    expect(welcome.selfId).toBeTruthy();
    expect(welcome.peers).toEqual([]);
    a.close();
  });

  it("delivers ICE servers with the welcome, so a joined socket is the authorisation", async () => {
    const a = await Client.connect();
    const welcome = await a.join("alice");
    expect(Array.isArray(welcome.iceServers)).toBe(true);
    a.close();
  });

  it("degrades to STUN-only when TURN secrets are unset, rather than blocking the join", async () => {
    // No TURN secrets are configured under test. Direct P2P needs no TURN at all, so
    // the join must still succeed and hand back a usable STUN-only configuration.
    const a = await Client.connect();
    const welcome = await a.join("alice");
    expect(welcome.selfId).toBeTruthy();

    const urls = JSON.stringify(welcome.iceServers);
    expect(urls).toContain("stun:");
    expect(urls).not.toContain("turn:");
    a.close();
  });

  it("tells a joiner who is already present, and tells the room about the joiner", async () => {
    const a = await Client.connect();
    const w1 = await a.join("alice");

    const b = await Client.connect();
    const w2 = await b.join("bob");

    expect(w2.peers.map((p) => p.name)).toEqual(["alice"]);
    expect(w2.peers[0]?.id).toBe(w1.selfId);

    const joined = await a.nextOf("peer-joined");
    expect(joined.peer).toMatchObject({ id: w2.selfId, name: "bob", sharing: false });

    a.close();
    b.close();
  });

  it("assigns distinct ids to every peer", async () => {
    const clients = await Promise.all([Client.connect(), Client.connect(), Client.connect()]);
    const ids: string[] = [];
    for (const c of clients) ids.push((await c.join()).selfId);
    expect(new Set(ids).size).toBe(3);
    for (const c of clients) c.close();
  });

  it("ignores a duplicate join on the same socket", async () => {
    const a = await Client.connect();
    await a.join("alice");
    a.send({ t: "join", room: CODE, displayName: "alice-again" });
    expect(await a.silentFor(300)).toBe(true);
    a.close();
  });

  it("sanitises and caps the display name", async () => {
    const a = await Client.connect();
    await a.join("  " + "x".repeat(200) + "  ");
    const b = await Client.connect();
    const w = await b.join("bob");
    expect(w.peers[0]?.name.length).toBeLessThanOrEqual(32);
    a.close();
    b.close();
  });

  it("falls back to a placeholder for a blank display name", async () => {
    const a = await Client.connect();
    await a.join("   ");
    const b = await Client.connect();
    const w = await b.join("bob");
    expect(w.peers[0]?.name).toBe("Anonymous");
    a.close();
    b.close();
  });

  it(`enforces the ${MAX_ROOM_SIZE}-peer cap that the mesh bandwidth budget assumes`, async () => {
    const joined: Client[] = [];
    for (let i = 0; i < MAX_ROOM_SIZE; i++) {
      const c = await Client.connect();
      await c.join(`peer${i}`);
      joined.push(c);
    }

    const overflow = await Client.connect();
    overflow.send({ t: "join", room: CODE, displayName: "one-too-many" });
    const err = await overflow.nextOf("error");
    expect(err.code).toBe("room-full");

    overflow.close();
    for (const c of joined) c.close();
  });

  it("frees a slot when a peer leaves", async () => {
    const joined: Client[] = [];
    for (let i = 0; i < MAX_ROOM_SIZE; i++) {
      const c = await Client.connect();
      await c.join(`peer${i}`);
      joined.push(c);
    }
    joined[0]?.close();
    await new Promise((r) => setTimeout(r, 200));

    const late = await Client.connect();
    const welcome = await late.join("late");
    expect(welcome.peers.length).toBe(MAX_ROOM_SIZE - 1);

    late.close();
    for (const c of joined.slice(1)) c.close();
  });

  // Regression: the room cap counts only joined peers, and fetch() accepted every
  // upgrade, so a client could open unbounded sockets that never send `join` and make
  // every later signalling message in that room walk all of them.
  it("caps total sockets so unjoined connections cannot pile up", async () => {
    const open: Client[] = [];
    let rejected = 0;
    // Well past MAX_ROOM_SIZE, and none of these ever send `join`.
    for (let i = 0; i < MAX_ROOM_SIZE * 4 + 4; i++) {
      try {
        open.push(await Client.connect());
      } catch {
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(0);
    for (const c of open) c.close();
  });

  it("returns 429 rather than accepting an unbounded number of sockets", async () => {
    const open: Client[] = [];
    for (let i = 0; i < MAX_ROOM_SIZE * 4; i++) {
      try { open.push(await Client.connect()); } catch { break; }
    }
    const res = await SELF.fetch(`https://example.com/ws/${CODE}`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(429);
    for (const c of open) c.close();
  });

  it("broadcasts peer-left when a socket closes", async () => {
    const a = await Client.connect();
    const wa = await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    a.close();
    const left = await b.nextOf("peer-left");
    expect(left.id).toBe(wa.selfId);
    b.close();
  });

  it("enforces room password when configured by first peer", async () => {
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "super-secret" });
    const wa = await a.nextOf("welcome");
    expect(wa.selfId).toBeDefined();

    // Second peer joins with wrong password -> rejected
    const b = await Client.connect();
    b.send({ t: "join", room: CODE, displayName: "bob", password: "wrong-password" });
    const err = await b.nextOf("error");
    expect(err.code).toBe("bad-password");
    b.close();

    // Second peer joins with missing password -> rejected
    const c = await Client.connect();
    c.send({ t: "join", room: CODE, displayName: "charlie" });
    const err2 = await c.nextOf("error");
    expect(err2.code).toBe("bad-password");
    c.close();

    // Second peer joins with correct password -> accepted
    const d = await Client.connect();
    d.send({ t: "join", room: CODE, displayName: "dave", password: "super-secret" });
    const wd = await d.nextOf("welcome");
    expect(wd.selfId).toBeDefined();

    a.close();
    d.close();
  });

  it("caps total sockets per IP address to prevent mesh/uplink flooding", async () => {
    const ip = "203.0.113.88";
    const sockets: Client[] = [];
    for (let i = 0; i < 5; i++) {
      sockets.push(await Client.connect(CODE, { "CF-Connecting-IP": ip }));
    }

    // 6th connection from the same IP should be rejected with 429
    const res = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
    });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("Too many connections from this IP");

    // A connection from another IP succeeds
    const another = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.89" });
    expect(another).toBeDefined();
    another.close();

    for (const s of sockets) s.close();
  });

  it("resets room password once all peers leave the room", async () => {
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "initial-password" });
    const wa = await a.nextOf("welcome");
    expect(wa.selfId).toBeDefined();

    // Bob joins with password -> success
    const b = await Client.connect();
    b.send({ t: "join", room: CODE, displayName: "bob", password: "initial-password" });
    await b.nextOf("welcome");

    // Bob leaves
    b.close();
    await new Promise((r) => setTimeout(r, 50));

    // Alice leaves -> room becomes empty
    a.close();
    await new Promise((r) => setTimeout(r, 100));

    // Charlie connects and joins without password -> allowed because password cleared on room reset
    const c = await Client.connect();
    c.send({ t: "join", room: CODE, displayName: "charlie" });
    const wc = await c.nextOf("welcome");
    expect(wc.selfId).toBeDefined();
    c.close();
  });
});

describe("RoomDO signalling", () => {
  it("forwards a signal to the addressed peer, verbatim", async () => {
    const a = await Client.connect();
    const wa = await a.join("alice");
    const b = await Client.connect();
    const wb = await b.join("bob");
    await a.nextOf("peer-joined");

    const data = { k: "offer", sdp: "v=0\r\na=rtpmap:111 opus/48000/2\r\n" };
    a.send({ t: "signal", to: wb.selfId, data });

    const got = await b.nextOf("signal");
    expect(got.from).toBe(wa.selfId);
    expect(got.data).toEqual(data);

    a.close();
    b.close();
  });

  it("does not leak a signal to third parties", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    const wb = await b.join("bob");
    const c = await Client.connect();
    await c.join("carol");

    await a.nextOf("peer-joined");
    await b.nextOf("peer-joined");

    a.send({ t: "signal", to: wb.selfId, data: { k: "answer", sdp: "v=0" } });
    await b.nextOf("signal");
    expect(await c.silentFor(300)).toBe(true);

    a.close(); b.close(); c.close();
  });

  it("errors on a signal to an unknown peer", async () => {
    const a = await Client.connect();
    await a.join("alice");
    a.send({ t: "signal", to: "does-not-exist", data: { k: "offer", sdp: "v=0" } });
    const err = await a.nextOf("error");
    expect(err.code).toBe("unknown-peer");
    a.close();
  });

  it("refuses signals from a socket that has not joined", async () => {
    const a = await Client.connect();
    a.send({ t: "signal", to: "anyone", data: { k: "offer", sdp: "v=0" } });
    const err = await a.nextOf("error");
    expect(err.code).toBe("unknown-peer");
    a.close();
  });

  it("rejects a malformed message without dropping the connection", async () => {
    const a = await Client.connect();
    await a.join("alice");
    a.ws.send("{not json");
    const err = await a.nextOf("error");
    expect(err.code).toBe("bad-message");

    // The socket must still be usable afterwards.
    a.send({ t: "state", sharing: true });
    a.close();
  });

  it("broadcasts sharing state to the rest of the room", async () => {
    const a = await Client.connect();
    const wa = await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    a.send({ t: "state", sharing: true });
    const st = await b.nextOf("peer-state");
    expect(st).toMatchObject({ id: wa.selfId, sharing: true });

    a.close();
    b.close();
  });

  it("reports current sharing state to a peer joining later", async () => {
    const a = await Client.connect();
    await a.join("alice");
    a.send({ t: "state", sharing: true });
    await new Promise((r) => setTimeout(r, 100));

    const b = await Client.connect();
    const w = await b.join("bob");
    expect(w.peers[0]?.sharing).toBe(true);

    a.close();
    b.close();
  });

  it("keeps rooms isolated from each other", async () => {
    const a = await Client.connect(CODE);
    await a.join("alice");
    const other = await Client.connect(CODE2);
    other.send({ t: "join", room: CODE2, displayName: "stranger" });
    await other.nextOf("welcome");

    // A peer joining a different room code must not reach this room.
    expect(await a.silentFor(300)).toBe(true);

    a.close();
    other.close();
  });

  it("handles binary ArrayBuffer WebSocket messages", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    const encoder = new TextEncoder();
    const binaryData = encoder.encode(JSON.stringify({ t: "state", sharing: true }));
    a.ws.send(binaryData);

    const st = await b.nextOf("peer-state");
    expect(st.sharing).toBe(true);

    a.close();
    b.close();
  });

  it("ignores state messages from a socket that has not joined", async () => {
    const a = await Client.connect();
    a.send({ t: "state", sharing: true });
    expect(await a.silentFor(200)).toBe(true);
    a.close();
  });
});
