import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@shared/protocol";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
let modelRoomSeq = 0;

function nextModelRoomCode(): string {
  modelRoomSeq++;
  let n = modelRoomSeq + 500_000;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[n % ALPHABET.length] + out;
    n = Math.floor(n / ALPHABET.length);
  }
  return out;
}

class LiveClient {
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: Array<(m: ServerMessage) => void> = [];
  readonly ws: WebSocket;
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const raw = String(ev.data);
      if (raw === "ping" || raw === "pong") return;
      const msg = JSON.parse(raw) as ServerMessage;
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  static async connect(code: string, ip: string): Promise<LiveClient> {
    const res = await SELF.fetch(`https://example.com/ws/${code}`, {
      headers: { Upgrade: "websocket", Origin: "https://example.com", "CF-Connecting-IP": ip },
    });
    if (!res.webSocket) throw new Error(`Expected websocket, got ${res.status}`);
    res.webSocket.accept();
    return new LiveClient(res.webSocket);
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(timeoutMs = 2000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = (m: ServerMessage): void => {
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error("timed out waiting for DO message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async nextOf<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    for (let i = 0; i < 12; i++) {
      const m = await this.next();
      if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
    }
    throw new Error(`Expected "${t}" message`);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      try { this.ws.close(1000, "done"); } catch { /* ignore */ }
    }
  }
}

interface PeerSlot {
  client: LiveClient;
  id: string;
  ip: string;
  rejoinToken: string;
  sharing: boolean;
  host: boolean;
}

interface RoomModelState {
  code: string;
  stub: ReturnType<typeof env.ROOMS.get>;
  password: string;
  creatorToken: string;
  locked: boolean;
  expired: boolean;
  creator: PeerSlot | null;
  guests: PeerSlot[];
  disconnectedTicket: { id: string; ip: string; rejoinToken: string; host: boolean } | null;
  ipSeq: number;
}

async function waitSocketCount(stub: ReturnType<typeof env.ROOMS.get>, expected: number): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const count = await runInDurableObject(stub, (_i, state) => state.getWebSockets().length);
    if (count === expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function activeCount(s: RoomModelState): number {
  return (s.creator ? 1 : 0) + s.guests.length;
}

describe("RoomDO stateful model (real workerd execution)", () => {
  it("preserves host authority, partial-mesh relay, lock/rotation, and 15m/90d lifecycle invariants", async () => {
    const opsArb = fc.array(
      fc.oneof(
        fc.constant({ kind: "join-creator" } as const),
        fc.constant({ kind: "join-guest" } as const),
        fc.constant({ kind: "disconnect-creator" } as const),
        fc.constant({ kind: "disconnect-guest" } as const),
        fc.constant({ kind: "resume-ticket" } as const),
        fc.constant({ kind: "toggle-lock" } as const),
        fc.constant({ kind: "rotate-password" } as const),
        fc.constant({ kind: "kick-guest" } as const),
        fc.constant({ kind: "relay-check" } as const),
        fc.constantFrom(
          { kind: "alarm", ageMs: 6 * 60_000 } as const,
          { kind: "alarm", ageMs: 16 * 60_000 } as const,
          { kind: "alarm", ageMs: 91 * 86_400_000 } as const,
        ),
      ),
      { minLength: 4, maxLength: 14 },
    );

    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        const code = nextModelRoomCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const initRes = await stub.fetch("https://internal/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        expect(initRes.status).toBe(200);
        const created = await initRes.json<{ code: string; password: string; hostToken: string }>();

        const state: RoomModelState = {
          code,
          stub,
          password: created.password,
          creatorToken: created.hostToken,
          locked: false,
          expired: false,
          creator: null,
          guests: [],
          disconnectedTicket: null,
          ipSeq: 1,
        };

        try {
          for (const op of ops) {
            if (state.expired) break;
            if (op.kind === "join-creator" && !state.creator) {
              const ip = `198.51.101.${state.ipSeq++}`;
              const c = await LiveClient.connect(code, ip);
              c.send({ t: "join", room: code, displayName: "creator", hostToken: state.creatorToken });
              const w = await c.nextOf("welcome");
              expect(w.host).toBe(true);
              if (w.password) state.password = w.password;
              for (const g of state.guests) {
                if (g.host) g.client.close();
              }
              state.guests = state.guests.filter((g) => !g.host);
              if (state.disconnectedTicket?.host) state.disconnectedTicket = null;
              state.creator = {
                client: c,
                id: w.selfId,
                ip,
                rejoinToken: w.rejoinToken ?? "",
                sharing: false,
                host: true,
              };
            } else if (op.kind === "join-guest" && state.guests.length < 3) {
              const ip = `198.51.101.${state.ipSeq++}`;
              const c = await LiveClient.connect(code, ip);
              c.send({ t: "join", room: code, displayName: "guest", password: state.password });
              if (state.locked) {
                expect((await c.nextOf("error")).code).toBe("room-locked");
                c.close();
              } else {
                const w = await c.nextOf("welcome");
                expect(w.host).toBe(false);
                state.guests.push({
                  client: c,
                  id: w.selfId,
                  ip,
                  rejoinToken: w.rejoinToken ?? "",
                  sharing: false,
                  host: false,
                });
              }
            } else if (op.kind === "disconnect-creator" && state.creator) {
              state.creator.client.close();
              state.creator = null;
              await waitSocketCount(stub, activeCount(state));
            } else if (op.kind === "disconnect-guest" && state.guests.length > 0) {
              const g = state.guests.shift()!;
              state.disconnectedTicket = { id: g.id, ip: g.ip, rejoinToken: g.rejoinToken, host: g.host };
              g.client.close();
              await waitSocketCount(stub, activeCount(state));
            } else if (op.kind === "resume-ticket" && state.disconnectedTicket) {
              const ticket = state.disconnectedTicket;
              state.disconnectedTicket = null;
              const c = await LiveClient.connect(code, ticket.ip);
              c.send({ t: "join", room: code, displayName: "guest-resumed", rejoinToken: ticket.rejoinToken, resume: true });
              const w = await c.nextOf("welcome");
              expect(w.selfId).toBe(ticket.id);
              state.guests.push({
                client: c,
                id: w.selfId,
                ip: ticket.ip,
                rejoinToken: w.rejoinToken ?? "",
                sharing: false,
                host: w.host,
              });
            } else if (op.kind === "toggle-lock" && state.creator) {
              const nextLocked = !state.locked;
              state.creator.client.send({ t: "lock", locked: nextLocked });
              const msg = await state.creator.client.nextOf("room-state");
              expect(msg.locked).toBe(nextLocked);
              state.locked = nextLocked;
            } else if (op.kind === "rotate-password" && state.creator) {
              state.creator.client.send({ t: "rotate-password" });
              const rot = await state.creator.client.nextOf("room-password");
              if (rot.password) state.password = rot.password;
              state.disconnectedTicket = null;
            } else if (op.kind === "kick-guest" && state.creator && state.guests.length > 0) {
              const target = state.guests.shift()!;
              state.creator.client.send({ t: "kick", id: target.id });
              expect((await target.client.nextOf("error")).code).toBe("kicked");
              target.client.close();
              const rot = await state.creator.client.nextOf("room-password");
              if (rot.password) state.password = rot.password;
              state.disconnectedTicket = null;
              await waitSocketCount(stub, activeCount(state));
            } else if (op.kind === "relay-check" && state.creator && state.guests.length > 0) {
              const guest = state.guests[0]!;
              guest.client.send({ t: "signal", to: state.creator.id, data: { k: "offer", sdp: "v=0\r\n" } });
              expect(["not-sharing", "relay-denied"]).toContain((await guest.client.nextOf("error")).code);
            } else if (op.kind === "alarm") {
              const empty = activeCount(state) === 0;
              const wasHostlessOccupied = !empty && !state.creator && !state.guests.some((g) => g.host);
              await runInDurableObject(stub, async (_i, storageObj) => {
                const s = storageObj.storage;
                if (op.ageMs >= 91 * 86_400_000) {
                  await s.put("lastHostActiveAt", Date.now() - op.ageMs);
                  if (empty) await s.put("emptySince", Date.now() - op.ageMs);
                } else if (empty) {
                  await s.put("emptySince", Date.now() - op.ageMs);
                } else if (wasHostlessOccupied) {
                  await s.put("hostGoneAt", Date.now() - op.ageMs);
                }
              });
              await runDurableObjectAlarm(stub);
              if (op.ageMs >= 91 * 86_400_000 && !state.creator) {
                expect(await runInDurableObject(stub, async (_i, s) => (await s.storage.list()).size)).toBe(0);
                state.expired = true;
                for (const g of state.guests) g.client.close();
                state.guests = [];
              } else if (wasHostlessOccupied && op.ageMs >= 5 * 60_000 && state.guests[0]) {
                const promo = await state.guests[0].client.nextOf("host-promoted");
                expect(promo.hostId).toBe(state.guests[0].id);
                state.guests[0].host = true;
              } else if (empty && op.ageMs >= 16 * 60_000) {
                state.disconnectedTicket = null;
                state.locked = false;
                const persistedPw = await runInDurableObject(stub, (_i, s) => s.storage.get<string>("roomPassword"));
                if (persistedPw) state.password = persistedPw;
              }
            }
          }
        } finally {
          state.creator?.client.close();
          for (const g of state.guests) g.client.close();
          await waitSocketCount(stub, 0);
        }
      }),
      { numRuns: 15 },
    );
  }, 15_000);
});
