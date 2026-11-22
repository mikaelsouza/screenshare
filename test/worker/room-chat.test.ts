import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_CHAT_LENGTH, PING, PONG, type ServerMessage } from "@shared/protocol";

let roomCounter = 100_000;
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

function closeCodeOf(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket was not closed")), timeoutMs);
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve(ev.code);
    });
  });
}

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
    const targetRoom = room ?? CODE;
    const ip = `198.18.${Math.floor(roomCounter / 250) % 256}.${(roomCounter % 250) + 1}`;
    const res = await SELF.fetch(`https://example.com/ws/${targetRoom}`, {
      headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": ip, ...extraHeaders },
    });
    if (!res.webSocket) throw new Error(`no webSocket on response (status ${res.status})`);
    res.webSocket.accept();
    return new Client(res.webSocket);
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

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
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(timeoutErr);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async nextOf<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    for (let i = 0; i < 15; i++) {
      const m = await this.next();
      if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
    }
    throw new Error(`never received a "${t}" message`);
  }

  async join(
    name = "tester",
    opts?: { hostToken?: string; resume?: boolean; rejoinToken?: string },
  ): Promise<Extract<ServerMessage, { t: "welcome" }>> {
    this.send({
      t: "join",
      room: CODE,
      displayName: name,
      password: PASSWORD,
      ...(opts?.hostToken !== undefined ? { hostToken: opts.hostToken } : {}),
      ...(opts?.rejoinToken !== undefined ? { rejoinToken: opts.rejoinToken } : {}),
      ...(opts?.resume !== undefined ? { resume: opts.resume } : {}),
    });
    return this.nextOf("welcome");
  }

  async joinAsHost(name = "host"): Promise<Extract<ServerMessage, { t: "welcome" }>> {
    return this.join(name, { hostToken: HOST_TOKEN });
  }

  async silentFor(ms = 250): Promise<boolean> {
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

beforeEach(async () => {
  CODE = freshRoom();
  const created = await initRoom(CODE);
  PASSWORD = created.password;
  HOST_TOKEN = created.hostToken;
});

describe("RoomDO ephemeral chat relay", () => {
  it("relays chat between 2 joined peers with 0 sharers and echoes to sender", async () => {
    const a = await Client.connect();
    const wa = await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    a.send({ t: "chat", text: "hello with zero sharers" });
    const [aMsg, bMsg] = await Promise.all([a.nextOf("chat"), b.nextOf("chat")]);
    expect(aMsg).toEqual(bMsg);
    expect(aMsg).toMatchObject({
      t: "chat",
      from: wa.selfId,
      name: "alice",
      text: "hello with zero sharers",
    });
    expect(aMsg.id.length).toBeGreaterThan(0);
    expect(Number.isFinite(aMsg.ts)).toBe(true);

    a.close();
    b.close();
  });

  it("ignores chat from an unjoined socket without replying or leaking to joined peers", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const unjoined = await Client.connect();

    unjoined.send({ t: "chat", text: "sneaky" });
    expect(await unjoined.silentFor(250)).toBe(true);
    expect(await a.silentFor(250)).toBe(true);

    unjoined.close();
    a.close();
  });

  it("ignores blank/control-only chat silently without consuming burst tokens and preserves compound emojis", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    a.send({ t: "chat", text: "  \u0007\u202E  " });
    expect(await a.silentFor(200)).toBe(true);
    expect(await b.silentFor(200)).toBe(true);

    // Compound emojis preserved while bidi/control stripped
    a.send({ t: "chat", text: "hi\u202E 👨‍👩‍👧‍👦 \u0007🏳️‍🌈" });
    const emojiMsg = await b.nextOf("chat");
    expect(emojiMsg.text).toBe("hi 👨‍👩‍👧‍👦 🏳️‍🌈");
    await a.nextOf("chat");

    // 6-message burst still works (control-only did not consume budget; 1 used by emojiMsg -> 5 left, wait: send 5 more)
    for (let i = 0; i < 5; i++) {
      a.send({ t: "chat", text: `b-${i}` });
      await a.nextOf("chat");
    }

    a.close();
    b.close();
  });

  it("rejects wire-invalid chat payloads with bad-message without closing socket", async () => {
    const a = await Client.connect();
    await a.join("alice");

    a.send({ t: "chat", text: "" });
    expect((await a.nextOf("error")).code).toBe("bad-message");

    a.send({ t: "chat", text: "x".repeat(MAX_CHAT_LENGTH + 1) });
    expect((await a.nextOf("error")).code).toBe("bad-message");

    // Socket remains usable
    a.send({ t: "chat", text: "still alive" });
    expect((await a.nextOf("chat")).text).toBe("still alive");
    a.close();
  });

  it("reflects live rename in subsequent chat messages", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    a.send({ t: "rename", displayName: "alice-renamed" });
    await b.nextOf("peer-renamed");

    a.send({ t: "chat", text: "new name check" });
    const msg = await b.nextOf("chat");
    expect(msg.name).toBe("alice-renamed");

    a.close();
    b.close();
  });

  it("enforces soft chat rate limit (6 burst, 7th rate-limited without closing, refills after ~750ms, other peer unaffected)", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    for (let i = 0; i < 6; i++) {
      a.send({ t: "chat", text: `burst-${i}` });
    }
    for (let i = 0; i < 6; i++) {
      await a.nextOf("chat");
      await b.nextOf("chat");
    }

    a.send({ t: "chat", text: "burst-7" });
    const err = await a.nextOf("error");
    expect(err.code).toBe("chat-rate-limited");
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(await b.silentFor(200)).toBe(true);

    // Other peer unaffected
    b.send({ t: "chat", text: "bob ok" });
    expect((await a.nextOf("chat")).text).toBe("bob ok");
    await b.nextOf("chat");

    // Refill (~750ms > 1 / 1.5s = 667ms)
    await new Promise((r) => setTimeout(r, 750));
    a.send({ t: "chat", text: "after refill" });
    expect((await b.nextOf("chat")).text).toBe("after refill");

    a.close();
    b.close();
  });

  it("respects kick and lock moderation with chat", async () => {
    const host = await Client.connect(CODE, { "CF-Connecting-IP": "198.51.100.1" });
    await host.joinAsHost("host");
    const guest = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.5" });
    const wg = await guest.join("guest");
    await host.nextOf("peer-joined");

    const guestClosed = closeCodeOf(guest.ws);
    host.send({ t: "kick", id: wg.selfId });
    expect((await guest.nextOf("error")).code).toBe("kicked");
    expect(await guestClosed).toBe(1008);
    const rotated = await host.nextOf("room-password");

    host.send({ t: "lock", locked: true });
    await host.nextOf("room-state");

    const blocked = await Client.connect(CODE, { "CF-Connecting-IP": "203.0.113.99" });
    blocked.send({ t: "join", room: CODE, displayName: "late", password: rotated.password });
    expect((await blocked.nextOf("error")).code).toBe("room-locked");

    // Already-joined host can still send chat while locked
    host.send({ t: "chat", text: "locked chat works" });
    expect((await host.nextOf("chat")).text).toBe("locked chat works");

    host.close();
    blocked.close();
  });

  it("resets chat budget via clearPeerState across disconnect+rejoin and non-resume host eviction", async () => {
    const a1 = await Client.connect();
    await a1.joinAsHost("host-1");

    // Exhaust burst of 6
    for (let i = 0; i < 6; i++) {
      a1.send({ t: "chat", text: `m-${i}` });
      await a1.nextOf("chat");
    }
    a1.send({ t: "chat", text: "limited" });
    expect((await a1.nextOf("error")).code).toBe("chat-rate-limited");

    // Non-resume host join evicts a1 with clearPeerState
    const a2 = await Client.connect();
    await a2.joinAsHost("host-2");
    for (let i = 0; i < 6; i++) {
      a2.send({ t: "chat", text: `fresh-${i}` });
      await a2.nextOf("chat");
    }

    // Disconnect and fresh rejoin resets budget
    a2.close();
    await new Promise((r) => setTimeout(r, 100));
    const a3 = await Client.connect();
    await a3.joinAsHost("host-3");
    for (let i = 0; i < 6; i++) {
      a3.send({ t: "chat", text: `rejoin-${i}` });
      await a3.nextOf("chat");
    }

    a1.close();
    a3.close();
  });

  it("performs zero Durable Object persistent storage writes when relaying chat", async () => {
    const a = await Client.connect();
    await a.join("alice");
    const b = await Client.connect();
    await b.join("bob");
    await a.nextOf("peer-joined");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(CODE));
    const before = await runInDurableObject(stub, async (_i, state) => {
      const entries = await state.storage.list();
      return Object.fromEntries(entries.entries());
    });

    for (let i = 0; i < 5; i++) {
      a.send({ t: "chat", text: `ephemeral-${i}` });
      await b.nextOf("chat");
      await a.nextOf("chat");
    }

    const after = await runInDurableObject(stub, async (_i, state) => {
      const entries = await state.storage.list();
      return Object.fromEntries(entries.entries());
    });

    expect(after).toEqual(before);

    a.close();
    b.close();
  });
});
