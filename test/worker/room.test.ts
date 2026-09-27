import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
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

/**
 * Mirrors RoomDO.hashPassword, so a test can seed storage the way the object would.
 * The Durable Object id is the salt, which is what stops the same password producing
 * the same hash in two different rooms.
 */
async function passwordHash(room: string, password: string): Promise<string> {
  const id = env.ROOMS.idFromName(room).toString();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${id}:${password}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Read a refusal spoken over a completed handshake.
 *
 * A refusal answers 101 and then closes, so that the close code and an error frame can
 * explain themselves. A non-101 answer would reach the browser as a bare 1006 that it
 * retries forever.
 */
async function refusal(res: Response): Promise<{ code: string; closeCode: number }> {
  if (!res.webSocket) throw new Error(`expected a webSocket, got status ${res.status}`);
  const ws = res.webSocket;
  ws.accept();
  return new Promise((resolve, reject) => {
    let code = "";
    const timer = setTimeout(() => reject(new Error("no close received")), 2000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as ServerMessage;
      if (msg.t === "error") code = msg.code;
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve({ code, closeCode: (ev as CloseEvent).code });
    });
  });
}

/** A well-formed peer id that no socket holds. */
const UNKNOWN_PEER = "00000000-0000-4000-8000-000000000000";

/** Resolve with the close code the server closes this socket with. */
function closeCodeOf(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket was not closed")), timeoutMs);
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve((ev as CloseEvent).code);
    });
  });
}

/** How many sockets one IP may hold in a room; mirrors MAX_SOCKETS_PER_IP. */
const PER_IP_CAP = MAX_ROOM_SIZE * 2;

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

  /** The rejection error if the server refused this socket, else null. */
  async peekError(ms = 200): Promise<Extract<ServerMessage, { t: "error" }> | null> {
    try {
      const m = await this.next(ms);
      return m.t === "error" ? m : null;
    } catch {
      return null;
    }
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
    expect(await refusal(res)).toEqual({ code: "bad-room-code", closeCode: 1008 });
  });

  it("still answers a plain HTTP probe for a bad code with JSON", async () => {
    // Only a client that asked for a WebSocket gets the refusal over one.
    const res = await SELF.fetch("https://example.com/ws/nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid room code" });
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
    expect(await refusal(res)).toEqual({ code: "forbidden-origin", closeCode: 1008 });
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

  it("rate limits WebSocket upgrades, not just room creation", async () => {
    // /api/room only returns a random string; /ws/:code is the expensive one, because
    // idFromName() instantiates a Durable Object for any format-valid code. The
    // per-room socket cap cannot see this: it is per-object, and cycling codes never
    // uses the same object twice.
    const ip = "198.51.100.7";
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 60; i++) {
      const res = await SELF.fetch(`https://example.com/ws/${freshRoom()}`, {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
      });
      if (res.webSocket) {
        res.webSocket.accept();
        sockets.push(res.webSocket);
      }
    }

    const over = await SELF.fetch(`https://example.com/ws/${freshRoom()}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
    });
    expect(await refusal(over)).toEqual({ code: "rate-limited", closeCode: 1013 });

    // A different address is unaffected.
    const other = await SELF.fetch(`https://example.com/ws/${freshRoom()}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "198.51.100.8" },
    });
    expect(other.status).toBe(101);
    if (other.webSocket) {
      other.webSocket.accept();
      other.webSocket.close();
    }
    for (const ws of sockets) ws.close();
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
    expect(await refusal(res)).toEqual({ code: "forbidden-origin", closeCode: 1008 });
  });

  it("applies strict security headers to static asset responses", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=63072000");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 'unsafe-inline' on script-src re-opens the main class of XSS that CSP exists to
    // stop, and neither page has an inline <script> to justify it. style-src does need
    // it: both pages carry an inline <style>.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
    // A blanket `wss: ws:` would let injected script open a socket to any host — an
    // exfiltration channel in an app whose whole point is that media stays direct.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/connect-src[^;]*wss:/);
    // Neither of these inherits from default-src, so both must be stated.
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(res.headers.get("Permissions-Policy")).toContain("display-capture=(self)");
    // No HTML sink exists in the app; Trusted Types keeps it that way.
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain("trusted-types 'none'");
  });

  it("applies the security headers to API responses too, and never caches a room code", async () => {
    const res = await SELF.fetch("https://example.com/api/room");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not send HSTS on plain-HTTP localhost", async () => {
    const res = await SELF.fetch("http://localhost/");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
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
    // Well past MAX_ROOM_SIZE, and none of these ever send `join`. The cap now answers
    // with a completed handshake that closes 1008, so a rejection is an `error`
    // message rather than a failed connect.
    for (let i = 0; i < MAX_ROOM_SIZE * 4; i++) {
      open.push(await Client.connect());
    }
    // Only the sockets past the cap are inspected: waiting on each of the accepted
    // ones just to watch nothing arrive costs a timeout apiece.
    for (let i = 0; i < 4; i++) {
      const c = await Client.connect();
      if (await c.peekError()) rejected++;
      c.close();
    }
    expect(rejected).toBe(4);
    for (const c of open) c.close();
  });

  it("closes 1013 rather than accepting an unbounded number of sockets", async () => {
    const open: Client[] = [];
    for (let i = 0; i < MAX_ROOM_SIZE * 4; i++) {
      open.push(await Client.connect());
    }
    const over = await Client.connect();
    const err = await over.nextOf("error");
    expect(err.code).toBe("rate-limited");
    over.close();
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
    for (let i = 0; i < PER_IP_CAP; i++) {
      sockets.push(await Client.connect(CODE, { "CF-Connecting-IP": ip }));
    }

    // The next connection from the same IP is refused.
    const rejected = await Client.connect(CODE, { "CF-Connecting-IP": ip });
    const err = await rejected.nextOf("error");
    expect(err.code).toBe("rate-limited");

    // A connection from another IP succeeds
    const another = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.89" });
    expect(another).toBeDefined();
    another.close();

    for (const s of sockets) s.close();
  });

  it("refuses an over-cap connection with 1013, not a failed handshake", async () => {
    // A non-101 answer reaches the page as close code 1006, which SignalingClient
    // cannot distinguish from a network blip: it would reconnect forever at the
    // backoff cap. The handshake must complete so the close code can carry meaning —
    // and 1013 rather than 1008, because capacity is transient: half-open sockets the
    // runtime has not reaped yet make a full room briefly over-cap, and 1008 would
    // permanently strand a user who did nothing wrong.
    const ip = "203.0.113.90";
    const sockets: Client[] = [];
    for (let i = 0; i < PER_IP_CAP; i++) {
      sockets.push(await Client.connect(CODE, { "CF-Connecting-IP": ip }));
    }

    const res = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();

    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = res.webSocket as WebSocket;
      ws.accept();
      const timer = setTimeout(() => reject(new Error("never closed")), 2000);
      ws.addEventListener("close", (ev) => {
        clearTimeout(timer);
        resolve((ev as CloseEvent).code);
      });
    });
    expect(closeCode).toBe(1013);

    for (const s of sockets) s.close();
  });

  it("persists the password to durable storage, not just to the instance", async () => {
    // The whole point: this object hibernates as soon as signalling quiets down, which
    // is seconds after ICE completes. A password held only in an instance field is
    // gone on the next wake, and because it is re-armed only for an *empty* room it
    // would never come back — the room would be permanently open.
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "super-secret" });
    await a.nextOf("welcome");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string>("passwordHash"),
    );
    expect(stored).toBe(await passwordHash(CODE, "super-secret"));
    // And the plaintext is nowhere in storage: room passwords come out of users'
    // ordinary password habits, so they are worth more than this one room.
    expect(stored).not.toContain("super-secret");
    a.close();
  });

  it("salts the hash per room, so the same password differs between rooms", async () => {
    const other = freshRoom();
    expect(await passwordHash(CODE, "same")).not.toBe(await passwordHash(other, "same"));
  });

  it("enforces a password that only exists in storage, as it would after a wake", async () => {
    // Seeding storage without ever setting the password over a socket reproduces the
    // state a woken object is in: durable storage has it, instance memory does not.
    // The old code read an instance field and would have waved this join straight in.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const hash = await passwordHash(CODE, "from-storage");
    await runInDurableObject(stub, (_instance, state) => state.storage.put("passwordHash", hash));

    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice" });
    const err = await a.nextOf("error");
    expect(err.code).toBe("bad-password");
    a.close();

    const b = await Client.connect();
    b.send({ t: "join", room: CODE, displayName: "bob", password: "from-storage" });
    const wb = await b.nextOf("welcome");
    expect(wb.selfId).toBeDefined();
    b.close();
  });

  it("keeps the password when the room momentarily empties", async () => {
    // A lone peer's socket blipping empties the room for the length of a reconnect.
    // Clearing the password there would let whoever connects next claim the room and
    // set their own, and the returning owner — closed 1008, which the client treats as
    // terminal — would be locked out of a room they created.
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "initial-password" });
    await a.nextOf("welcome");

    a.close();
    await new Promise((r) => setTimeout(r, 100));

    const mallory = await Client.connect();
    mallory.send({ t: "join", room: CODE, displayName: "mallory", password: "pwned" });
    const err = await mallory.nextOf("error");
    expect(err.code).toBe("bad-password");
    mallory.close();

    // The original owner still gets back in.
    const back = await Client.connect();
    back.send({ t: "join", room: CODE, displayName: "alice", password: "initial-password" });
    const w = await back.nextOf("welcome");
    expect(w.selfId).toBeDefined();
    back.close();
  });

  it("does not let a stranger claim an unprotected room", async () => {
    // The hijack the "first peer in an empty room" rule allowed: an unprotected room
    // is empty for the length of every reconnect, and permanently once the session
    // ends while its code lives on in location.hash and in whatever link was shared.
    // Setting a password there would lock the real occupants out for the full TTL.
    const alice = await Client.connect();
    await alice.join("alice");
    alice.close();
    await new Promise((r) => setTimeout(r, 100));

    const mallory = await Client.connect();
    mallory.send({ t: "join", room: CODE, displayName: "mallory", password: "pwned" });
    await mallory.nextOf("welcome");
    mallory.close();
    await new Promise((r) => setTimeout(r, 100));

    // Alice comes back with no password and is let straight in.
    const back = await Client.connect();
    const w = await back.join("alice");
    expect(w.selfId).toBeDefined();
    back.close();

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string>("passwordHash"),
    );
    expect(stored).toBeUndefined();
  });

  it("throttles repeated wrong-password attempts", async () => {
    // Refusing a guess only closes that one socket, and MAX_SOCKETS_PER_IP bounds
    // concurrency rather than attempts over time, so without a throttle an attacker
    // holding the room code can guess as fast as they can open sockets.
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "super-secret" });
    await a.nextOf("welcome");

    const started = Date.now();
    for (let i = 0; i < 4; i++) {
      const guess = await Client.connect();
      guess.send({ t: "join", room: CODE, displayName: "mallory", password: `guess-${i}` });
      const err = await guess.nextOf("error");
      expect(err.code).toBe("bad-password");
      guess.close();
    }
    // 250ms + 500 + 750 + 1000 = 2.5s of enforced delay. Allow slack for scheduling.
    expect(Date.now() - started).toBeGreaterThan(1_500);

    a.close();
  });

  it("clamps an oversized password instead of failing the storage write", async () => {
    // A Durable Object value tops out at 128 KiB while a WebSocket frame may be 1 MiB,
    // so an unclamped password made storage.put reject; the rejection escaped
    // webSocketMessage, the peer never got `welcome`, and the socket died with 1006 —
    // which the client then retried, reproducing the same failure forever. Frames are
    // now capped well below that too, so this uses the largest password that still fits
    // in one: the clamp is what keeps it to 128 characters.
    const huge = "x".repeat(70_000);
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: huge });
    const wa = await a.nextOf("welcome");
    expect(wa.selfId).toBeDefined();

    // Only the first 128 characters count, so that prefix is the password now.
    const b = await Client.connect();
    b.send({ t: "join", room: CODE, displayName: "bob", password: "x".repeat(128) });
    expect((await b.nextOf("welcome")).selfId).toBeDefined();

    a.close();
    b.close();
  });

  it("does not count a missing password as a brute-force attempt", async () => {
    // Every deep-link open and every refresh of a protected room arrives with no
    // password. Charging those to the counter made eight friends reloading a few
    // times each throttle their own room, and eventually trip the hard limit.
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "super-secret" });
    await a.nextOf("welcome");

    const started = Date.now();
    for (let i = 0; i < 5; i++) {
      const c = await Client.connect();
      c.send({ t: "join", room: CODE, displayName: "bob" });
      expect((await c.nextOf("error")).code).toBe("bad-password");
      c.close();
    }
    // No delay was served, unlike the wrong-password path.
    expect(Date.now() - started).toBeLessThan(1_000);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const fails = await runInDurableObject(stub, (_i, state) => state.storage.get("pwFail"));
    expect(fails).toBeUndefined();
    a.close();
  });

  it("refuses rather than speeds up once past the brute-force hard limit", async () => {
    // The throttle used to invert here: past the limit it returned null and the caller
    // skipped the delay, so crossing it made guessing faster than being throttled.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const hash = await passwordHash(CODE, "real");
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("passwordHash", hash);
      await state.storage.put("pwFail", { count: 999, resetAt: Date.now() + 60_000 });
    });

    const started = Date.now();
    const c = await Client.connect();
    c.send({ t: "join", room: CODE, displayName: "mallory", password: "wrong" });
    const err = await c.nextOf("error");
    expect(err.code).toBe("rate-limited");
    // Refused outright: no delay served.
    expect(Date.now() - started).toBeLessThan(1_000);
    c.close();

    // 1013, not 1008: the window expires, and the real password must work afterwards.
    const res = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket" },
    });
    res.webSocket!.accept();
    res.webSocket!.send(JSON.stringify({ t: "join", room: CODE, displayName: "m", password: "x" }));
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("never closed")), 2000);
      res.webSocket!.addEventListener("close", (ev) => {
        clearTimeout(timer);
        resolve((ev as CloseEvent).code);
      });
    });
    expect(closeCode).toBe(1013);
  });

  it("tells a peer their password was ignored on an unprotected room", async () => {
    // Dropping it silently let someone believe they had protected a room that was in
    // fact open to anyone holding the code.
    const a = await Client.connect();
    await a.join("alice");
    a.close();
    await new Promise((r) => setTimeout(r, 100));

    const b = await Client.connect();
    b.send({ t: "join", room: CODE, displayName: "bob", password: "too-late" });
    const err = await b.nextOf("error");
    expect(err.code).toBe("password-ignored");
    // The join still succeeds; this is a warning, not a rejection.
    expect((await b.nextOf("welcome")).selfId).toBeDefined();
    b.close();
  });

  it("erases an abandoned room when the alarm fires", async () => {
    // The password is kept indefinitely for reconnects, so something has to reclaim it
    // eventually or every room code ever used costs storage forever.
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "initial-password" });
    await a.nextOf("welcome");
    a.close();
    await new Promise((r) => setTimeout(r, 100));

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string>("passwordHash"),
    );
    expect(stored).toBeUndefined();

    const c = await Client.connect();
    c.send({ t: "join", room: CODE, displayName: "charlie" });
    const wc = await c.nextOf("welcome");
    expect(wc.selfId).toBeDefined();
    c.close();
  });

  it("does not let a later peer overwrite the room password", async () => {
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "initial-password" });
    await a.nextOf("welcome");

    const b = await Client.connect();
    b.send({ t: "join", room: CODE, displayName: "bob", password: "initial-password" });
    await b.nextOf("welcome");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string>("passwordHash"),
    );
    expect(stored).toBe(await passwordHash(CODE, "initial-password"));

    a.close();
    b.close();
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
    a.send({ t: "signal", to: UNKNOWN_PEER, data: { k: "offer", sdp: "v=0" } });
    const err = await a.nextOf("error");
    expect(err.code).toBe("unknown-peer");
    expect(err.message).not.toContain(UNKNOWN_PEER);
    a.close();
  });

  it("refuses signals from a socket that has not joined", async () => {
    const a = await Client.connect();
    a.send({ t: "signal", to: UNKNOWN_PEER, data: { k: "offer", sdp: "v=0" } });
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

describe("RoomDO message limits", () => {
  it("rejects a signal whose target is not a peer id", async () => {
    const a = await Client.connect();
    await a.join("alice");
    a.send({ t: "signal", to: "x".repeat(10_000), data: { k: "offer", sdp: "v=0" } });
    const err = await a.nextOf("error");
    expect(err.code).toBe("bad-message");
    expect(err.message.length).toBeLessThan(200);
    a.close();
  });

  it("closes a socket that sends an oversized frame with 1009", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const closed = closeCodeOf(a.ws);
    a.ws.send("x".repeat(100 * 1024));
    expect(await closed).toBe(1009);
  });

  it("closes a socket that floods messages", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const closed = closeCodeOf(a.ws);
    for (let i = 0; i < 400; i++) a.send({ t: "state", sharing: i % 2 === 0 });
    expect(await closed).toBe(1008);
  });

  it("lets an honest burst through: join, then 150 ICE candidates", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    const wb = await b.join("bob");
    for (let i = 0; i < 150; i++) {
      a.send({
        t: "signal",
        to: wb.selfId,
        data: { k: "ice", candidate: { candidate: `candidate:${i} 1 udp 1 198.51.100.9 ${1000 + i} typ relay`, sdpMid: "0", sdpMLineIndex: 0 } },
      });
    }
    let received = 0;
    while (received < 150) {
      const m = await b.next();
      if (m.t === "signal") received++;
    }
    expect(received).toBe(150);
    a.close();
    b.close();
  });
});

describe("RoomDO room claim", () => {
  // This does not reliably reproduce the interleaving that the fix in the join handler
  // removes (it passes against the old code too): whether a crypto.subtle await lets
  // another event in depends on timing the test cannot control. It pins the invariant
  // instead: whichever join wins, no one ends up inside a room whose stored password
  // they never supplied.
  it("keeps password state consistent when two joins race on a fresh room", async () => {
    const a = await Client.connect();
    const b = await Client.connect();
    // Sent back to back, so the second join arrives while the first is mid-flight.
    a.send({ t: "join", room: CODE, displayName: "alice", password: "race-password" });
    b.send({ t: "join", room: CODE, displayName: "bob" });

    const ra = await a.next();
    const rb = await b.nextOf(ra.t === "welcome" ? "error" : "welcome").catch(() => null);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string>("passwordHash"),
    );

    if (stored === undefined) {
      // Bob claimed an open room first; Alice was told her password was ignored.
      expect(ra.t === "error" && ra.code === "password-ignored" || ra.t === "welcome").toBe(true);
    } else {
      // Alice claimed it with a password: Bob, who sent none, must not be in.
      expect(stored).toBe(await passwordHash(CODE, "race-password"));
      expect(rb?.t).toBe("error");
      if (rb?.t === "error") expect(rb.code).toBe("bad-password");
    }
    a.close();
    b.close();
  });
});

describe("RoomDO abuse limits (batch B)", () => {
  it("frees the slot of a socket that never joined once the deadline passes", async () => {
    const idle = await Client.connect();
    const closed = closeCodeOf(idle.ws);

    // Age the idle socket past the join deadline without waiting ten real seconds.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    await runInDurableObject(stub, (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { openedAt?: number };
        ws.serializeAttachment({ ...att, openedAt: Date.now() - 60_000 });
      }
    });

    const fresh = await Client.connect();
    expect(await closed).toBe(1008);
    expect((await fresh.join("alice")).selfId).toBeTruthy();
    fresh.close();
  });

  it("does not close a socket that joined, however old", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    await runInDurableObject(stub, (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { openedAt?: number };
        ws.serializeAttachment({ ...att, openedAt: Date.now() - 60_000 });
      }
    });
    const b = await Client.connect();
    await b.join("bob");
    expect((await a.nextOf("peer-joined")).peer.name).toBe("bob");
    a.close();
    b.close();
  });

  it("closes a socket after too many unparseable messages", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const closed = closeCodeOf(a.ws);
    for (let i = 0; i < 6; i++) a.ws.send("{nope");
    expect(await closed).toBe(1008);
  });

  it("counts every address in one IPv6 /64 against the same per-IP cap", async () => {
    const sockets: Client[] = [];
    for (let i = 0; i < PER_IP_CAP; i++) {
      sockets.push(await Client.connect(CODE, { "CF-Connecting-IP": `2001:db8:aa:bb::${(i + 1).toString(16)}` }));
    }
    const res = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "2001:db8:aa:bb:ffff::99" },
    });
    expect(await refusal(res)).toEqual({ code: "rate-limited", closeCode: 1013 });
    for (const s of sockets) s.close();
  });

  it("refuses a new room with a short password and leaves it unclaimed", async () => {
    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "1234" });
    expect((await a.nextOf("error")).code).toBe("weak-password");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const claimed = await runInDurableObject(stub, (_i, state) => state.storage.get("claimed"));
    expect(claimed).toBeUndefined();

    // A second try with a proper password creates the room.
    const b = await Client.connect();
    b.send({ t: "join", room: CODE, displayName: "alice", password: "long-enough" });
    expect((await b.nextOf("welcome")).selfId).toBeTruthy();
    b.close();
  });

  it("caps wrong guesses per day, and the real password still gets in", async () => {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const hash = await passwordHash(CODE, "the-real-one");
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("passwordHash", hash);
      await state.storage.put("claimed", true);
      // Under the 15-minute limit, at the daily one.
      await state.storage.put("pwFailDay", { count: 200, resetAt: Date.now() + 3_600_000 });
    });

    const m = await Client.connect();
    m.send({ t: "join", room: CODE, displayName: "mallory", password: "guess-201" });
    expect((await m.nextOf("error")).code).toBe("rate-limited");

    const a = await Client.connect();
    a.send({ t: "join", room: CODE, displayName: "alice", password: "the-real-one" });
    expect((await a.nextOf("welcome")).selfId).toBeTruthy();
    a.close();
  });
});
