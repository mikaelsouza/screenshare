import { SELF, env, listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ROOM_SIZE, PING, PONG, type ServerMessage } from "@shared/protocol";
import worker, { type Env } from "../../worker/index";
import { applyResumeState } from "../../worker/room-membership";

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
let PASSWORD = "";
let HOST_TOKEN = "";

async function initRoom(code: string): Promise<{ code: string; password: string; hostToken: string }> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const res = await stub.fetch("https://internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(res.status).toBe(200);
  return res.json<{ code: string; password: string; hostToken: string }>();
}

beforeEach(async () => {
  CODE = freshRoom();
  const created = await initRoom(CODE);
  PASSWORD = created.password;
  HOST_TOKEN = created.hostToken;
});

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
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.t === "error") code = msg.code;
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve({ code, closeCode: ev.code });
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
      resolve(ev.code);
    });
  });
}

/** Poll until all DO sockets are closed and empty-room storage markers are settled. */
async function waitForRoomEmpty(
  stub: ReturnType<typeof env.ROOMS.get>,
  timeoutMs = 2_000,
): Promise<{ emptySince: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stateSnapshot = await runInDurableObject(stub, async (_i, state) => ({
      socketCount: state.getWebSockets().length,
      emptySince: await state.storage.get<number>("emptySince"),
      hostGoneAt: await state.storage.get<number>("hostGoneAt"),
    }));
    if (
      stateSnapshot.socketCount === 0 &&
      typeof stateSnapshot.emptySince === "number" &&
      stateSnapshot.hostGoneAt === undefined
    ) {
      return { emptySince: stateSnapshot.emptySince };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for Durable Object sockets to close and room to become empty");
}

/** How many sockets one IP may hold in a room; mirrors MAX_SOCKETS_PER_IP. */
const PER_IP_CAP = MAX_ROOM_SIZE * 2;

/** A connected client with a queue, so tests can await specific messages. */
class Client {
  private queue: ServerMessage[] = [];
  private waiters: Array<(m: ServerMessage) => void> = [];

  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const raw = String(ev.data);
      if (raw === PONG || raw === PING) return;
      const msg = JSON.parse(raw) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  static async connect(room?: string, extraHeaders?: Record<string, string>): Promise<Client> {
    room = room ?? CODE;
    const defaultIp = `198.18.${Math.floor(roomCounter / 250) % 256}.${(roomCounter % 250) + 1}`;
    const headers: Record<string, string> = {
      Upgrade: "websocket",
      Origin: "https://example.com",
      "CF-Connecting-IP": defaultIp,
      ...extraHeaders,
    };
    const res = await SELF.fetch(`https://example.com/ws/${room}`, { headers });
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
    const timeoutErr = new Error("timed out waiting for message");
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
        reject(timeoutErr);
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

  async join(
    name = "tester",
    opts?: {
      password?: string;
      hostToken?: string;
      rejoinToken?: string;
      resume?: boolean;
      sharing?: boolean;
    },
  ): Promise<Extract<ServerMessage, { t: "welcome" }>> {
    this.send({
      t: "join",
      room: CODE,
      displayName: name,
      password: opts?.password ?? PASSWORD,
      ...(opts?.hostToken !== undefined ? { hostToken: opts.hostToken } : {}),
      ...(opts?.rejoinToken !== undefined ? { rejoinToken: opts.rejoinToken } : {}),
      ...(opts?.resume !== undefined ? { resume: opts.resume } : {}),
      ...(opts?.sharing !== undefined ? { sharing: opts.sharing } : {}),
    });
    return this.nextOf("welcome");
  }

  async joinAsHost(name = "host"): Promise<Extract<ServerMessage, { t: "welcome" }>> {
    return this.join(name, { hostToken: HOST_TOKEN });
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

  it("mints a valid room code, invite secret, and hostToken via POST /api/room (rejecting GET)", async () => {
    const getRes = await SELF.fetch("https://example.com/api/room");
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get("Allow")).toBe("POST");

    const res = await SELF.fetch("https://example.com/api/room", { method: "POST" });
    expect(res.status).toBe(200);
    const { code, password, hostToken } = await res.json<{
      code: string;
      password: string;
      hostToken: string;
    }>();
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(password).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{16}$/);
    expect(hostToken.length).toBeGreaterThan(0);
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
        headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": ip },
      });
      if (res.webSocket) {
        res.webSocket.accept();
        sockets.push(res.webSocket);
      }
    }

    const over = await SELF.fetch(`https://example.com/ws/${freshRoom()}`, {
      headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": ip },
    });
    expect(await refusal(over)).toEqual({ code: "rate-limited", closeCode: 1013 });

    // A different address is unaffected.
    const other = await SELF.fetch(`https://example.com/ws/${freshRoom()}`, {
      headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": "198.51.100.8" },
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
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
      });
      expect(res.status).toBe(200);
    }
    // 21st request should be rate limited
    const limited = await SELF.fetch("https://example.com/api/room", {
      method: "POST",
      headers: { "CF-Connecting-IP": ip },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    const body = await limited.json<{ error: string }>();
    expect(body.error).toBe("Rate limit exceeded");

    // A different IP should still be allowed
    const otherIpRes = await SELF.fetch("https://example.com/api/room", {
      method: "POST",
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

  it("rejects originless HTTPS and insecure production WebSocket upgrades at the edge without waking or creating a Durable Object", async () => {
    const uncreatedHttpsCode = freshRoom();
    const uncreatedHttpCode = freshRoom();

    const originlessRes = await SELF.fetch(`https://example.com/ws/${uncreatedHttpsCode}`, {
      headers: {
        Upgrade: "websocket",
        "CF-Connecting-IP": "198.51.100.120",
      },
    });
    expect(await refusal(originlessRes)).toEqual({ code: "forbidden-origin", closeCode: 1008 });

    const insecureProdRes = await SELF.fetch(`http://example.com/ws/${uncreatedHttpCode}`, {
      headers: {
        Upgrade: "websocket",
        Origin: "http://example.com",
        "CF-Connecting-IP": "198.51.100.121",
      },
    });
    expect(await refusal(insecureProdRes)).toEqual({ code: "forbidden-origin", closeCode: 1008 });

    const existingIds = new Set((await listDurableObjectIds(env.ROOMS)).map((id) => id.toString()));
    expect(existingIds.has(env.ROOMS.idFromName(uncreatedHttpsCode).toString())).toBe(false);
    expect(existingIds.has(env.ROOMS.idFromName(uncreatedHttpCode).toString())).toBe(false);

    const spyIdFromName = vi.fn((name: string) => env.ROOMS.idFromName(name));
    const spyGet = vi.fn();
    const spyLimit = vi.fn(async () => ({ success: true }));
    const spyEnv: Env = {
      ASSETS: { fetch: vi.fn() } as unknown as Env["ASSETS"],
      ROOMS: {
        idFromName: spyIdFromName,
        get: spyGet,
      } as unknown as Env["ROOMS"],
      WS_LIMITER: { limit: spyLimit },
    };

    const directOriginless = await worker.fetch(
      new Request(`https://example.com/ws/${uncreatedHttpsCode}`, {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": "198.51.100.122" },
      }),
      spyEnv,
    );
    expect(await refusal(directOriginless)).toEqual({ code: "forbidden-origin", closeCode: 1008 });

    const directInsecure = await worker.fetch(
      new Request(`http://example.com/ws/${uncreatedHttpCode}`, {
        headers: {
          Upgrade: "websocket",
          Origin: "http://example.com",
          "CF-Connecting-IP": "198.51.100.123",
        },
      }),
      spyEnv,
    );
    expect(await refusal(directInsecure)).toEqual({ code: "forbidden-origin", closeCode: 1008 });

    expect(spyIdFromName).not.toHaveBeenCalled();
    expect(spyGet).not.toHaveBeenCalled();
    expect(spyLimit).not.toHaveBeenCalled();
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
    // Neither script-src nor style-src allows 'unsafe-inline': both pages load external
    // same-origin bundled assets and carry no inline <script> or <style>.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toMatch(/style-src[^;]*unsafe-inline/);
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
    const res = await SELF.fetch("https://example.com/api/room", { method: "POST" });
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
    overflow.send({ t: "join", room: CODE, displayName: "one-too-many", password: PASSWORD });
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
      open.push(
        await Client.connect(CODE, {
          "CF-Connecting-IP": `198.19.${Math.floor(i / 250)}.${(i % 250) + 1}`,
        }),
      );
    }
    const over = await Client.connect(CODE, { "CF-Connecting-IP": "198.19.99.99" });
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
    const ip = "203.0.113.90";
    const sockets: Client[] = [];
    for (let i = 0; i < PER_IP_CAP; i++) {
      sockets.push(await Client.connect(CODE, { "CF-Connecting-IP": ip }));
    }

    const res = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": ip },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();

    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = res.webSocket as WebSocket;
      ws.accept();
      const timer = setTimeout(() => reject(new Error("never closed")), 2000);
      ws.addEventListener("close", (ev) => {
        clearTimeout(timer);
        resolve(ev.code);
      });
    });
    expect(closeCode).toBe(1013);

    for (const s of sockets) s.close();
  });

  it("erases an abandoned room when the alarm fires", async () => {
    const aliceClient = await Client.connect();
    await aliceClient.joinAsHost("alice");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    aliceClient.close();
    await waitForRoomEmpty(stub);

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("emptySince", Date.now() - (90 * 24 * 60 + 1) * 60_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<boolean>("claimed"),
    );
    expect(stored).toBeUndefined();

    // After deletion, old credentials cannot re-claim the room until /init runs again.
    const uninit = await Client.connect();
    uninit.send({ t: "join", room: CODE, displayName: "eve", password: PASSWORD });
    expect((await uninit.nextOf("error")).code).toBe("bad-password");
    uninit.close();

    const recreated = await initRoom(CODE);
    const charlieClient = await Client.connect();
    charlieClient.send({
      t: "join",
      room: CODE,
      displayName: "charlie",
      password: recreated.password,
      hostToken: recreated.hostToken,
    });
    const wc = await charlieClient.nextOf("welcome");
    expect(wc.selfId).toBeDefined();
    expect(wc.host).toBe(true);
    charlieClient.close();
  });
});

describe("RoomDO signalling", () => {
  it("forwards a signal to the addressed peer, verbatim", async () => {
    const a = await Client.connect();
    const wa = await a.join("alice");
    const b = await Client.connect();
    const wb = await b.join("bob");
    await a.nextOf("peer-joined");

    // An offer needs one side sharing; see "refuses an offer between two viewers".
    a.send({ t: "state", sharing: true });
    await b.nextOf("peer-state");
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
    const otherInit = await initRoom(CODE2);
    const other = await Client.connect(CODE2);
    other.send({ t: "join", room: CODE2, displayName: "stranger", password: otherInit.password });
    await other.nextOf("welcome");

    // A peer joining a different room code must not reach this room.
    expect(await a.silentFor(300)).toBe(true);

    a.close();
    other.close();
  });

  it("rejects binary ArrayBuffer WebSocket messages with bad-message and close code 1008", async () => {
    const a = await Client.connect();
    const wa = await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    const closed = closeCodeOf(a.ws);
    const encoder = new TextEncoder();
    const binaryData = encoder.encode(JSON.stringify({ t: "state", sharing: true }));
    a.ws.send(binaryData);

    expect((await a.nextOf("error")).code).toBe("bad-message");
    expect(await closed).toBe(1008);
    expect(await b.next()).toEqual({ t: "peer-left", id: wa.selfId });
    expect(await b.silentFor(100)).toBe(true);

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
      headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": "2001:db8:aa:bb:ffff::99" },
    });
    expect(await refusal(res)).toEqual({ code: "rate-limited", closeCode: 1013 });
    for (const s of sockets) s.close();
  });
});

describe("display names", () => {
  it("strips invisible and direction-changing characters before others see a name", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    b.send({ t: "join", room: CODE, displayName: "al​i‮ce\u0007", password: PASSWORD });
    await b.nextOf("welcome");
    expect((await a.nextOf("peer-joined")).peer.name).toBe("alice");
    a.close();
    b.close();
  });

  it("folds full-width look-alikes and falls back when nothing is left", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    b.send({ t: "join", room: CODE, displayName: "ｂｏｂ", password: PASSWORD });
    await b.nextOf("welcome");
    expect((await a.nextOf("peer-joined")).peer.name).toBe("bob");
    const c = await Client.connect();
    c.send({ t: "join", room: CODE, displayName: "​​", password: PASSWORD });
    await c.nextOf("welcome");
    expect((await a.nextOf("peer-joined")).peer.name).toBe("Anonymous");
    a.close();
    b.close();
    c.close();
  });
});

describe("RoomDO host controls (batch D)", () => {
  /** The creator of a fresh room, with the host token returned at creation. */
  async function host(name = "host", ip = "198.51.100.1"): Promise<{ c: Client; token: string }> {
    const c = await Client.connect(CODE, { "CF-Connecting-IP": ip });
    const w = await c.joinAsHost(name);
    expect(w.host).toBe(true);
    return { c, token: HOST_TOKEN };
  }

  it("makes the creator host and nobody else, and says who the host is", async () => {
    const { c: h } = await host();
    const b = await Client.connect();
    const wb = await b.join("bob");
    expect(wb.host).toBe(false);
    expect(wb.hostToken).toBeUndefined();
    expect(wb.locked).toBe(false);
    expect(wb.peers[0]?.host).toBe(true);
    h.close();
    b.close();
  });

  it("gives host back to whoever presents the token, even after the object hibernates", async () => {
    const { c: h, token } = await host();
    h.close();
    // The token is checked against storage, not memory: prove it by looking there.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const stored = await runInDurableObject(stub, (_i, state) => state.storage.get("hostTokenHash"));
    expect(typeof stored).toBe("string");
    expect(stored).not.toContain(token);

    const back = await Client.connect();
    back.send({ t: "join", room: CODE, displayName: "host", hostToken: token });
    const w = await back.nextOf("welcome");
    expect(w.host).toBe(true);
    // Issued once at /api/room, never echoed on welcome.
    expect(w.hostToken).toBeUndefined();

    const fake = await Client.connect();
    fake.send({ t: "join", room: CODE, displayName: "mallory", password: PASSWORD, hostToken: "not-the-token" });
    expect((await fake.nextOf("welcome")).host).toBe(false);
    back.close();
    fake.close();
  });

  it("lets only the host remove people", async () => {
    const { c: h } = await host();
    const b = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.5" });
    const wb = await b.join("bob");
    await h.nextOf("peer-joined");

    b.send({ t: "kick", id: wb.peers[0]!.id });
    expect((await b.nextOf("error")).code).toBe("not-host");
    b.close();
    h.close();
  });

  it("removes a kicked peer, auto-rotates the invite password, tells the room, and refuses its rejoin", async () => {
    const { c: h } = await host();
    const b = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.5" });
    await b.join("bob");
    const c = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.9" });
    await c.join("carol");
    const bobId = (await h.nextOf("peer-joined")).peer.id;
    await h.nextOf("peer-joined");

    const closed = closeCodeOf(b.ws);
    h.send({ t: "kick", id: bobId });
    expect((await b.nextOf("error")).code).toBe("kicked");
    expect(await closed).toBe(1008);
    const leftH = await h.nextOf("peer-left");
    expect(leftH.id).toBe(bobId);
    expect(leftH.kicked).toBe(true);
    const leftC = await c.nextOf("peer-left");
    expect(leftC.id).toBe(bobId);
    expect(leftC.kicked).toBe(true);

    const rotH = await h.nextOf("room-password");
    const rotC = await c.nextOf("room-password");
    expect(rotH.password).toBeTruthy();
    expect(rotH.password).not.toBe(PASSWORD);
    expect(rotC.password).toBe(rotH.password);

    const oldLinkPeer = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.77" });
    oldLinkPeer.send({ t: "join", room: CODE, displayName: "stale", password: PASSWORD });
    expect((await oldLinkPeer.nextOf("error")).code).toBe("bad-password");
    oldLinkPeer.close();

    const again = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": "203.0.113.5" },
    });
    const ws = again.webSocket!;
    ws.accept();
    const rejoin = closeCodeOf(ws);
    ws.send(JSON.stringify({ t: "join", room: CODE, displayName: "bob", password: rotH.password }));
    expect(await rejoin).toBe(1008);
    h.close();
    c.close();
  });

  it("refuses new joins while locked, lets the host back in, and tells the room", async () => {
    const { c: h, token } = await host();
    const b = await Client.connect();
    await b.join("bob");
    await h.nextOf("peer-joined");

    h.send({ t: "lock", locked: true });
    expect(await h.nextOf("room-state")).toEqual({ t: "room-state", locked: true });
    expect(await b.nextOf("room-state")).toEqual({ t: "room-state", locked: true });

    const c = await Client.connect();
    const refused = closeCodeOf(c.ws);
    c.send({ t: "join", room: CODE, displayName: "carol", password: PASSWORD });
    expect((await c.nextOf("error")).code).toBe("room-locked");
    expect(await refused).toBe(1008);

    const back = await Client.connect();
    back.send({ t: "join", room: CODE, displayName: "host", hostToken: token });
    const w = await back.nextOf("welcome");
    expect(w.host).toBe(true);
    expect(w.locked).toBe(true);

    back.send({ t: "lock", locked: false });
    expect(await back.nextOf("room-state")).toEqual({ t: "room-state", locked: false, password: PASSWORD });
    expect(await b.nextOf("room-state")).toEqual({ t: "room-state", locked: false, password: PASSWORD });
    const d = await Client.connect();
    expect((await d.join("dave")).locked).toBe(false);
    for (const s of [h, b, back, d]) s.close();
  });

  it("refuses lock from anyone but the host", async () => {
    const { c: h } = await host();
    const b = await Client.connect();
    await b.join("bob");
    b.send({ t: "lock", locked: true });
    expect((await b.nextOf("error")).code).toBe("not-host");
    h.close();
    b.close();
  });
});

describe("RoomDO final review fixes", () => {
  it("lets a member back into a locked room with its rejoin ticket, and nobody else", async () => {
    const h = await Client.connect();
    const wh = await h.joinAsHost("host");
    const b = await Client.connect();
    const wb = await b.join("bob");
    expect(typeof wb.rejoinToken).toBe("string");
    await h.nextOf("peer-joined");
    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");

    // Bob's connection blips.
    b.close();
    await h.nextOf("peer-left");
    const back = await Client.connect();
    back.send({ t: "join", room: CODE, displayName: "bob", rejoinToken: wb.rejoinToken });
    const again = await back.nextOf("welcome");
    expect(again.locked).toBe(true);
    // A ticket is good once: each welcome issues a fresh one.
    expect(again.rejoinToken).not.toBe(wb.rejoinToken);

    const reuse = await Client.connect();
    reuse.send({ t: "join", room: CODE, displayName: "copycat", password: PASSWORD, rejoinToken: wb.rejoinToken });
    expect((await reuse.nextOf("error")).code).toBe("room-locked");
    const stranger = await Client.connect();
    stranger.send({ t: "join", room: CODE, displayName: "eve", password: PASSWORD, rejoinToken: "made-up" });
    expect((await stranger.nextOf("error")).code).toBe("room-locked");
    expect(wh.host).toBe(true);
    h.close();
    back.close();
  });

  it("does not let a removed member's ticket carry them past the ban", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.1" });
    await h.joinAsHost("host");
    const b = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.5" });
    const wb = await b.join("bob");
    const housemate = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.5" });
    const wm = await housemate.join("housemate");
    await h.nextOf("peer-joined");
    await h.nextOf("peer-joined");

    h.send({ t: "kick", id: wb.selfId });
    await h.nextOf("peer-left");
    const hmRot = await housemate.nextOf("room-password");
    const retry = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.5" });
    retry.send({
      t: "join",
      room: CODE,
      displayName: "bob",
      password: hmRot.password,
      rejoinToken: wb.rejoinToken,
    });
    expect((await retry.nextOf("error")).code).toBe("kicked");

    // The housemate shares the banned address, but was already in: their rotated ticket works.
    housemate.close();
    await h.nextOf("peer-left");
    const hmBack = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.5" });
    hmBack.send({
      t: "join",
      room: CODE,
      displayName: "housemate",
      rejoinToken: hmRot.rejoinToken ?? wm.rejoinToken,
    });
    expect((await hmBack.nextOf("welcome")).selfId).toBeTruthy();
    h.close();
    hmBack.close();
  });

  it("promotes earliest member to host after 5m without auto-unlocking locked rooms", async () => {
    const h = await Client.connect();
    await h.joinAsHost("host");
    const b = await Client.connect();
    const wb = await b.join("bob");
    await h.nextOf("peer-joined");
    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");
    await b.nextOf("room-state");

    // The host leaves: still locked for strangers meanwhile.
    h.close();
    await b.nextOf("peer-left");
    const early = await Client.connect();
    early.send({ t: "join", room: CODE, displayName: "eve", password: PASSWORD });
    expect((await early.nextOf("error")).code).toBe("room-locked");

    // Five minutes pass with no host: earliest connected member becomes host, room stays locked.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    await runInDurableObject(stub, (_i, state) => state.storage.put("hostGoneAt", Date.now() - 6 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const promoted = await b.nextOf("host-promoted");
    expect(promoted.hostId).toBe(wb.selfId);
    expect(promoted.hostToken).toBeTruthy();
    expect(promoted.password).toBe(PASSWORD);

    // Locked invariant holds: newcomer still cannot walk in until the new host unlocks.
    const stillLocked = await Client.connect();
    stillLocked.send({ t: "join", room: CODE, displayName: "dave", password: PASSWORD });
    expect((await stillLocked.nextOf("error")).code).toBe("room-locked");

    // Promoted host can unlock; previous creator's hostToken no longer grants host.
    b.send({ t: "lock", locked: false });
    expect(await b.nextOf("room-state")).toEqual({ t: "room-state", locked: false, password: PASSWORD });
    const oldHost = await Client.connect();
    oldHost.send({ t: "join", room: CODE, displayName: "old-host", password: PASSWORD, hostToken: HOST_TOKEN });
    expect((await oldHost.nextOf("welcome")).host).toBe(false);

    for (const s of [b, stillLocked, oldHost]) s.close();
  });

  it("refuses an offer between two people who are not sharing", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    const wb = await b.join("bob");
    await a.nextOf("peer-joined");
    a.send({ t: "signal", to: wb.selfId, data: { k: "offer", sdp: "v=0\r\n" } });
    expect((await a.nextOf("error")).code).toBe("not-sharing");
    expect(await b.silentFor()).toBe(true);
    // Answers and candidates are not offers: they pass, as part of a link a sharer started.
    a.send({ t: "signal", to: wb.selfId, data: { k: "ice", candidate: { candidate: "" } } });
    expect((await b.nextOf("signal")).data.k).toBe("ice");
    a.close();
    b.close();
  });

  it("evicts previous socket and broadcasts peer-left on rejoin with rejoinToken while sharing", async () => {
    const a1 = await Client.connect();
    const wa1 = await a1.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a1.nextOf("peer-joined");

    // Alice starts sharing
    a1.send({ t: "state", sharing: true });
    expect((await b.nextOf("peer-state")).sharing).toBe(true);

    const a1Closed = closeCodeOf(a1.ws);

    // Alice reconnects on a2 with rejoinToken while a1 is still open (ghost socket)
    const a2 = await Client.connect();
    a2.send({ t: "join", room: CODE, displayName: "alice", rejoinToken: wa1.rejoinToken });

    // Bob receives peer-left for a1's selfId before peer-joined for a2's selfId
    const left = await b.nextOf("peer-left");
    expect(left.id).toBe(wa1.selfId);

    const joined = await b.nextOf("peer-joined");
    const wa2 = await a2.nextOf("welcome");
    expect(joined.peer.id).toBe(wa2.selfId);
    expect(wa2.selfId).not.toBe(wa1.selfId);

    // a2's peer list contains only bob and not a1
    expect(wa2.peers).toHaveLength(1);
    expect(wa2.peers[0]!.name).toBe("bob");
    expect(wa2.peers.some((p) => p.id === wa1.selfId)).toBe(false);

    // a1's socket was closed with 1008 ("Session replaced")
    expect(await a1Closed).toBe(1008);

    a2.close();
    b.close();
  });

  it("evicts previous host socket on rejoin with hostToken", async () => {
    const h1 = await Client.connect();
    const wh1 = await h1.joinAsHost("host");
    expect(wh1.host).toBe(true);

    const b = await Client.connect();
    await b.join("bob");
    await h1.nextOf("peer-joined");

    const h1Closed = closeCodeOf(h1.ws);

    // Rejoin with hostToken on a new socket without closing h1
    const h2 = await Client.connect();
    h2.send({ t: "join", room: CODE, displayName: "host", hostToken: HOST_TOKEN });

    expect((await h1.nextOf("error")).code).toBe("session-replaced");
    const left = await b.nextOf("peer-left");
    expect(left.id).toBe(wh1.selfId);

    const joined = await b.nextOf("peer-joined");
    const wh2 = await h2.nextOf("welcome");
    expect(wh2.host).toBe(true);
    expect(joined.peer.id).toBe(wh2.selfId);
    expect(joined.replaces).toBe(wh1.selfId);
    expect(joined.peer.host).toBe(true);

    expect(wh2.peers).toHaveLength(1);
    expect(wh2.peers[0]!.name).toBe("bob");
    expect(wh2.peers.some((p) => p.id === wh1.selfId)).toBe(false);

    expect(await h1Closed).toBe(1008);

    h2.close();
    b.close();
  });

  it("allows a returning peer to rejoin a full room when their previous socket is still open", async () => {
    const joined: Client[] = [];
    let peer0Welcome: Extract<ServerMessage, { t: "welcome" }> | null = null;
    for (let i = 0; i < MAX_ROOM_SIZE; i++) {
      const c = await Client.connect();
      const w = await c.join(`peer${i}`);
      if (i === 0) peer0Welcome = w;
      joined.push(c);
    }
    expect(peer0Welcome?.rejoinToken).toBeTruthy();

    const peer0Closed = closeCodeOf(joined[0]!.ws);

    // Peer 0 reconnects with its rejoinToken without closing its old socket
    const c0Back = await Client.connect();
    c0Back.send({ t: "join", room: CODE, displayName: "peer0-back", rejoinToken: peer0Welcome!.rejoinToken });

    const backWelcome = await c0Back.nextOf("welcome");
    expect(backWelcome.selfId).toBeTruthy();
    expect(backWelcome.peers).toHaveLength(MAX_ROOM_SIZE - 1);
    expect(backWelcome.peers.some((p) => p.id === peer0Welcome!.selfId)).toBe(false);

    expect(await peer0Closed).toBe(1008);

    c0Back.close();
    for (const c of joined) c.close();
  });

  it("allows the host to rejoin a full room with hostToken when previous host socket is still open", async () => {
    const h1 = await Client.connect();
    const wh1 = await h1.joinAsHost("host");
    const token = HOST_TOKEN;
    const joined: Client[] = [h1];
    for (let i = 1; i < MAX_ROOM_SIZE; i++) {
      const c = await Client.connect();
      await c.join(`peer${i}`);
      joined.push(c);
    }
    const h1Closed = closeCodeOf(h1.ws);

    // Host reconnects with hostToken while h1 is still open in a full room
    const hBack = await Client.connect();
    hBack.send({ t: "join", room: CODE, displayName: "host-back", hostToken: token });

    const backWelcome = await hBack.nextOf("welcome");
    expect(backWelcome.host).toBe(true);
    expect(backWelcome.peers).toHaveLength(MAX_ROOM_SIZE - 1);
    expect(backWelcome.peers.some((p) => p.id === wh1.selfId)).toBe(false);
    expect(await h1Closed).toBe(1008);

    hBack.close();
    for (const c of joined) c.close();
  });

  it("handles multiple sequential rejoins while sharing without ghost roster entries", async () => {
    const a1 = await Client.connect();
    const wa1 = await a1.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a1.nextOf("peer-joined");

    // Alice 1 shares
    a1.send({ t: "state", sharing: true });
    expect((await b.nextOf("peer-state")).sharing).toBe(true);

    const a1Closed = closeCodeOf(a1.ws);

    // Alice reconnects on a2 with wa1.rejoinToken
    const a2 = await Client.connect();
    a2.send({ t: "join", room: CODE, displayName: "alice", rejoinToken: wa1.rejoinToken });
    expect((await b.nextOf("peer-left")).id).toBe(wa1.selfId);
    const wa2 = await a2.nextOf("welcome");
    expect((await b.nextOf("peer-joined")).peer.id).toBe(wa2.selfId);
    expect(await a1Closed).toBe(1008);

    // Alice 2 re-announces sharing
    a2.send({ t: "state", sharing: true });
    expect((await b.nextOf("peer-state")).sharing).toBe(true);

    const a2Closed = closeCodeOf(a2.ws);

    // Alice reconnects on a3 with wa2.rejoinToken
    const a3 = await Client.connect();
    a3.send({ t: "join", room: CODE, displayName: "alice", rejoinToken: wa2.rejoinToken });
    expect((await b.nextOf("peer-left")).id).toBe(wa2.selfId);
    const wa3 = await a3.nextOf("welcome");
    expect((await b.nextOf("peer-joined")).peer.id).toBe(wa3.selfId);
    expect(await a2Closed).toBe(1008);

    expect(wa3.peers).toHaveLength(1);
    expect(wa3.peers[0]!.name).toBe("bob");

    a3.close();
    b.close();
  });

  it("evicts previous socket on rejoin with rejoinToken in a locked room", async () => {
    const h = await Client.connect();
    await h.joinAsHost("host");
    const b1 = await Client.connect();
    const wb1 = await b1.join("bob");
    await h.nextOf("peer-joined");

    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");
    await b1.nextOf("room-state");

    const b1Closed = closeCodeOf(b1.ws);

    // Bob reconnects with rejoinToken while b1 is still open and room is locked
    const b2 = await Client.connect();
    b2.send({ t: "join", room: CODE, displayName: "bob", rejoinToken: wb1.rejoinToken });

    expect((await h.nextOf("peer-left")).id).toBe(wb1.selfId);
    const wb2 = await b2.nextOf("welcome");
    expect(wb2.locked).toBe(true);
    expect((await h.nextOf("peer-joined")).peer.id).toBe(wb2.selfId);
    expect(wb2.peers.some((p) => p.id === wb1.selfId)).toBe(false);
    expect(await b1Closed).toBe(1008);

    h.close();
    b2.close();
  });

  it("evicts previous host socket when host rejoins presenting both hostToken and rejoinToken", async () => {
    const h1 = await Client.connect();
    const wh1 = await h1.joinAsHost("host");
    const b = await Client.connect();
    await b.join("bob");
    await h1.nextOf("peer-joined");

    const h1Closed = closeCodeOf(h1.ws);

    // Host reconnects presenting both tokens
    const h2 = await Client.connect();
    h2.send({
      t: "join",
      room: CODE,
      displayName: "host",
      hostToken: HOST_TOKEN,
      rejoinToken: wh1.rejoinToken,
    });

    expect((await b.nextOf("peer-left")).id).toBe(wh1.selfId);
    const wh2 = await h2.nextOf("welcome");
    expect(wh2.host).toBe(true);
    expect((await b.nextOf("peer-joined")).peer.id).toBe(wh2.selfId);
    expect(wh2.peers).toHaveLength(1);
    expect(await h1Closed).toBe(1008);

    h2.close();
    b.close();
  });

  it("in-place resume (resume: true + rejoinToken) with old socket open preserves selfId without broadcasting peer-left", async () => {
    const a1 = await Client.connect();
    const wa1 = await a1.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a1.nextOf("peer-joined");

    // Alice starts sharing
    a1.send({ t: "state", sharing: true });
    expect((await b.nextOf("peer-state")).sharing).toBe(true);

    const a1Closed = closeCodeOf(a1.ws);

    // Alice reconnects on a2 with resume: true and rejoinToken while a1 is still open
    const a2 = await Client.connect();
    a2.send({
      t: "join",
      room: CODE,
      displayName: "alice",
      rejoinToken: wa1.rejoinToken,
      resume: true,
      sharing: true,
    });

    const wa2 = await a2.nextOf("welcome");
    // selfId is preserved!
    expect(wa2.selfId).toBe(wa1.selfId);

    // a1's socket was closed with 1008 ("Session replaced")
    expect(await a1Closed).toBe(1008);

    // Bob receives NO peer-left or peer-joined
    expect(await b.silentFor(300)).toBe(true);

    a2.close();
    b.close();
  });

  it("in-place resume (resume: true + rejoinToken) after previous socket closed restores selfId and broadcasts peer-joined", async () => {
    const a1 = await Client.connect();
    const wa1 = await a1.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a1.nextOf("peer-joined");

    // Alice starts sharing
    a1.send({ t: "state", sharing: true });
    expect((await b.nextOf("peer-state")).sharing).toBe(true);

    // Alice's socket closes (simulating disconnect before reconnect)
    a1.close();
    expect((await b.nextOf("peer-left")).id).toBe(wa1.selfId);

    // Alice reconnects with resume: true and rejoinToken
    const a2 = await Client.connect();
    a2.send({
      t: "join",
      room: CODE,
      displayName: "alice",
      rejoinToken: wa1.rejoinToken,
      resume: true,
      sharing: true,
    });

    const wa2 = await a2.nextOf("welcome");
    // selfId is preserved!
    expect(wa2.selfId).toBe(wa1.selfId);

    // Bob receives peer-joined with preserved selfId and sharing: true
    const joined = await b.nextOf("peer-joined");
    expect(joined.peer.id).toBe(wa1.selfId);
    expect(joined.peer.sharing).toBe(true);

    a2.close();
    b.close();
  });

  it("raw PING frames in webSocketMessage do not trigger bad-message or close after repeated sends", async () => {
    const a = await Client.connect();
    await a.join("alice");

    const pongs: string[] = [];
    a.ws.addEventListener("message", (ev) => {
      const data = String(ev.data);
      if (data === PONG) pongs.push(data);
    });

    // Send more than MAX_BAD_MESSAGES (5) raw "ping" frames
    for (let i = 0; i < 10; i++) {
      a.ws.send(PING);
    }

    // Wait for replies
    await new Promise((r) => setTimeout(r, 200));

    // Verify pongs received and socket is still OPEN
    expect(pongs.length).toBe(10);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);

    // Can still send regular messages without bad-message error
    a.send({ t: "state", sharing: true });
    expect(await a.silentFor(200)).toBe(true);

    a.close();
  });

  it("in-place resume (resume: true + rejoinToken) into a locked room preserves selfId and sharing without error", async () => {
    const h = await Client.connect();
    await h.joinAsHost("host");
    const b1 = await Client.connect();
    const wb1 = await b1.join("bob");
    await h.nextOf("peer-joined");

    // Bob starts sharing
    b1.send({ t: "state", sharing: true });
    expect((await h.nextOf("peer-state")).sharing).toBe(true);

    // Host locks room
    h.send({ t: "lock", locked: true });
    expect((await h.nextOf("room-state")).locked).toBe(true);
    expect((await b1.nextOf("room-state")).locked).toBe(true);

    const b1Closed = closeCodeOf(b1.ws);

    // Bob reconnects with resume: true and rejoinToken into the locked room while b1 is open
    const b2 = await Client.connect();
    b2.send({
      t: "join",
      room: CODE,
      displayName: "bob",
      rejoinToken: wb1.rejoinToken,
      resume: true,
      sharing: true,
    });

    const wb2 = await b2.nextOf("welcome");
    expect(wb2.selfId).toBe(wb1.selfId);
    expect(wb2.locked).toBe(true);
    expect(await b1Closed).toBe(1008);
    expect(await h.silentFor(300)).toBe(true);

    // Bob disconnects socket and resumes again into locked room
    b2.close();
    expect((await h.nextOf("peer-left")).id).toBe(wb1.selfId);

    const b3 = await Client.connect();
    b3.send({
      t: "join",
      room: CODE,
      displayName: "bob",
      rejoinToken: wb2.rejoinToken,
      resume: true,
      sharing: true,
    });

    const wb3 = await b3.nextOf("welcome");
    expect(wb3.selfId).toBe(wb1.selfId);
    expect(wb3.locked).toBe(true);
    const joined = await h.nextOf("peer-joined");
    expect(joined.peer.id).toBe(wb1.selfId);
    expect(joined.peer.sharing).toBe(true);

    h.close();
    b3.close();
  });

  it("resume: true without rejoinToken is treated as a normal join with fresh selfId", async () => {
    const a1 = await Client.connect();
    const wa1 = await a1.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a1.nextOf("peer-joined");

    // Alice reconnects with resume: true but omits rejoinToken
    const a2 = await Client.connect();
    a2.send({
      t: "join",
      room: CODE,
      displayName: "alice",
      password: PASSWORD,
      resume: true,
    });

    const wa2 = await a2.nextOf("welcome");
    // Not treated as in-place resume: new selfId assigned
    expect(wa2.selfId).not.toBe(wa1.selfId);

    a1.close();
    a2.close();
    b.close();
  });

  it("multiple sequential in-place resumes preserve selfId across each reconnection", async () => {
    const a1 = await Client.connect();
    const wa1 = await a1.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a1.nextOf("peer-joined");

    // First in-place resume
    const a2 = await Client.connect();
    a2.send({
      t: "join",
      room: CODE,
      displayName: "alice",
      rejoinToken: wa1.rejoinToken,
      resume: true,
      sharing: false,
    });
    const wa2 = await a2.nextOf("welcome");
    expect(wa2.selfId).toBe(wa1.selfId);

    // Second in-place resume
    const a3 = await Client.connect();
    a3.send({
      t: "join",
      room: CODE,
      displayName: "alice",
      rejoinToken: wa2.rejoinToken,
      resume: true,
      sharing: false,
    });
    const wa3 = await a3.nextOf("welcome");
    expect(wa3.selfId).toBe(wa1.selfId);

    // Bob receives NO peer-left or peer-joined across both resumes
    expect(await b.silentFor(300)).toBe(true);

    a3.close();
    b.close();
  });

  it("in-place resume preserves message budget, carries over badMessages, and delivers session-replaced before 1008", async () => {
    const a1 = await Client.connect();
    const wa1 = await a1.join("alice");
    const a1Closed = closeCodeOf(a1.ws);

    // Accumulate 3 bad messages (below MAX_BAD_MESSAGES = 5) on a1 before resuming.
    for (let i = 0; i < 3; i++) {
      a1.ws.send("not-json");
      expect((await a1.nextOf("error")).code).toBe("bad-message");
    }

    // In-place resume on a2 while a1 is open
    const a2 = await Client.connect();
    a2.send({
      t: "join",
      room: CODE,
      displayName: "alice",
      rejoinToken: wa1.rejoinToken,
      resume: true,
      sharing: false,
    });
    const wa2 = await a2.nextOf("welcome");
    expect(wa2.selfId).toBe(wa1.selfId);

    // Superseded socket receives session-replaced before closing with 1008
    expect((await a1.nextOf("error")).code).toBe("session-replaced");
    expect(await a1Closed).toBe(1008);
    await new Promise((r) => setTimeout(r, 100));

    // Send valid messages on a2 to confirm rate-limit budget survived in-place close
    for (let i = 0; i < 20; i++) {
      a2.send({ t: "state", sharing: false });
    }
    expect(await a2.silentFor(200)).toBe(true);

    // 3 more bad messages (3 + 3 = 6 > MAX_BAD_MESSAGES) refuse and close a2 with 1008
    const a2Closed = closeCodeOf(a2.ws);
    for (let i = 0; i < 2; i++) {
      a2.ws.send("not-json");
      expect((await a2.nextOf("error")).code).toBe("bad-message");
    }
    a2.ws.send("not-json");
    expect((await a2.nextOf("error")).code).toBe("bad-message");
    expect(await a2Closed).toBe(1008);
  });

  it("in-place resume after socket closed recovers sharing state from member ticket when sharing is omitted in join message", async () => {
    const a1 = await Client.connect();
    const wa1 = await a1.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a1.nextOf("peer-joined");

    // Alice starts sharing
    a1.send({ t: "state", sharing: true });
    expect((await b.nextOf("peer-state")).sharing).toBe(true);

    // Alice's socket disconnects
    a1.close();
    expect((await b.nextOf("peer-left")).id).toBe(wa1.selfId);

    // Alice reconnects with resume: true and rejoinToken, but omits `sharing`
    const a2 = await Client.connect();
    a2.send({
      t: "join",
      room: CODE,
      displayName: "alice",
      rejoinToken: wa1.rejoinToken,
      resume: true,
    });

    const wa2 = await a2.nextOf("welcome");
    expect(wa2.selfId).toBe(wa1.selfId);

    // Bob receives peer-joined with sharing recovered from memberTicket
    const joined = await b.nextOf("peer-joined");
    expect(joined.peer.id).toBe(wa1.selfId);
    expect(joined.peer.sharing).toBe(true);

    a2.close();
    b.close();
  });
});

describe("RoomDO security & PR 1 flows", () => {
  it("enforces same-origin checks and missing-IP fallback rate limiting on POST /api/room", async () => {
    const crossSite = await SELF.fetch("https://example.com/api/room", {
      method: "POST",
      headers: { "CF-Connecting-IP": "198.51.100.120", "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);

    const crossOrigin = await SELF.fetch("https://example.com/api/room", {
      method: "POST",
      headers: { "CF-Connecting-IP": "198.51.100.121", Origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);

    const sameOrigin = await SELF.fetch("https://example.com/api/room", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "198.51.100.122",
        "Sec-Fetch-Site": "same-origin",
        Origin: "https://example.com",
      },
    });
    expect(sameOrigin.status).toBe(200);

    // Requests without CF-Connecting-IP fall back to the shared "unknown" bucket and fail closed at 20/min.
    let limitedCount = 0;
    for (let i = 0; i < 25; i++) {
      const res = await SELF.fetch("https://example.com/api/room", { method: "POST" });
      if (res.status === 429) {
        limitedCount++;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limitedCount).toBe(1);
  });

  it("refuses unclaimed rooms with bad-password and performs zero storage writes", async () => {
    const unclaimed = freshRoom();
    const probe = await Client.connect(unclaimed);
    const closed = closeCodeOf(probe.ws);
    probe.send({
      t: "join",
      room: unclaimed,
      displayName: "scanner",
      password: "WRONG23456789ABC",
    });
    expect((await probe.nextOf("error")).code).toBe("bad-password");
    expect(await closed).toBe(1008);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(unclaimed));
    const keys = await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size);
    expect(keys).toBe(0);
  });

  it("checks room password before lock, IP ban, and room-full, and rate-limits failed password guesses at 15/min", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.200" });
    await h.joinAsHost("host");
    const banned = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.201" });
    const wb = await banned.join("bob");
    await h.nextOf("peer-joined");
    h.send({ t: "kick", id: wb.selfId });
    await h.nextOf("peer-left");
    await h.nextOf("room-password");
    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");

    // Wrong password on a locked + IP-banned room must still return bad-password (anti-enumeration).
    const wrongFromBanned = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.201" });
    wrongFromBanned.send({ t: "join", room: CODE, displayName: "bob", password: "WRONG23456789ABC" });
    expect((await wrongFromBanned.nextOf("error")).code).toBe("bad-password");

    // 15 wrong passwords per minute from one IP are refused as bad-password, then 16th is rate-limited.
    const guessIp = "198.51.100.205";
    for (let i = 0; i < 15; i++) {
      const c = await Client.connect(CODE, { "CF-Connecting-IP": guessIp });
      c.send({ t: "join", room: CODE, displayName: "guesser", password: "WRONG23456789ABC" });
      expect((await c.nextOf("error")).code).toBe("bad-password");
    }
    const throttled = await Client.connect(CODE, { "CF-Connecting-IP": guessIp });
    throttled.send({ t: "join", room: CODE, displayName: "guesser", password: "WRONG23456789ABC" });
    expect((await throttled.nextOf("error")).code).toBe("rate-limited");
    // Even the correct password must be refused while the IP's failure budget is exhausted.
    const throttledCorrect = await Client.connect(CODE, { "CF-Connecting-IP": guessIp });
    throttledCorrect.send({ t: "join", room: CODE, displayName: "guesser", password: PASSWORD });
    expect((await throttledCorrect.nextOf("error")).code).toBe("rate-limited");
    h.close();
  });

  it("clamps disconnected rejoinToken TTL to 5 minutes and caps stored members/deny entries at 128", async () => {
    const h = await Client.connect();
    await h.joinAsHost("host");
    const b = await Client.connect();
    const wb = await b.join("bob");
    await h.nextOf("peer-joined");

    const disconnectBefore = Date.now();
    b.close();
    await h.nextOf("peer-left");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const membersAfterDisconnect = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<Record<string, { until: number; id: string }>>("members"),
    );
    const bobEntry = Object.entries(membersAfterDisconnect ?? {}).find(([, v]) => v.id === wb.selfId);
    expect(bobEntry).toBeDefined();
    expect(bobEntry![1].until).toBeLessThanOrEqual(disconnectBefore + 5 * 60_000 + 2_000);

    // Simulate >5m passing: bob's rejoinToken is now rejected without password.
    await runInDurableObject(stub, async (_i, state) => {
      const raw = (await state.storage.get<Record<string, { until: number; id: string }>>("members")) ?? {};
      const entry = raw[bobEntry![0]];
      if (entry) entry.until = Date.now() - 1000;
      await state.storage.put("members", raw);
    });
    const expiredAttempt = await Client.connect();
    expiredAttempt.send({ t: "join", room: CODE, displayName: "bob", rejoinToken: wb.rejoinToken });
    expect((await expiredAttempt.nextOf("error")).code).toBe("bad-password");

    // Seed >128 members and >128 deny entries in storage, then verify rotate-password enforces 128 cap on members
    // BEFORE kick tests both deny capping (128) and purge of disconnected members (leaving only active host).
    await runInDurableObject(stub, async (_i, state) => {
      const now = Date.now();
      const bigMembers: Record<string, { until: number; id: string }> = {};
      const bigDeny: Record<string, number> = {};
      for (let i = 0; i < 140; i++) {
        bigMembers[`h${i}`] = { until: now + (i + 1) * 10_000, id: `peer-${i}` };
        bigDeny[`203.0.113.${i}`] = now + (i + 1) * 10_000;
      }
      await state.storage.put({ members: bigMembers, deny: bigDeny });
    });

    h.send({ t: "rotate-password" });
    const rot = await h.nextOf("room-password");
    expect(rot.password).toBeTruthy();

    const membersAfterRotate = await runInDurableObject(stub, async (_i, state) =>
      Object.keys((await state.storage.get<Record<string, unknown>>("members")) ?? {}).length,
    );
    expect(membersAfterRotate).toBe(128);

    // Kick triggers deny cap at 128 and purges all disconnected members (leaving only host h's fresh + grace tickets).
    const c = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.222" });
    const wc = await c.join("carol", rot.password ? { password: rot.password } : undefined);
    await h.nextOf("peer-joined");
    h.send({ t: "kick", id: wc.selfId });
    await h.nextOf("peer-left");
    await h.nextOf("room-password");

    const counts = await runInDurableObject(stub, async (_i, state) => ({
      members: Object.keys((await state.storage.get<Record<string, unknown>>("members")) ?? {}).length,
      deny: Object.keys((await state.storage.get<Record<string, unknown>>("deny")) ?? {}).length,
    }));
    expect(counts.members).toBe(2);
    expect(counts.deny).toBe(128);
    h.close();
  });

  it("supports rotate-password with locked non-host secret withholding and live rename", async () => {
    const h = await Client.connect();
    await h.joinAsHost("host");
    const b = await Client.connect();
    const wb = await b.join("bob");
    await h.nextOf("peer-joined");

    // Unjoined socket rename is ignored, joined rename sanitises & broadcasts peer-renamed.
    const unjoined = await Client.connect();
    unjoined.send({ t: "rename", displayName: "ghost" });
    expect(await h.silentFor(100)).toBe(true);
    unjoined.close();

    b.send({ t: "rename", displayName: "  ｂｏｂ\u200B-2  " });
    const renamedH = await h.nextOf("peer-renamed");
    const renamedB = await b.nextOf("peer-renamed");
    expect(renamedH).toEqual({ t: "peer-renamed", id: wb.selfId, name: "bob-2" });
    expect(renamedB).toEqual(renamedH);

    // Non-host rotate-password is rejected.
    b.send({ t: "rotate-password" });
    expect((await b.nextOf("error")).code).toBe("not-host");

    // Unlocked rotation shares the new password to all peers.
    h.send({ t: "rotate-password" });
    const rotH1 = await h.nextOf("room-password");
    const rotB1 = await b.nextOf("room-password");
    expect(rotH1.password).toBeTruthy();
    expect(rotH1.password).not.toBe(PASSWORD);
    expect(rotB1.password).toBe(rotH1.password);
    expect(rotB1.rejoinToken).toBeTruthy();

    // Locked rotation withholds the secret from non-hosts, then re-shares it on unlock.
    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");
    await b.nextOf("room-state");

    h.send({ t: "rotate-password" });
    const rotH2 = await h.nextOf("room-password");
    const rotB2 = await b.nextOf("room-password");
    if (!rotH2.password) throw new Error("Expected rotated password");
    expect(rotH2.password).not.toBe(rotH1.password);
    expect(rotB2.password).toBeUndefined();
    expect(rotB2.rejoinToken).toBeTruthy();

    h.send({ t: "lock", locked: false });
    const unlockH = await h.nextOf("room-state");
    const unlockB = await b.nextOf("room-state");
    expect(unlockH).toEqual({ t: "room-state", locked: false, password: rotH2.password });
    expect(unlockB).toEqual({ t: "room-state", locked: false, password: rotH2.password });

    // Old passwords no longer admit newcomers, new rotated password does.
    const staleJoin = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.240" });
    staleJoin.send({ t: "join", room: CODE, displayName: "old", password: rotH1.password });
    expect((await staleJoin.nextOf("error")).code).toBe("bad-password");

    const freshJoin = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.241" });
    const wFresh = await freshJoin.join("newcomer", { password: rotH2.password });
    expect(wFresh.password).toBe(rotH2.password);

    for (const s of [h, b, freshJoin]) s.close();
  });

  it("emits session-replaced before 1008 and replaces id on non-resume rejoinToken eviction", async () => {
    const h = await Client.connect();
    await h.joinAsHost("host");
    const b1 = await Client.connect();
    const wb1 = await b1.join("bob");
    await h.nextOf("peer-joined");

    const b1Closed = closeCodeOf(b1.ws);
    const b2 = await Client.connect();
    b2.send({ t: "join", room: CODE, displayName: "bob", rejoinToken: wb1.rejoinToken });

    expect((await b1.nextOf("error")).code).toBe("session-replaced");
    expect(await b1Closed).toBe(1008);
    expect((await h.nextOf("peer-left")).id).toBe(wb1.selfId);
    const joined = await h.nextOf("peer-joined");
    const wb2 = await b2.nextOf("welcome");
    expect(joined.peer.id).toBe(wb2.selfId);
    expect(joined.replaces).toBe(wb1.selfId);

    h.close();
    b2.close();
  });

  it("manual invite rotation keeps previous rejoinToken usable during 25s grace for half-open reconnects in locked rooms", async () => {
    const h = await Client.connect();
    await h.joinAsHost("host");

    const b1 = await Client.connect();
    const wb1 = await b1.join("bob");
    await h.nextOf("peer-joined");

    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");
    await b1.nextOf("room-state");
    const b1Closed = closeCodeOf(b1.ws);

    // Host rotates invite secret; b1 simulates a half-open socket that never acts on the new rejoinToken.
    h.send({ t: "rotate-password" });
    await h.nextOf("room-password");

    const b2 = await Client.connect();
    b2.send({
      t: "join",
      room: CODE,
      displayName: "bob",
      rejoinToken: wb1.rejoinToken,
      resume: true,
    });
    const wb2 = await b2.nextOf("welcome");
    expect(wb2.selfId).toBe(wb1.selfId);
    expect((await b1.nextOf("error")).code).toBe("session-replaced");
    expect(await b1Closed).toBe(1008);
    expect(await h.silentFor(150)).toBe(true);

    h.close();
    b2.close();
  });

  it("clears stale hostGoneAt when the last peer disconnects and the room becomes empty", async () => {
    const h = await Client.connect();
    await h.joinAsHost("host");
    const b = await Client.connect();
    await b.join("bob");
    await h.nextOf("peer-joined");

    h.close();
    await b.nextOf("peer-left");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const whileOccupied = await runInDurableObject(stub, (_i, state) => state.storage.get<number>("hostGoneAt"));
    expect(typeof whileOccupied).toBe("number");

    b.close();
    await new Promise((r) => setTimeout(r, 100));

    const whenEmpty = await runInDurableObject(stub, async (_i, state) => ({
      hostGoneAt: await state.storage.get<number>("hostGoneAt"),
      emptySince: await state.storage.get<number>("emptySince"),
    }));
    expect(whenEmpty.hostGoneAt).toBeUndefined();
    expect(typeof whenEmpty.emptySince).toBe("number");
  });

  it("kicking a peer purges all disconnected rejoin tickets across IPs", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.230" });
    await h.joinAsHost("host");

    // Attacker session 1 connects, captures a valid rejoinToken, then disconnects.
    const e1 = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.10" });
    const we1 = await e1.join("eve");
    await h.nextOf("peer-joined");
    e1.close();
    await h.nextOf("peer-left");

    // Attacker session 2 joins from a different IP and is kicked by the host.
    const e2 = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.11" });
    const we2 = await e2.join("eve2");
    await h.nextOf("peer-joined");
    h.send({ t: "kick", id: we2.selfId });
    await h.nextOf("peer-left");
    await h.nextOf("room-password");

    // Pre-stashed rejoinToken from e1 must no longer be accepted even from an unbanned IP.
    const e3 = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.155" });
    const e3Closed = closeCodeOf(e3.ws);
    e3.send({ t: "join", room: CODE, displayName: "eve3", rejoinToken: we1.rejoinToken });
    expect((await e3.nextOf("error")).code).toBe("bad-password");
    expect(await e3Closed).toBe(1008);
    h.close();
  });

  it("rejects cross-origin, cross-site, and non-upgrade /ws requests before charging WS_LIMITER", async () => {
    const ip = "198.51.100.177";

    for (let i = 0; i < 65; i++) {
      const crossOrigin = await SELF.fetch(`https://example.com/ws/${CODE}`, {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": ip, Origin: "https://evil.example" },
      });
      if (crossOrigin.webSocket) {
        crossOrigin.webSocket.accept();
        crossOrigin.webSocket.close();
      }
      if (i === 0) expect(crossOrigin.status).toBe(101);

      const crossSite = await SELF.fetch(`https://example.com/ws/${CODE}`, {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": ip, "Sec-Fetch-Site": "cross-site" },
      });
      if (crossSite.webSocket) {
        crossSite.webSocket.accept();
        crossSite.webSocket.close();
      }
      if (i === 0) expect(crossSite.status).toBe(101);

      const nonUpgrade = await SELF.fetch(`https://example.com/ws/${CODE}`, {
        headers: { "CF-Connecting-IP": ip },
      });
      expect(nonUpgrade.status).toBe(426);
    }

    const legitimate = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: {
        Upgrade: "websocket",
        "CF-Connecting-IP": ip,
        Origin: "https://example.com",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(legitimate.status).toBe(101);
    legitimate.webSocket?.accept();
    legitimate.webSocket?.close();
  });

  it("rejects binary WebSocket frames with bad-message and close code 1008", async () => {
    const c = await Client.connect();
    const closed = closeCodeOf(c.ws);
    c.ws.send(new Uint8Array([1, 2, 3, 4]).buffer);
    expect((await c.nextOf("error")).code).toBe("bad-message");
    expect(await closed).toBe(1008);
  });

  it("preserves joinedAt promotion tenure across reconnects, recovers promotedHost token, and broadcasts peer-renamed", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.240" });
    await h.joinAsHost("host");

    const b1 = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.241" });
    const wb1 = await b1.join("bob");
    await h.nextOf("peer-joined");

    // Ensure carol has a strictly later joinedAt timestamp than bob.
    await new Promise((r) => setTimeout(r, 20));
    const c = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.242" });
    await c.join("carol");
    await h.nextOf("peer-joined");
    await b1.nextOf("peer-joined");

    // Bob resumes in-place with a new display name; carol must receive peer-renamed.
    const b2 = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.241" });
    b2.send({
      t: "join",
      room: CODE,
      displayName: "bobby",
      rejoinToken: wb1.rejoinToken,
      resume: true,
    });
    const wb2 = await b2.nextOf("welcome");
    expect(wb2.selfId).toBe(wb1.selfId);
    const renamedMsg = await c.nextOf("peer-renamed");
    expect(renamedMsg).toEqual({ t: "peer-renamed", id: wb1.selfId, name: "bobby" });

    // Host leaves and grace expires: bob (earliest joinedAt despite reconnecting later than carol) is promoted.
    h.close();
    await b2.nextOf("peer-left");
    await c.nextOf("peer-left");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("hostGoneAt", Date.now() - 6 * 60_000);
    });
    await runDurableObjectAlarm(stub);

    const promoBob = await b2.nextOf("host-promoted");
    const promoCarol = await c.nextOf("host-promoted");
    expect(promoBob.hostId).toBe(wb1.selfId);
    expect(promoCarol.hostId).toBe(wb1.selfId);

    const storedPromo = await runInDurableObject(stub, (_i, state) => state.storage.get("promotedHost"));
    expect(storedPromo).toBeDefined();

    // Even if all peers briefly disconnect before claiming the promotion, promotedHost survives until recovery or expiry.
    b2.close();
    c.close();
    await waitForRoomEmpty(stub);
    const promoWhileEmpty = await runInDurableObject(stub, (_i, state) => state.storage.get("promotedHost"));
    expect(promoWhileEmpty).toBeDefined();

    // Resuming with rejoinToken (without hostToken) recovers hostToken and clears promotedHost.
    const b3 = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.241" });
    b3.send({
      t: "join",
      room: CODE,
      displayName: "bobby",
      rejoinToken: wb2.rejoinToken,
      resume: true,
    });
    const wb3 = await b3.nextOf("welcome");
    expect(wb3.host).toBe(true);
    expect(typeof wb3.hostToken).toBe("string");

    const clearedPromo = await runInDurableObject(stub, (_i, state) => state.storage.get("promotedHost"));
    expect(clearedPromo).toBeUndefined();

    b3.close();
  });

  it("retains disconnect tickets for >12h active members in locked rooms and rotates across 20 peers", async () => {
    const h = await Client.connect();
    await h.joinAsHost("host");

    const b = await Client.connect();
    const wb = await b.join("bob");
    await h.nextOf("peer-joined");

    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");
    await b.nextOf("room-state");

    // Simulate disconnecting just 10s before the ordinary 12h ticket deadline (<= 25s without rotationGrace).
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    await runInDurableObject(stub, async (_i, state) => {
      const raw = (await state.storage.get<Record<string, { until: number; id: string }>>("members")) ?? {};
      for (const entry of Object.values(raw)) {
        if (entry.id === wb.selfId) entry.until = Date.now() + 10_000;
      }
      await state.storage.put("members", raw);
    });

    // Disconnecting grants a full 5-minute disconnect window instead of preserving the 10s deadline.
    b.close();
    await h.nextOf("peer-left");
    await new Promise((r) => setTimeout(r, 60));

    const bobTicketUntil = await runInDurableObject(stub, async (_i, state) => {
      const raw = (await state.storage.get<Record<string, { until: number; id: string }>>("members")) ?? {};
      return Object.values(raw).find((entry) => entry.id === wb.selfId)?.until ?? 0;
    });
    expect(bobTicketUntil).toBeGreaterThan(Date.now() + 4 * 60_000);

    const b2 = await Client.connect();
    b2.send({ t: "join", room: CODE, displayName: "bob", rejoinToken: wb.rejoinToken });
    const wb2 = await b2.nextOf("welcome");
    expect(wb2.locked).toBe(true);
    h.close();
    b2.close();

    // Verify full 20-peer room password rotation issues a fresh rejoinToken to every member.
    const fullCode = freshRoom();
    const fullInit = await initRoom(fullCode);
    const fullHost = await Client.connect(fullCode, { "CF-Connecting-IP": "198.51.101.1" });
    fullHost.send({
      t: "join",
      room: fullCode,
      displayName: "host",
      password: fullInit.password,
      hostToken: fullInit.hostToken,
    });
    await fullHost.nextOf("welcome");

    const guests: Client[] = [];
    for (let i = 1; i < MAX_ROOM_SIZE; i++) {
      const guest = await Client.connect(fullCode, { "CF-Connecting-IP": `198.51.101.${i + 1}` });
      guest.send({ t: "join", room: fullCode, displayName: `guest-${i}`, password: fullInit.password });
      await guest.nextOf("welcome");
      await fullHost.nextOf("peer-joined");
      for (const prevGuest of guests) await prevGuest.nextOf("peer-joined");
      guests.push(guest);
    }

    fullHost.send({ t: "rotate-password" });
    const hostRot = await fullHost.nextOf("room-password");
    expect(typeof hostRot.rejoinToken).toBe("string");
    expect(hostRot.rejoinToken?.length).toBeGreaterThan(0);

    for (const guest of guests) {
      const guestRot = await guest.nextOf("room-password");
      expect(typeof guestRot.rejoinToken).toBe("string");
      expect(guestRot.rejoinToken?.length).toBeGreaterThan(0);
    }

    fullHost.close();
    for (const guest of guests) guest.close();
  });

  it("clears ephemeral session/IP state, resets room lock, and rotates the invite secret when a locked room empties for 15m", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.10" });
    await h.joinAsHost("host");

    const eve = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.20" });
    const wEve = await eve.join("eve");
    await h.nextOf("peer-joined");

    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");
    await eve.nextOf("room-state");

    h.send({ t: "kick", id: wEve.selfId });
    await h.nextOf("peer-left");
    const rotMsg = await h.nextOf("room-password");
    const preResetPassword = rotMsg.password ?? "";
    expect(preResetPassword).not.toBe("");

    // Also place a stale promotedHost record to verify empty-session cleanup removes it.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    await runInDurableObject(stub, (_i, state) =>
      state.storage.put("promotedHost", { id: wEve.selfId, token: "stale-promo" }),
    );

    h.close();
    await waitForRoomEmpty(stub);

    await runInDurableObject(stub, (_i, state) =>
      state.storage.put("emptySince", Date.now() - 16 * 60_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const snapshot = await runInDurableObject(stub, async (_i, state) => ({
      claimed: await state.storage.get<boolean>("claimed"),
      passwordHash: await state.storage.get<string>("passwordHash"),
      roomPassword: await state.storage.get<string>("roomPassword"),
      hostTokenHash: await state.storage.get<string>("hostTokenHash"),
      locked: await state.storage.get<boolean>("locked"),
      sessionCleaned: await state.storage.get<boolean>("sessionCleaned"),
      members: await state.storage.get("members"),
      deny: await state.storage.get("deny"),
      promotedHost: await state.storage.get("promotedHost"),
      hostGoneAt: await state.storage.get("hostGoneAt"),
    }));

    expect(snapshot.claimed).toBe(true);
    expect(snapshot.passwordHash).toBeDefined();
    expect(snapshot.roomPassword).toBeTruthy();
    expect(snapshot.roomPassword).not.toBe(preResetPassword);
    expect(snapshot.hostTokenHash).toBeDefined();
    expect(snapshot.locked).toBe(false);
    expect(snapshot.sessionCleaned).toBe(true);
    expect(snapshot.members).toBeUndefined();
    expect(snapshot.deny).toBeUndefined();
    expect(snapshot.promotedHost).toBeUndefined();
    expect(snapshot.hostGoneAt).toBeUndefined();

    // Leaked pre-lock secret stays invalid after auto-unlock, while creator enters via hostToken and receives the rotated secret.
    const leaked = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.21" });
    leaked.send({ t: "join", room: CODE, displayName: "mallory", password: preResetPassword });
    expect((await leaked.nextOf("error")).code).toBe("bad-password");
    leaked.close();

    const creatorBack = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.10" });
    creatorBack.send({ t: "join", room: CODE, displayName: "host", hostToken: HOST_TOKEN });
    const wCreator = await creatorBack.nextOf("welcome");
    expect(wCreator.host).toBe(true);
    expect(wCreator.locked).toBe(false);
    expect(wCreator.password).toBe(snapshot.roomPassword);
    creatorBack.close();
  });

  it("allows next-day link reuse for unlocked rooms, preserves rotated revocation, and caps 90d TTL by creator activity", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.30" });
    await h.joinAsHost("host");
    const b = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.31" });
    await b.join("bob");
    await h.nextOf("peer-joined");

    h.send({ t: "rotate-password" });
    const rotHost = await h.nextOf("room-password");
    await b.nextOf("room-password");
    const activePassword = rotHost.password ?? "";
    expect(activePassword).not.toBe(PASSWORD);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    h.close();
    b.close();
    await waitForRoomEmpty(stub);

    // Simulate 25 hours passing empty and Stage 1 alarm firing on an unlocked room.
    const oldEmptySince = Date.now() - 25 * 60 * 60_000;
    await runInDurableObject(stub, (_i, state) => state.storage.put("emptySince", oldEmptySince));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // Pre-rotation invite secret remains permanently revoked the next day.
    const oldInviteClient = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.32" });
    oldInviteClient.send({ t: "join", room: CODE, displayName: "mallory", password: PASSWORD });
    expect((await oldInviteClient.nextOf("error")).code).toBe("bad-password");
    oldInviteClient.close();

    // Friend can enter the unlocked room the next day using the valid invite link.
    const bNextDay = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.31" });
    bNextDay.send({ t: "join", room: CODE, displayName: "bob", password: activePassword });
    const wbNext = await bNextDay.nextOf("welcome");
    expect(wbNext.locked).toBe(false);
    expect(wbNext.host).toBe(false);
    const afterGuestVisit = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<number>("lastHostActiveAt"),
    );

    // Original creator returns with persisted hostToken and regains host controls immediately, sliding lastHostActiveAt.
    const hNextDay = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.30" });
    hNextDay.send({
      t: "join",
      room: CODE,
      displayName: "host",
      password: activePassword,
      hostToken: HOST_TOKEN,
    });
    const whNext = await hNextDay.nextOf("welcome");
    expect(whNext.host).toBe(true);
    await bNextDay.nextOf("peer-joined");

    hNextDay.close();
    bNextDay.close();
    await waitForRoomEmpty(stub);

    const refreshed = await runInDurableObject(stub, async (_i, state) => ({
      emptySince: await state.storage.get<number>("emptySince"),
      lastHostActiveAt: await state.storage.get<number>("lastHostActiveAt"),
      sessionCleaned: await state.storage.get<boolean>("sessionCleaned"),
    }));
    expect(refreshed.emptySince).toBeGreaterThan(oldEmptySince + 24 * 60 * 60_000);
    expect(refreshed.lastHostActiveAt).toBeGreaterThanOrEqual(afterGuestVisit ?? 0);
    expect(refreshed.sessionCleaned).toBeUndefined();

    // Even if a non-host visited recently (emptySince = 1h ago), once lastHostActiveAt exceeds 90d the room expires.
    await runInDurableObject(stub, (_i, state) =>
      state.storage.put({
        emptySince: Date.now() - 60 * 60_000,
        lastHostActiveAt: Date.now() - (90 * 24 * 60 + 5) * 60_000,
      }),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const claimedAfterCap = await runInDurableObject(stub, (_i, state) => state.storage.get<boolean>("claimed"));
    expect(claimedAfterCap).toBeUndefined();
  });

  it("expires never-joined rooms after 12 hours instead of 90 days", async () => {
    const unusedCode = freshRoom();
    await initRoom(unusedCode);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(unusedCode));

    await runInDurableObject(stub, (_i, state) =>
      state.storage.put("emptySince", Date.now() - 13 * 60 * 60_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const remainingKeys = await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size);
    expect(remainingKeys).toBe(0);
  });

  it("arms a 15-minute safety fallback alarm while occupied and recovers if last-leave event was missed", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.60" });
    await h.joinAsHost("host");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));

    const alarmAt = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    expect(alarmAt!).toBeLessThanOrEqual(Date.now() + 16 * 60_000);

    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");
    h.close();
    await waitForRoomEmpty(stub);

    // Simulate a missed last-leave event where emptySince and sessionCleaned were never persisted.
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.delete(["emptySince", "sessionCleaned"]);
      await state.storage.put("locked", true);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // First alarm starts the 15-minute grace window and keeps members during the window.
    const duringGrace = await runInDurableObject(stub, async (_i, state) => ({
      emptySince: await state.storage.get<number>("emptySince"),
      locked: await state.storage.get<boolean>("locked"),
      sessionCleaned: await state.storage.get<boolean>("sessionCleaned"),
      members: await state.storage.get("members"),
      nextAlarm: await state.storage.getAlarm(),
    }));
    expect(typeof duringGrace.emptySince).toBe("number");
    expect(duringGrace.locked).toBe(true);
    expect(duringGrace.sessionCleaned).toBeUndefined();
    expect(duringGrace.members).toBeDefined();
    expect(duringGrace.nextAlarm).not.toBeNull();
    expect(duringGrace.nextAlarm!).toBeLessThanOrEqual(duringGrace.emptySince! + 15 * 60_000 + 100);

    // Once 15 minutes have elapsed past emptySince, cleanup unlocks and clears ephemeral state.
    await runInDurableObject(stub, (_i, state) => state.storage.put("emptySince", Date.now() - 16 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const recovered = await runInDurableObject(stub, async (_i, state) => ({
      locked: await state.storage.get<boolean>("locked"),
      sessionCleaned: await state.storage.get<boolean>("sessionCleaned"),
      members: await state.storage.get("members"),
    }));
    expect(recovered.locked).toBe(false);
    expect(recovered.sessionCleaned).toBe(true);
    expect(recovered.members).toBeUndefined();
  });

  it("enforces the 90d creator-activity cap even while promoted guests remain connected", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.65" });
    await h.joinAsHost("host");
    const bob = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.66" });
    await bob.join("bob");
    await h.nextOf("peer-joined");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));

    // While the creator is connected, firing the fallback alarm refreshes lastHostActiveAt.
    const staleStamp = Date.now() - 10 * 24 * 60 * 60_000;
    await runInDurableObject(stub, (_i, state) => state.storage.put("lastHostActiveAt", staleStamp));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const refreshedTs = await runInDurableObject(stub, (_i, state) => state.storage.get<number>("lastHostActiveAt"));
    expect(refreshedTs).toBeGreaterThan(staleStamp);

    // Creator leaves and bob stays connected and is promoted; after 90d without creator activity, alarm expires the room.
    h.close();
    await bob.nextOf("peer-left");
    await runInDurableObject(stub, (_i, state) => state.storage.put("hostGoneAt", Date.now() - 6 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await bob.nextOf("host-promoted");

    const bobClosed = closeCodeOf(bob.ws);
    await runInDurableObject(stub, (_i, state) =>
      state.storage.put("lastHostActiveAt", Date.now() - (90 * 24 * 60 + 5) * 60_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await bobClosed).toBe(1001);

    const remainingKeys = await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size);
    expect(remainingKeys).toBe(0);
  });

  it("restores creator host authority after 15m empty-session reset following mid-session guest promotion", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.70" });
    await h.joinAsHost("host");
    const bob = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.71" });
    await bob.join("bob");
    await h.nextOf("peer-joined");

    h.close();
    await bob.nextOf("peer-left");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    await runInDurableObject(stub, (_i, state) => state.storage.put("hostGoneAt", Date.now() - 6 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const promo = await bob.nextOf("host-promoted");
    const guestPromotedToken = promo.hostToken ?? "";
    expect(guestPromotedToken).not.toBe("");

    bob.close();
    await waitForRoomEmpty(stub);

    await runInDurableObject(stub, (_i, state) => state.storage.put("emptySince", Date.now() - 16 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // Original creator regains host: true next day, while guest's old session-promoted token does not.
    const hNext = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.70" });
    hNext.send({ t: "join", room: CODE, displayName: "host", hostToken: HOST_TOKEN });
    expect((await hNext.nextOf("welcome")).host).toBe(true);

    const bobNext = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.71" });
    bobNext.send({
      t: "join",
      room: CODE,
      displayName: "bob",
      password: PASSWORD,
      hostToken: guestPromotedToken,
    });
    expect((await bobNext.nextOf("welcome")).host).toBe(false);

    hNext.close();
    bobNext.close();
  });

  it("backfills creatorHostTokenHash for unjoined pre-deploy rooms and restores creator after promotion", async () => {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    // Exact storage shape of an unjoined room initialized before this PR deployed.
    await runInDurableObject(stub, (_i, state) =>
      state.storage.delete(["creatorHostTokenHash", "sessionCleaned", "everJoined", "lastHostActiveAt"]),
    );

    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.72" });
    await h.joinAsHost("host");
    const backfilledCreatorHash = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<string>("creatorHostTokenHash"),
    );
    expect(typeof backfilledCreatorHash).toBe("string");

    const bob = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.73" });
    await bob.join("bob");
    await h.nextOf("peer-joined");

    h.close();
    await bob.nextOf("peer-left");

    await runInDurableObject(stub, (_i, state) => state.storage.put("hostGoneAt", Date.now() - 6 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const promo = await bob.nextOf("host-promoted");
    const guestPromotedToken = promo.hostToken ?? "";
    expect(guestPromotedToken).not.toBe("");

    bob.close();
    await waitForRoomEmpty(stub);

    await runInDurableObject(stub, (_i, state) => state.storage.put("emptySince", Date.now() - 16 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const hNext = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.72" });
    hNext.send({ t: "join", room: CODE, displayName: "host", hostToken: HOST_TOKEN });
    expect((await hNext.nextOf("welcome")).host).toBe(true);

    const bobNext = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.73" });
    bobNext.send({
      t: "join",
      room: CODE,
      displayName: "bob",
      password: PASSWORD,
      hostToken: guestPromotedToken,
    });
    expect((await bobNext.nextOf("welcome")).host).toBe(false);

    hNext.close();
    bobNext.close();
  });

  it("backfills lastHostActiveAt when an invited guest joins an unjoined pre-deploy room before the creator", async () => {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const createdAt = Date.now() - 2 * 60 * 60_000;
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.delete(["creatorHostTokenHash", "sessionCleaned", "everJoined", "lastHostActiveAt"]);
      await state.storage.put("emptySince", createdAt);
    });

    // Invited guest joins first: both creatorHostTokenHash and lastHostActiveAt baseline are backfilled.
    const bob = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.76" });
    await bob.join("bob");
    const afterGuestJoin = await runInDurableObject(stub, async (_i, state) => ({
      creatorHash: await state.storage.get<string>("creatorHostTokenHash"),
      lastHostActiveAt: await state.storage.get<number>("lastHostActiveAt"),
    }));
    expect(typeof afterGuestJoin.creatorHash).toBe("string");
    expect(afterGuestJoin.lastHostActiveAt).toBe(createdAt);

    // Later creator join refreshes lastHostActiveAt.
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.77" });
    await h.joinAsHost("host");
    await bob.nextOf("peer-joined");
    const refreshedTs = await runInDurableObject(stub, (_i, state) => state.storage.get<number>("lastHostActiveAt"));
    expect(refreshedTs).toBeGreaterThan(createdAt);

    // Creator leaves; bob remains connected and hits the finite 90d occupied cap.
    h.close();
    await bob.nextOf("peer-left");
    const bobClosed = closeCodeOf(bob.ws);
    await runInDurableObject(stub, (_i, state) =>
      state.storage.put("lastHostActiveAt", Date.now() - (90 * 24 * 60 + 5) * 60_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await bobClosed).toBe(1001);
    const remainingKeys = await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size);
    expect(remainingKeys).toBe(0);
  });

  it("preserves unpromoted legacy host credentials within a non-sliding 12h TTL without upgrading to 90d", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.78" });
    await h.joinAsHost("host");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    h.close();
    await waitForRoomEmpty(stub);

    // Exact storage shape of an unpromoted pre-deploy room that already had joins (members present).
    const emptiedAt = Date.now() - 16 * 60_000;
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.delete([
        "creatorHostTokenHash",
        "sessionCleaned",
        "everJoined",
        "lastHostActiveAt",
        "promotedHost",
        "hostPromoted",
      ]);
      await state.storage.put("emptySince", emptiedAt);
    });

    // 15m reset clears ephemeral members while keeping HOST_KEY intact (never copying to CREATOR_HOST_KEY).
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterReset = await runInDurableObject(stub, async (_i, state) => ({
      members: await state.storage.get("members"),
      sessionCleaned: await state.storage.get<boolean>("sessionCleaned"),
      hostHash: await state.storage.get<string>("hostTokenHash"),
      creatorHash: await state.storage.get<string>("creatorHostTokenHash"),
      lastHostActiveAt: await state.storage.get<number>("lastHostActiveAt"),
    }));
    expect(afterReset.members).toBeUndefined();
    expect(afterReset.sessionCleaned).toBe(true);
    expect(typeof afterReset.hostHash).toBe("string");
    expect(afterReset.creatorHash).toBeUndefined();
    expect(afterReset.lastHostActiveAt).toBe(emptiedAt);

    // Original creator still authenticates as host during the remaining 12h legacy window.
    const hReturn = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.78" });
    hReturn.send({ t: "join", room: CODE, displayName: "host", hostToken: HOST_TOKEN });
    expect((await hReturn.nextOf("welcome")).host).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("creatorHostTokenHash"))).toBeUndefined();
    hReturn.close();
    await waitForRoomEmpty(stub);

    // Rejoining does not slide or upgrade the legacy room to 90d: once 12h past the anchored timestamp, it expires.
    await runInDurableObject(stub, (_i, state) =>
      state.storage.put("lastHostActiveAt", Date.now() - 12 * 60 * 60_000 - 1_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const remainingKeys = await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size);
    expect(remainingKeys).toBe(0);
  });

  it("revokes hostTokenHash on 15m reset after a post-deploy promotion in an already-joined legacy room", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.78" });
    await h.joinAsHost("host");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    h.close();
    await waitForRoomEmpty(stub);

    await runInDurableObject(stub, (_i, state) =>
      state.storage.delete([
        "creatorHostTokenHash",
        "sessionCleaned",
        "everJoined",
        "lastHostActiveAt",
        "promotedHost",
        "hostPromoted",
      ]),
    );

    // Guest joins legacy room and gets promoted post-deploy -> durable hostPromoted marker is set.
    const bob = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.79" });
    await bob.join("bob");
    await runInDurableObject(stub, (_i, state) => state.storage.put("hostGoneAt", Date.now() - 6 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const promo = await bob.nextOf("host-promoted");
    const promotedToken = promo.hostToken ?? "";
    expect(promotedToken).not.toBe("");
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get<boolean>("hostPromoted"))).toBe(true);

    // Even after bob reconnects with promotedToken (deleting promotedHost), 15m reset revokes hostTokenHash.
    bob.close();
    await waitForRoomEmpty(stub);
    const bobReconnect = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.79" });
    bobReconnect.send({ t: "join", room: CODE, displayName: "bob", hostToken: promotedToken });
    expect((await bobReconnect.nextOf("welcome")).host).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("promotedHost"))).toBeUndefined();
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get<boolean>("hostPromoted"))).toBe(true);
    bobReconnect.close();
    await waitForRoomEmpty(stub);

    await runInDurableObject(stub, (_i, state) => state.storage.put("emptySince", Date.now() - 16 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("hostTokenHash"))).toBeUndefined();
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("hostPromoted"))).toBeUndefined();
  });

  it("revokes temporary host authority on 15m reset in legacy rooms where creatorHostTokenHash is absent", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.74" });
    await h.joinAsHost("host");
    const bob = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.75" });
    const wBob = await bob.join("bob");
    await h.nextOf("peer-joined");

    h.close();
    await bob.nextOf("peer-left");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    await runInDurableObject(stub, (_i, state) => state.storage.put("hostGoneAt", Date.now() - 6 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const promo = await bob.nextOf("host-promoted");
    const promotedToken = promo.hostToken ?? "";
    expect(promotedToken).not.toBe("");

    // Simulate a legacy already-promoted room with promotedHost and members set, and all post-deploy markers absent.
    await runInDurableObject(stub, (_i, state) => state.storage.delete(["creatorHostTokenHash", "hostPromoted"]));
    bob.close();
    await waitForRoomEmpty(stub);
    await runInDurableObject(stub, (_i, state) => state.storage.delete(["everJoined", "lastHostActiveAt"]));

    // First reconnect consumes promotedHost via rejoinToken, deleting promotedHost and persisting hostPromoted.
    const bobResume1 = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.75" });
    bobResume1.send({ t: "join", room: CODE, displayName: "bob", rejoinToken: wBob.rejoinToken });
    const wResume1 = await bobResume1.nextOf("welcome");
    expect(wResume1.host).toBe(true);
    expect(wResume1.hostToken).toBe(promotedToken);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get<boolean>("hostPromoted"))).toBe(true);
    bobResume1.close();
    await waitForRoomEmpty(stub);

    // Second reconnect with promotedToken (after promotedHost was deleted) must not backfill creatorHostTokenHash.
    const bobResume2 = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.75" });
    bobResume2.send({
      t: "join",
      room: CODE,
      displayName: "bob",
      hostToken: promotedToken,
      rejoinToken: wResume1.rejoinToken,
    });
    expect((await bobResume2.nextOf("welcome")).host).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("creatorHostTokenHash"))).toBeUndefined();

    bobResume2.close();
    await waitForRoomEmpty(stub);

    await runInDurableObject(stub, (_i, state) => state.storage.put("emptySince", Date.now() - 16 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("hostTokenHash"))).toBeUndefined();
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("hostPromoted"))).toBeUndefined();

    // Next session: temporary promoted token is revoked and bob joins as a regular participant.
    const bobNext = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.75" });
    bobNext.send({
      t: "join",
      room: CODE,
      displayName: "bob",
      password: PASSWORD,
      hostToken: promotedToken,
    });
    expect((await bobNext.nextOf("welcome")).host).toBe(false);
    bobNext.close();
  });

  it("sweeps stale unjoined sockets via 10s alarm even in an already-cleaned empty room", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.80" });
    await h.joinAsHost("host");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    h.close();
    await waitForRoomEmpty(stub);

    await runInDurableObject(stub, (_i, state) => state.storage.put("emptySince", Date.now() - 16 * 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const idle = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.81" });
    const idleClosed = closeCodeOf(idle.ws);
    const scheduled = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(scheduled).not.toBeNull();
    expect(scheduled!).toBeLessThanOrEqual(Date.now() + 11_000);

    await runInDurableObject(stub, (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { openedAt?: number };
        ws.serializeAttachment({ ...att, openedAt: Date.now() - 20_000 });
      }
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await idleClosed).toBe(1008);
  });

  it("enforces 15m cleanup and 90d expiry lazily on join without charging password failure rate limits", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.40" });
    await h.joinAsHost("host");
    const eve = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.41" });
    const wEve = await eve.join("eve");
    await h.nextOf("peer-joined");

    // Ban an IP in an unlocked room and leave it empty.
    h.send({ t: "kick", id: wEve.selfId });
    await h.nextOf("peer-left");
    const rot = await h.nextOf("room-password");
    const activePassword = rot.password ?? "";
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    h.close();
    await waitForRoomEmpty(stub);

    // Jump 16 minutes ahead WITHOUT calling runDurableObjectAlarm.
    await runInDurableObject(stub, (_i, state) =>
      state.storage.put("emptySince", Date.now() - 16 * 60_000),
    );

    // Formerly banned IP enters after 15m cleanup once alarm has not run yet.
    const lateVisitor = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.41" });
    lateVisitor.send({ t: "join", room: CODE, displayName: "eve", password: activePassword });
    const wLate = await lateVisitor.nextOf("welcome");
    expect(wLate.locked).toBe(false);
    lateVisitor.close();
    await waitForRoomEmpty(stub);

    // Exhaust 15 wrong-password attempts from IP 198.51.100.42, then verify lazy expiry still returns bad-password
    // (not rate-limited) and closes any sibling unjoined socket with 1001.
    for (let i = 0; i < 15; i++) {
      const bad = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.42" });
      bad.send({ t: "join", room: CODE, displayName: "guesser", password: "WRONG23456789ABC" });
      expect((await bad.nextOf("error")).code).toBe("bad-password");
      bad.close();
    }

    const sibling = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.43" });
    const siblingClosed = closeCodeOf(sibling.ws);

    // Jump > 90 days ahead WITHOUT calling runDurableObjectAlarm.
    await runInDurableObject(stub, (_i, state) =>
      state.storage.put("emptySince", Date.now() - (90 * 24 * 60 + 5) * 60_000),
    );
    const expiredAttempt = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.42" });
    expiredAttempt.send({ t: "join", room: CODE, displayName: "alice", password: activePassword });
    expect((await expiredAttempt.nextOf("error")).code).toBe("bad-password");
    expiredAttempt.close();
    expect(await siblingClosed).toBe(1001);

    const remainingKeys = await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size);
    expect(remainingKeys).toBe(0);
  });

  it("adversarial: lock action on an expired/unclaimed room performs zero storage writes", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.70" });
    await h.joinAsHost("host");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));

    // Simulate storage having been cleared (room expired/unclaimed) before a stale lock frame is processed.
    await runInDurableObject(stub, (_i, state) => state.storage.deleteAll());

    h.send({ t: "lock", locked: true });
    // Flush DO message queue with a PING -> PONG roundtrip.
    h.ws.send(PING);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no PONG received")), 2000);
      const onMsg = (ev: MessageEvent) => {
        if (ev.data === PONG) {
          clearTimeout(timer);
          h.ws.removeEventListener("message", onMsg);
          resolve();
        }
      };
      h.ws.addEventListener("message", onMsg);
    });

    const remainingKeys = await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size);
    h.close();
    expect(remainingKeys).toBe(0);
  });

  it("adversarial: rejects cross-site Sec-Fetch-Site and Origin: null on /api/room and /ws/:code with strict CSP/Trusted Types", async () => {
    const crossSiteCreate = await SELF.fetch("https://example.com/api/room", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSiteCreate.status).toBe(403);
    const csp = crossSiteCreate.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain("trusted-types 'none'");

    const nullOriginCreate = await SELF.fetch("https://example.com/api/room", {
      method: "POST",
      headers: { Origin: "null" },
    });
    expect(nullOriginCreate.status).toBe(403);

    const crossSiteWs = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", "Sec-Fetch-Site": "cross-site" },
    });
    expect(await refusal(crossSiteWs)).toEqual({ code: "forbidden-origin", closeCode: 1008 });

    const nullOriginWs = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", Origin: "null" },
    });
    expect(await refusal(nullOriginWs)).toEqual({ code: "forbidden-origin", closeCode: 1008 });
  });

  it("adversarial: kick in a locked room atomically bans IP, rotates password without leaking to guests, and purges disconnected tickets", async () => {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.80" });
    await h.joinAsHost("host");
    const stay = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.81" });
    const wStay = await stay.join("stay");
    expect(wStay.rejoinToken).toBeTruthy();
    await h.nextOf("peer-joined");
    const target = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.82" });
    const wTarget = await target.join("target");
    await h.nextOf("peer-joined");
    await stay.nextOf("peer-joined");
    const gone = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.83" });
    const wGone = await gone.join("gone");
    expect(wGone.rejoinToken).toBeTruthy();
    await h.nextOf("peer-joined");
    await stay.nextOf("peer-joined");
    await target.nextOf("peer-joined");

    // Disconnect 'gone' so they hold a disconnected rejoin ticket, then lock the room.
    gone.close();
    await h.nextOf("peer-left");
    await stay.nextOf("peer-left");
    await target.nextOf("peer-left");

    h.send({ t: "lock", locked: true });
    await h.nextOf("room-state");
    await stay.nextOf("room-state");
    await target.nextOf("room-state");

    const targetClosed = closeCodeOf(target.ws);
    h.send({ t: "kick", id: wTarget.selfId });

    const targetErr = await target.nextOf("error");
    expect(targetErr.code).toBe("kicked");
    expect(await targetClosed).toBe(1008);

    const hostRot = await h.nextOf("room-password");
    const stayRot = await stay.nextOf("room-password");
    expect(hostRot.password).toBeTruthy();
    expect(hostRot.password).not.toBe(PASSWORD);
    expect(hostRot.rejoinToken).toBeTruthy();
    // Locked room: non-host receives fresh rejoinToken but NO plaintext password.
    expect(stayRot.password).toBeUndefined();
    expect(stayRot.rejoinToken).toBeTruthy();

    // Verify the kicked address was persisted in the deny list independently of room lock.
    const denyEntry = await runInDurableObject(stub, async (_i, state) => {
      const deny = await state.storage.get<Record<string, number>>("deny");
      return deny?.["198.51.100.82"];
    });
    expect(denyEntry).toBeGreaterThan(Date.now());

    // Disconnected peer's old rejoin ticket was purged by kick.
    const goneRetry = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.83" });
    goneRetry.send({ t: "join", room: CODE, displayName: "gone", rejoinToken: wGone.rejoinToken });
    expect((await goneRetry.nextOf("error")).code).toBe("bad-password");
    goneRetry.close();

    // Remaining non-kicked peer retains a short grace window for their pre-kick ticket if they drop before receiving room-password.
    stay.close();
    await h.nextOf("peer-left");
    const stayReconnect = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.81" });
    stayReconnect.send({ t: "join", room: CODE, displayName: "stay", rejoinToken: wStay.rejoinToken, resume: true });
    const wStayRejoined = await stayReconnect.nextOf("welcome");
    expect(wStayRejoined.selfId).toBe(wStay.selfId);
    stayReconnect.close();

    h.close();
  });

  it("rejects viewer-originated SDP offer signals when sender is not sharing even if recipient is sharing", async () => {
    const sharer = await Client.connect();
    const wSharer = await sharer.join("sharer");
    const viewer = await Client.connect();
    const wViewer = await viewer.join("viewer");
    await sharer.nextOf("peer-joined");

    // Sharer begins sharing; viewer remains non-sharing.
    sharer.send({ t: "state", sharing: true });
    expect(await viewer.nextOf("peer-state")).toEqual({ t: "peer-state", id: wSharer.selfId, sharing: true });

    // Viewer attempts to originate an SDP offer to the active sharer -> rejected with not-sharing.
    viewer.send({ t: "signal", to: wSharer.selfId, data: { k: "offer", sdp: "v=0\r\n" } });
    expect((await viewer.nextOf("error")).code).toBe("not-sharing");
    expect(await sharer.silentFor(200)).toBe(true);

    // Sharer -> viewer offer is still allowed, and viewer -> sharer answer/ice remain allowed.
    sharer.send({ t: "signal", to: wViewer.selfId, data: { k: "offer", sdp: "v=0\r\n" } });
    expect((await viewer.nextOf("signal")).data.k).toBe("offer");
    viewer.send({ t: "signal", to: wSharer.selfId, data: { k: "answer", sdp: "v=0\r\n" } });
    expect((await sharer.nextOf("signal")).data.k).toBe("answer");

    sharer.close();
    viewer.close();
  });

  it("enforces strict wss:// and same-origin Origin header on production WebSocket upgrades", async () => {
    // Missing Origin on production HTTPS upgrade -> rejected with forbidden-origin (1008).
    const missingOrigin = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "198.51.100.91" },
    });
    expect(await refusal(missingOrigin)).toEqual({ code: "forbidden-origin", closeCode: 1008 });

    // Insecure HTTP upgrade on non-localhost production host -> rejected even with matching Origin.
    const insecureProd = await SELF.fetch(`http://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", Origin: "http://example.com", "CF-Connecting-IP": "198.51.100.92" },
    });
    expect(await refusal(insecureProd)).toEqual({ code: "forbidden-origin", closeCode: 1008 });

    // Local HTTP dev/test (localhost) without Origin -> allowed.
    const localDev = await SELF.fetch(`http://localhost:8787/ws/${CODE}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "198.51.100.93" },
    });
    expect(localDev.status).toBe(101);
    localDev.webSocket?.accept();
    localDev.webSocket?.close();

    // Production HTTPS with matching same-origin Origin -> allowed.
    const validProd = await SELF.fetch(`https://example.com/ws/${CODE}`, {
      headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": "198.51.100.94" },
    });
    expect(validProd.status).toBe(101);
    validProd.webSocket?.accept();
    validProd.webSocket?.close();
  });

  it("answers PING via WebSocket auto-response without consuming per-socket message rate-limit budget", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    let pongCount = 0;
    const allPongs = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`only received ${pongCount}/75 PONGs`)), 3000);
      a.ws.addEventListener("message", (ev) => {
        if (ev.data === PONG) {
          pongCount++;
          if (pongCount === 75) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    // Send 75 PINGs in one burst (exceeds MESSAGE_BURST = 60).
    for (let i = 0; i < 75; i++) {
      a.ws.send(PING);
    }
    await allPongs;

    // Socket must still be open and have full message budget for regular frames.
    a.send({ t: "state", sharing: true });
    expect((await b.nextOf("peer-state")).sharing).toBe(true);
    expect(await a.peekError(150)).toBeNull();

    a.close();
    b.close();
  });

  it("handleStateAction performs zero writes and no broadcast on unclaimed/expired rooms and stays consistent after rotate-password", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.101" });
    const wh = await h.joinAsHost("host");
    const g = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.102" });
    const wg = await g.join("guest");
    await h.nextOf("peer-joined");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));

    // Rotate password, then guest sends state: sharing=true; must update the rotated rejoinHash record.
    h.send({ t: "rotate-password" });
    const hRot = await h.nextOf("room-password");
    const gRot = await g.nextOf("room-password");
    g.send({ t: "state", sharing: true });
    expect(await h.nextOf("peer-state")).toEqual({ t: "peer-state", id: wg.selfId, sharing: true });

    // Verify the rotated member entry persisted sharing: true (not lost to stale rejoinHash).
    const persistedSharing = await runInDurableObject(stub, async (_i, state) => {
      const members = await state.storage.get<Record<string, { id?: string; sharing?: boolean }>>("members");
      return Object.values(members ?? {}).some((m) => m.id === wg.selfId && m.sharing === true);
    });
    expect(persistedSharing).toBe(true);
    expect(gRot.rejoinToken).toBeTruthy();

    // Kicked/refused socket sending a trailing state frame must not broadcast peer-state.
    expect(hRot.password).toBeTruthy();
    const k = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.103" });
    const wk = await k.join("kicked-peer", ...(hRot.password ? [{ password: hRot.password }] : []));
    await h.nextOf("peer-joined");
    await g.nextOf("peer-joined");
    h.send({ t: "kick", id: wk.selfId });
    k.send({ t: "state", sharing: true });
    expect((await k.nextOf("error")).code).toBe("kicked");
    expect((await g.nextOf("peer-left")).id).toBe(wk.selfId);
    await g.nextOf("room-password");
    expect(await g.silentFor(200)).toBe(true);
    k.close();

    // Now clear storage (simulate expired/unclaimed room) and send a state update -> zero writes, no broadcast.
    await runInDurableObject(stub, (_i, state) => state.storage.deleteAll());
    h.send({ t: "state", sharing: true });
    expect(await g.silentFor(250)).toBe(true);
    const remainingKeys = await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size);
    expect(remainingKeys).toBe(0);
    expect(wh.selfId).toBeTruthy();

    h.close();
    g.close();
  });

  it("applyResumeState forwards activePeerIds to prevent reusing an active non-superseded peer id", () => {
    const replaced: Array<[string, string]> = [];
    const attColliding = { id: "fresh-id-1", name: "bob", sharing: false, joined: false };
    applyResumeState(
      attColliding,
      { t: "join", room: CODE, displayName: "bob", resume: true },
      undefined,
      { until: Date.now() + 60_000, id: "active-peer-id", sharing: true },
      new Set(["active-peer-id"]),
      (oldId, newId) => replaced.push([oldId, newId]),
    );
    expect(attColliding.id).toBe("fresh-id-1");
    expect(attColliding.sharing).toBe(true);
    expect(replaced).toEqual([]);

    const attFree = { id: "fresh-id-2", name: "bob", sharing: false, joined: false };
    applyResumeState(
      attFree,
      { t: "join", room: CODE, displayName: "bob", resume: true },
      undefined,
      { until: Date.now() + 60_000, id: "free-peer-id", sharing: true },
      new Set(["active-peer-id"]),
      (oldId, newId) => replaced.push([oldId, newId]),
    );
    expect(attFree.id).toBe("free-peer-id");
    expect(attFree.sharing).toBe(true);
    expect(replaced).toEqual([["fresh-id-2", "free-peer-id"]]);
  });
});

describe("Worker and RoomDO uncovered branch coverage", () => {
  it("handles rate-limiter bindings failing open, denying, malformed Origin, and DO fetch errors in worker/index.ts", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockAssets = { fetch: async () => new Response("ok") } as unknown as Fetcher;
    const makeStub = (handler: () => Promise<Response>): Env["ROOMS"] =>
      ({
        idFromName: () => "id-1",
        get: () => ({ fetch: handler }),
      }) as unknown as Env["ROOMS"];

    // 1. ROOM_LIMITER throws -> fails open; /api/room DO throws twice then succeeds
    let attempts = 0;
    const retryEnv: Env = {
      ASSETS: mockAssets,
      ROOMS: makeStub(async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient DO failure");
        return new Response(JSON.stringify({ code: CODE, password: "P", hostToken: "H" }), { status: 200 });
      }),
      ROOM_LIMITER: { limit: async () => { throw new Error("limiter down"); } },
    };
    const okRes = await worker.fetch(
      new Request("https://example.com/api/room", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.240" } }),
      retryEnv,
    );
    expect(okRes.status).toBe(200);
    expect(attempts).toBe(3);

    // 2. ROOM_LIMITER returns { success: false } -> 429
    const deniedCreate = await worker.fetch(
      new Request("https://example.com/api/room", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.241" } }),
      { ...retryEnv, ROOM_LIMITER: { limit: async () => ({ success: false }) } },
    );
    expect(deniedCreate.status).toBe(429);

    // 3. Malformed Origin on POST /api/room -> 403
    const badOriginRes = await worker.fetch(
      new Request("https://example.com/api/room", {
        method: "POST",
        headers: { Origin: "http://[invalid", "CF-Connecting-IP": "198.51.100.242" },
      }),
      retryEnv,
    );
    expect(badOriginRes.status).toBe(403);

    // 4. /api/room DO 409 retry exhaustion -> 503 and non-409 status -> 503
    const conflictEnv: Env = {
      ASSETS: mockAssets,
      ROOMS: makeStub(async () => new Response("conflict", { status: 409 })),
    };
    expect(
      (
        await worker.fetch(
          new Request("https://example.com/api/room", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.243" } }),
          conflictEnv,
        )
      ).status,
    ).toBe(503);

    const errEnv: Env = {
      ASSETS: mockAssets,
      ROOMS: makeStub(async () => new Response("boom", { status: 500 })),
    };
    expect(
      (
        await worker.fetch(
          new Request("https://example.com/api/room", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.244" } }),
          errEnv,
        )
      ).status,
    ).toBe(503);

    // 5. /ws/:code WS_LIMITER { success: false } and stub.fetch throw -> 1013 refusal
    const wsDenied = await worker.fetch(
      new Request(`https://example.com/ws/${CODE}`, {
        headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": "198.51.100.245" },
      }),
      {
        ASSETS: mockAssets,
        ROOMS: makeStub(async () => new Response("unused")),
        WS_LIMITER: { limit: async () => ({ success: false }) },
      },
    );
    expect((await refusal(wsDenied)).code).toBe("rate-limited");

    const wsDoThrow = await worker.fetch(
      new Request(`https://example.com/ws/${CODE}`, {
        headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": "198.51.100.246" },
      }),
      {
        ASSETS: mockAssets,
        ROOMS: makeStub(async () => { throw new Error("DO unreachable"); }),
      },
    );
    expect((await refusal(wsDoThrow)).code).toBe("rate-limited");
    warnSpy.mockRestore();
  });

  it("handles /init validation, bad-room-code on join, late join-timeout, and webSocketError in RoomDO", async () => {
    const unclaimed = freshRoom();
    const unclaimedStub = env.ROOMS.get(env.ROOMS.idFromName(unclaimed));

    // /init invalid JSON, invalid code schema, and duplicate claim 409
    expect(
      (await unclaimedStub.fetch("https://internal/init", { method: "POST", body: "{bad-json" })).status,
    ).toBe(400);
    expect(
      (
        await unclaimedStub.fetch("https://internal/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "bad" }),
        })
      ).status,
    ).toBe(400);

    const claimedStub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    expect(
      (
        await claimedStub.fetch("https://internal/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: CODE }),
        })
      ).status,
    ).toBe(409);

    // Join message with wrong room code -> bad-room-code
    const wrongRoom = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.120" });
    wrongRoom.send({ t: "join", room: CODE2, displayName: "alice", password: PASSWORD });
    expect((await wrongRoom.nextOf("error")).code).toBe("bad-room-code");
    wrongRoom.close();

    // Unjoined socket past JOIN_DEADLINE_MS -> join-timeout
    const late = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.121" });
    await runInDurableObject(claimedStub, (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { joined?: boolean; openedAt?: number };
        if (!att.joined) ws.serializeAttachment({ ...att, openedAt: Date.now() - 15_000 });
      }
    });
    late.send({ t: "join", room: CODE, displayName: "late", password: PASSWORD });
    expect((await late.nextOf("error")).code).toBe("join-timeout");
    late.close();

    // webSocketError removes peer cleanly and notifies remaining peer
    const host = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.122" });
    await host.joinAsHost("host");
    const guest = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.123" });
    const wGuest = await guest.join("guest");
    await host.nextOf("peer-joined");

    const guestClosed = closeCodeOf(guest.ws);
    await runInDurableObject(claimedStub, async (instance, state) => {
      const target = state.getWebSockets().find((s) => (s.deserializeAttachment() as { id?: string }).id === wGuest.selfId);
      if (target) await instance.webSocketError(target, new Error("socket reset"));
    });
    expect((await host.nextOf("peer-left")).id).toBe(wGuest.selfId);
    expect(await guestClosed).toBe(1011);
    host.close();
  });

  it("handles host/action edge cases and alarm lifecycle edge cases", async () => {
    const h = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.130" });
    const wh = await h.joinAsHost("host");
    const g = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.131" });
    await g.join("guest");
    await h.nextOf("peer-joined");

    // Self-kick no-op, unknown-peer kick, non-host rotate-password, identical-name rename no-op
    h.send({ t: "kick", id: wh.selfId });
    expect(await h.peekError(120)).toBeNull();
    h.send({ t: "kick", id: UNKNOWN_PEER });
    expect((await h.nextOf("error")).code).toBe("unknown-peer");
    g.send({ t: "rotate-password" });
    expect((await g.nextOf("error")).code).toBe("not-host");
    h.send({ t: "rename", displayName: "host" });
    expect(await g.silentFor(120)).toBe(true);

    // Occupied alarm with missing hostGoneAt sets hostGoneAt; before HOST_GRACE_MS keeps guest non-host
    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    h.close();
    await g.nextOf("peer-left");
    await runInDurableObject(stub, (_i, state) => state.storage.delete("hostGoneAt"));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get<number>("hostGoneAt"))).toBeTypeOf("number");

    await runInDurableObject(stub, (_i, state) => state.storage.put("hostGoneAt", Date.now() - 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await g.silentFor(120)).toBe(true);
    g.close();
    await waitForRoomEmpty(stub);

    // Missing emptySince with expired lastHostActiveAt expires room on alarm
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.delete("emptySince");
      await state.storage.put("lastHostActiveAt", Date.now() - 91 * 86_400_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size)).toBe(0);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();

    // Unclaimed room alarm deletes alarm with zero writes
    const unclaimed = freshRoom();
    const unclaimedStub = env.ROOMS.get(env.ROOMS.idFromName(unclaimed));
    await runInDurableObject(unclaimedStub, (_i, state) => state.storage.setAlarm(Date.now() + 1000));
    expect(await runDurableObjectAlarm(unclaimedStub)).toBe(true);
    expect(await runInDurableObject(unclaimedStub, async (_i, state) => (await state.storage.list()).size)).toBe(0);
    expect(await runInDurableObject(unclaimedStub, (_i, state) => state.storage.getAlarm())).toBeNull();
  });

  it("handles in-place resume broadcasts (peer-state, host-promoted) and multi-socket eviction", async () => {
    const observer = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.140" });
    await observer.join("observer");

    const host = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.141" });
    const wHost = await host.joinAsHost("host");
    await observer.nextOf("peer-joined");

    const guest = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.142" });
    const wGuest = await guest.join("guest");
    await observer.nextOf("peer-joined");
    await host.nextOf("peer-joined");

    // Close original host first so resuming guest deterministically upgrades host + sharing in-place
    host.close();
    expect((await observer.nextOf("peer-left")).id).toBe(wHost.selfId);

    const resumed = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.142" });
    const guestReplaced = closeCodeOf(guest.ws);
    resumed.send({
      t: "join",
      room: CODE,
      displayName: "guest",
      hostToken: HOST_TOKEN,
      rejoinToken: wGuest.rejoinToken,
      resume: true,
      sharing: true,
    });
    const wResumed = await resumed.nextOf("welcome");
    expect(wResumed.selfId).toBe(wGuest.selfId);
    expect(wResumed.host).toBe(true);

    const promoEvents: ServerMessage[] = [await observer.next(), await observer.next()];
    expect(promoEvents).toContainEqual({ t: "peer-state", id: wResumed.selfId, sharing: true });
    expect(promoEvents).toContainEqual({ t: "host-promoted", hostId: wResumed.selfId });
    expect(await guestReplaced).toBe(1008);

    // Multi-socket eviction (isResume matching both another guest ticket and an active host socket)
    const extraGuest = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.143" });
    const wExtra = await extraGuest.join("extra");
    await observer.nextOf("peer-joined");
    await resumed.nextOf("peer-joined");

    const multi = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.143" });
    const resumedEvicted = closeCodeOf(resumed.ws);
    const extraEvicted = closeCodeOf(extraGuest.ws);
    multi.send({
      t: "join",
      room: CODE,
      displayName: "extra",
      hostToken: HOST_TOKEN,
      rejoinToken: wExtra.rejoinToken,
      resume: true,
    });
    const wMulti = await multi.nextOf("welcome");
    expect([wResumed.selfId, wExtra.selfId]).toContain(wMulti.selfId);
    const leftId = wMulti.selfId === wExtra.selfId ? wResumed.selfId : wExtra.selfId;
    expect((await observer.nextOf("peer-left")).id).toBe(leftId);
    expect(await resumedEvicted).toBe(1008);
    expect(await extraEvicted).toBe(1008);

    observer.close();
    multi.close();
  });
});

