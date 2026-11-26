import { SELF, env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { ServerMessage } from "@shared/protocol";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_STORED_ENTRIES = 128;
let modelRoomSeq = 0;

export function nextModelRoomCode(): string {
  modelRoomSeq++;
  let n = modelRoomSeq + 500_000;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[n % ALPHABET.length] + out;
    n = Math.floor(n / ALPHABET.length);
  }
  return out;
}

interface Waiter {
  resolve: (m: ServerMessage) => void;
  reject: (err: Error) => void;
}

export class LiveClient {
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: Waiter[] = [];
  readonly ws: WebSocket;
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const raw = String(ev.data);
      if (raw === "ping" || raw === "pong") return;
      const msg = JSON.parse(raw) as ServerMessage;
      const w = this.waiters.shift();
      if (w) w.resolve(msg);
      else this.queue.push(msg);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new Error("DO websocket closed"));
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
    if (this.closed) return Promise.reject(new Error("DO websocket closed"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
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
    for (let i = 0; i < 100; i++) {
      const m = await this.next();
      if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
    }
    throw new Error(`Expected "${t}" message`);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new Error("DO websocket closed"));
      try { this.ws.close(1000, "done"); } catch { /* ignore */ }
    }
  }
}

export interface PeerSlot {
  client: LiveClient;
  id: string;
  ip: string;
  rejoinToken: string;
  sharing: boolean;
  host: boolean;
}

export interface RoomModelState {
  code: string;
  stub: ReturnType<typeof env.ROOMS.get>;
  password: string;
  creatorToken: string;
  locked: boolean;
  expired: boolean;
  hostPromoted: boolean;
  creator: PeerSlot | null;
  guests: PeerSlot[];
  disconnectedTicket: { id: string; ip: string; rejoinToken: string; host: boolean } | null;
  stalePasswords: string[];
  kickedIps: string[];
  unbannedIps: string[];
  ipSeq: number;
}

export function activeCount(s: RoomModelState): number {
  return (s.creator ? 1 : 0) + s.guests.length;
}

export function currentHost(s: RoomModelState): PeerSlot | undefined {
  return s.creator ?? s.guests.find((g) => g.host);
}

export function recordStalePassword(s: RoomModelState, pw: string): void {
  if (!s.stalePasswords.includes(pw)) s.stalePasswords.push(pw);
}

export async function waitSocketCount(stub: ReturnType<typeof env.ROOMS.get>, expected: number): Promise<void> {
  const deadline = Date.now() + 1500;
  let lastCount = -1;
  while (Date.now() < deadline) {
    lastCount = await runInDurableObject(stub, (_i, state) => state.getWebSockets().length);
    if (lastCount === expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(lastCount).toBe(expected);
}

export async function syncGuestRotationTickets(
  guests: readonly PeerSlot[],
  alreadyConsumedId?: string,
): Promise<void> {
  for (const g of guests) {
    if (g.id === alreadyConsumedId) continue;
    const gRot = await g.client.nextOf("room-password");
    if (gRot.rejoinToken) g.rejoinToken = gRot.rejoinToken;
  }
}

export async function initModelRoom(): Promise<{
  code: string;
  stub: ReturnType<typeof env.ROOMS.get>;
  created: { code: string; password: string; hostToken: string };
}> {
  const code = nextModelRoomCode();
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const initRes = await stub.fetch("https://internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(initRes.status).toBe(200);
  const created = await initRes.json<{ code: string; password: string; hostToken: string }>();
  return { code, stub, created };
}

export async function assertRoomDoInvariants(
  stub: ReturnType<typeof env.ROOMS.get>,
  state: RoomModelState,
): Promise<void> {
  const snapshot = await runInDurableObject(stub, async (_i, doState) => {
    const sockets = doState.getWebSockets();
    let joinedCount = 0;
    let joinedHostCount = 0;
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as { joined?: boolean; host?: boolean } | null;
      if (att?.joined) {
        joinedCount += 1;
        if (att.host) joinedHostCount += 1;
      }
    }
    const [claimed, locked, members, deny, alarm, entries] = await Promise.all([
      doState.storage.get<boolean>("claimed"),
      doState.storage.get<boolean>("locked"),
      doState.storage.get<Record<string, unknown>>("members"),
      doState.storage.get<Record<string, unknown>>("deny"),
      doState.storage.getAlarm(),
      doState.storage.list(),
    ]);
    return {
      joinedCount,
      joinedHostCount,
      claimed,
      locked,
      membersCount: members ? Object.keys(members).length : 0,
      denyCount: deny ? Object.keys(deny).length : 0,
      alarm,
      storageSize: entries.size,
    };
  });

  expect(snapshot.joinedHostCount).toBeLessThanOrEqual(1);
  expect(snapshot.membersCount).toBeLessThanOrEqual(MAX_STORED_ENTRIES);
  expect(snapshot.denyCount).toBeLessThanOrEqual(MAX_STORED_ENTRIES);

  if (state.expired) {
    expect(snapshot.storageSize).toBe(0);
    expect(snapshot.alarm).toBeNull();
  } else {
    expect(snapshot.claimed).toBe(true);
    expect(snapshot.alarm).not.toBeNull();
    expect(snapshot.locked).toBe(state.locked);
    expect(snapshot.joinedCount).toBe(activeCount(state));
  }
}
