import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_ROOM_SIZE, PING, PONG, type ServerMessage } from "@shared/protocol";

const CODE = "ABCDEFGH";
const CODE2 = "JKMNPQRS";

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

  static async connect(room = CODE): Promise<Client> {
    const res = await SELF.fetch(`https://example.com/ws/${room}`, {
      headers: { Upgrade: "websocket" },
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
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
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

  it("falls back to STUN-only when TURN secrets are unset, rather than failing", async () => {
    // A missing TURN config must not break the app: direct P2P is the common path
    // and needs no TURN at all.
    const res = await SELF.fetch("https://example.com/api/ice", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { iceServers: Array<{ urls: string | string[] }> };
    expect(body.iceServers.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.iceServers)).toContain("stun:");
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
});
