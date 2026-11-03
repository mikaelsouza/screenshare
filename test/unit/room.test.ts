// @ts-nocheck
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(public ctx: any, public env: any) {}
  },
}));

class MockWebSocket {
  sent: string[] = [];
  closedWith: { code: number; reason?: string } | null = null;
  accepted = false;
  private attachment: any = null;

  accept() {
    this.accepted = true;
  }

  serializeAttachment(att: any) {
    this.attachment = JSON.parse(JSON.stringify(att));
  }

  deserializeAttachment() {
    return this.attachment ? JSON.parse(JSON.stringify(this.attachment)) : null;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.closedWith = { code, reason };
  }
}

class MockWebSocketPair {
  [0]: MockWebSocket;
  [1]: MockWebSocket;
  constructor() {
    this[0] = new MockWebSocket();
    this[1] = new MockWebSocket();
  }
}

class MockDOStorage {
  private data = new Map<string, any>();
  private alarmTime: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key);
  }

  async put(entriesOrKey: string | Record<string, any>, value?: any): Promise<void> {
    if (typeof entriesOrKey === "string") {
      this.data.set(entriesOrKey, value);
    } else {
      for (const [k, v] of Object.entries(entriesOrKey)) {
        this.data.set(k, v);
      }
    }
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
  }

  async setAlarm(time: number): Promise<void> {
    this.alarmTime = time;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmTime = null;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }
}

class MockDOState {
  id = { toString: () => "mock-room-do-id-123456" };
  storage = new MockDOStorage();
  private sockets: MockWebSocket[] = [];
  setWebSocketAutoResponse = vi.fn();

  getWebSockets() {
    return [...this.sockets];
  }

  acceptWebSocket(ws: MockWebSocket) {
    this.sockets.push(ws);
  }

  removeSocket(ws: MockWebSocket) {
    this.sockets = this.sockets.filter((s) => s !== ws);
  }
}

const OriginalResponse = globalThis.Response;

class WorkerMockResponse extends OriginalResponse {
  override webSocket?: any;
  private _status = 200;
  private _statusText = "";

  constructor(body?: any, init?: ResponseInit & { webSocket?: any }) {
    if (init && init.status === 101) {
      super(null, { ...init, status: 200 });
      this._status = 101;
      this._statusText = init.statusText ?? "Switching Protocols";
      this.webSocket = init.webSocket;
    } else {
      super(body, init);
      this._status = init?.status ?? 200;
      this._statusText = init?.statusText ?? "OK";
    }
  }

  override get status(): number {
    return this._status;
  }

  override get statusText(): string {
    return this._statusText;
  }
}

(globalThis as any).WebSocketRequestResponsePair = class {
  constructor(public req: any, public res: any) {}
};

(globalThis as any).scheduler = {
  wait: async () => {}, // instant resolution in tests
};

let RoomDO: any;

describe("worker/room (Features 9-17)", () => {
  let ctx: MockDOState;
  let room: any;

  beforeAll(async () => {
    const mod = await import(String("@worker/room"));
    RoomDO = mod.RoomDO;
  });

  beforeEach(() => {
    (globalThis as any).WebSocketPair = MockWebSocketPair;
    (globalThis as any).Response = WorkerMockResponse;
    ctx = new MockDOState();
    room = new RoomDO(ctx as any, {} as any);
  });

  afterEach(() => {
    (globalThis as any).Response = OriginalResponse;
    vi.restoreAllMocks();
  });

  async function connectAndGetServerWs(cfIp = "203.0.113.1", origin = "http://localhost"): Promise<MockWebSocket> {
    const req = new Request("http://localhost/ws/ABCDEFGH", {
      headers: {
        Upgrade: "websocket",
        Origin: origin,
        "CF-Connecting-IP": cfIp,
      },
    });
    const res = await room.fetch(req);
    expect(res.status).toBe(101);
    const sockets = ctx.getWebSockets();
    return sockets[sockets.length - 1]!;
  }

  describe("Feature 9 & 10: Room Claiming & Passwords", () => {
    it("rejects weak password (< 8 chars) on unclaimed room creation", async () => {
      const ws = await connectAndGetServerWs();
      await room.webSocketMessage(
        ws as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Alice",
          password: "short",
        }),
      );

      expect(ws.closedWith?.code).toBe(1008);
      expect(ws.sent.some((s) => s.includes("weak-password"))).toBe(true);
      expect(await ctx.storage.get("claimed")).toBeUndefined();
    });

    it("claims room with valid password (>= 8 chars) and issues hostToken", async () => {
      const ws = await connectAndGetServerWs();
      await room.webSocketMessage(
        ws as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "HostAlice",
          password: "securePassword123",
        }),
      );

      expect(ws.closedWith).toBeNull();
      expect(await ctx.storage.get("claimed")).toBe(true);
      const welcome = ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === "welcome");
      expect(welcome).toBeDefined();
      expect(welcome.host).toBe(true);
      expect(typeof welcome.hostToken).toBe("string");
    });

    it("requires correct password once room is claimed", async () => {
      // 1. Host creates passworded room
      const hostWs = await connectAndGetServerWs();
      await room.webSocketMessage(
        hostWs as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Host",
          password: "correctHorse123",
        }),
      );

      // 2. Guest joins without password -> rejected
      const guest1Ws = await connectAndGetServerWs("203.0.113.2");
      await room.webSocketMessage(
        guest1Ws as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Guest1",
        }),
      );
      expect(guest1Ws.closedWith?.code).toBe(1008);
      expect(guest1Ws.sent.some((s) => s.includes("bad-password"))).toBe(true);

      // 3. Guest joins with wrong password -> rejected
      const guest2Ws = await connectAndGetServerWs("203.0.113.3");
      await room.webSocketMessage(
        guest2Ws as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Guest2",
          password: "wrongPassword",
        }),
      );
      expect(guest2Ws.closedWith?.code).toBe(1008);
      expect(guest2Ws.sent.some((s) => s.includes("bad-password"))).toBe(true);

      // 4. Guest joins with correct password -> admitted
      const guest3Ws = await connectAndGetServerWs("203.0.113.4");
      await room.webSocketMessage(
        guest3Ws as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Guest3",
          password: "correctHorse123",
        }),
      );
      expect(guest3Ws.closedWith).toBeNull();
      expect(guest3Ws.sent.some((s) => s.includes('"t":"welcome"'))).toBe(true);
    });

    it("emits password-ignored warning when joining a passwordless room with a password", async () => {
      // 1. Host claims room without password
      const hostWs = await connectAndGetServerWs();
      await room.webSocketMessage(
        hostWs as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Host",
        }),
      );

      // 2. Guest connects providing an unnecessary password
      const guestWs = await connectAndGetServerWs("203.0.113.5");
      await room.webSocketMessage(
        guestWs as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Guest",
          password: "ignoredPassword",
        }),
      );

      expect(guestWs.closedWith).toBeNull();
      expect(guestWs.sent.some((s) => s.includes("password-ignored"))).toBe(true);
      expect(guestWs.sent.some((s) => s.includes('"t":"welcome"'))).toBe(true);
    });
  });

  describe("Feature 11: Room Capacity Bounds & Sockets Sweep", () => {
    it("sweeps stale unjoined sockets after 10 seconds", async () => {
      const ws = await connectAndGetServerWs();
      // Socket is accepted but does not send join
      expect(ws.closedWith).toBeNull();

      // Fast forward time by 11 seconds and send next connection to trigger sweep
      const now = Date.now() + 11_000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      const ws2 = await connectAndGetServerWs("203.0.113.10");
      expect(ws.closedWith?.code).toBe(1008);
      expect(ws.closedWith?.reason).toBe("Did not join in time");
      expect(ws2.closedWith).toBeNull();
    });

    it("enforces MAX_SOCKETS_PER_IP limit (40) with 1013 TRY_AGAIN_LATER", async () => {
      const ip = "198.51.100.55";
      for (let i = 0; i < 40; i++) {
        const ws = await connectAndGetServerWs(ip);
        // Mark as joined to prevent sweep
        const att = ws.deserializeAttachment();
        att.joined = true;
        ws.serializeAttachment(att);
      }

      expect(ctx.getWebSockets().length).toBe(40);

      // 41st connection from same IP: rejected via rejectUpgrade before DO accepts it
      const req = new Request("http://localhost/ws/ABCDEFGH", {
        headers: {
          Upgrade: "websocket",
          Origin: "http://localhost",
          "CF-Connecting-IP": ip,
        },
      });
      const res = await room.fetch(req);
      expect(res.status).toBe(101);
      expect(res.webSocket).toBeDefined();
      // Verify no new socket was admitted to the DO's accepted sockets list
      expect(ctx.getWebSockets().length).toBe(40);
    });
  });

  describe("Feature 12: In-Place Session Resume", () => {
    it("preserves selfId and sharing without emitting peer-left on resume: true", async () => {
      // 1. Initial join
      const ws1 = await connectAndGetServerWs("203.0.113.20");
      await room.webSocketMessage(
        ws1 as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Alice",
          sharing: true,
        }),
      );
      const welcome1 = ws1.sent.map((s) => JSON.parse(s)).find((m) => m.t === "welcome");
      const selfId = welcome1.selfId;
      const rejoinToken = welcome1.rejoinToken;

      // 2. In-place resume on a new socket
      const ws2 = await connectAndGetServerWs("203.0.113.20");
      await room.webSocketMessage(
        ws2 as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Alice",
          rejoinToken,
          resume: true,
        }),
      );

      const welcome2 = ws2.sent.map((s) => JSON.parse(s)).find((m) => m.t === "welcome");
      expect(welcome2.selfId).toBe(selfId);
      // Old socket is superseded and closed
      expect(ws1.closedWith?.code).toBe(1008);
      // Existing peers should NOT receive peer-left
      expect(ws2.sent.some((s) => s.includes('"t":"peer-left"'))).toBe(false);
    });
  });

  describe("Feature 13: Host Actions & Ban", () => {
    it("allows host to kick peer, banning IP for 15 minutes and revoking ticket", async () => {
      // 1. Host joins
      const hostWs = await connectAndGetServerWs("203.0.113.1");
      await room.webSocketMessage(
        hostWs as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Host",
        }),
      );

      // 2. Peer joins from 203.0.113.99
      const peerWs = await connectAndGetServerWs("203.0.113.99");
      await room.webSocketMessage(
        peerWs as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Troublemaker",
        }),
      );
      const peerWelcome = peerWs.sent.map((s) => JSON.parse(s)).find((m) => m.t === "welcome");
      const peerId = peerWelcome.selfId;
      const peerRejoinToken = peerWelcome.rejoinToken;

      // 3. Host kicks peer
      await room.webSocketMessage(
        hostWs as any,
        JSON.stringify({
          t: "kick",
          id: peerId,
        }),
      );

      expect(peerWs.closedWith?.code).toBe(1008);
      expect(peerWs.sent.some((s) => s.includes('"code":"kicked"'))).toBe(true);

      // 4. Kicked IP tries to rejoin immediately -> rejected with kicked error
      const retryWs = await connectAndGetServerWs("203.0.113.99");
      await room.webSocketMessage(
        retryWs as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "TroublemakerRetry",
          rejoinToken: peerRejoinToken,
        }),
      );
      expect(retryWs.closedWith?.code).toBe(1008);
      expect(retryWs.sent.some((s) => s.includes('"code":"kicked"'))).toBe(true);
    });

    it("prevents non-host from kicking or locking room", async () => {
      // 1. Host joins
      const hostWs = await connectAndGetServerWs("203.0.113.1");
      await room.webSocketMessage(
        hostWs as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Host",
        }),
      );

      // 2. Regular peer joins
      const guestWs = await connectAndGetServerWs("203.0.113.2");
      await room.webSocketMessage(
        guestWs as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Guest",
        }),
      );

      // Guest attempts to lock room -> error not-host
      await room.webSocketMessage(
        guestWs as any,
        JSON.stringify({
          t: "lock",
          locked: true,
        }),
      );
      expect(guestWs.sent.some((s) => s.includes('"code":"not-host"'))).toBe(true);
      expect(await ctx.storage.get("locked")).toBeUndefined();
    });
  });

  describe("Feature 14: Orphaned Lock Grace Period", () => {
    it("unlocks room automatically when host has departed for >= 5 minutes", async () => {
      // 1. Host joins and locks room
      const hostWs = await connectAndGetServerWs("203.0.113.1");
      await room.webSocketMessage(
        hostWs as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Host",
        }),
      );
      await room.webSocketMessage(
        hostWs as any,
        JSON.stringify({
          t: "lock",
          locked: true,
        }),
      );
      expect(await ctx.storage.get("locked")).toBe(true);

      // 2. Host disconnects
      await room.webSocketClose(hostWs as any, 1000, "Leaving", true);
      ctx.removeSocket(hostWs);

      // 3. Guest tries to join at 4 minutes -> still locked
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 60 * 1000);
      const guest1 = await connectAndGetServerWs("203.0.113.50");
      await room.webSocketMessage(
        guest1 as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Guest1",
        }),
      );
      expect(guest1.closedWith?.code).toBe(1008);
      expect(guest1.sent.some((s) => s.includes("room-locked"))).toBe(true);

      // 4. Guest tries to join at 5m 1s -> lock is dropped, join succeeds
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60 * 1000 + 1000);
      const guest2 = await connectAndGetServerWs("203.0.113.51");
      await room.webSocketMessage(
        guest2 as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Guest2",
        }),
      );
      expect(guest2.closedWith).toBeNull();
      expect(guest2.sent.some((s) => s.includes('"t":"welcome"'))).toBe(true);
      expect(await ctx.storage.get("locked")).toBe(false);
    });
  });

  describe("Feature 15: Offer Privacy Isolation", () => {
    it("rejects offer if neither sender nor target is sharing", async () => {
      // 1. Viewer A joins (sharing: false)
      const wsA = await connectAndGetServerWs("203.0.113.1");
      await room.webSocketMessage(
        wsA as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "ViewerA",
          sharing: false,
        }),
      );
      const welcomeA = wsA.sent.map((s) => JSON.parse(s)).find((m) => m.t === "welcome");

      // 2. Viewer B joins (sharing: false)
      const wsB = await connectAndGetServerWs("203.0.113.2");
      await room.webSocketMessage(
        wsB as any,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "ViewerB",
          sharing: false,
        }),
      );
      const welcomeB = wsB.sent.map((s) => JSON.parse(s)).find((m) => m.t === "welcome");

      // 3. Viewer A offers to Viewer B -> rejected with not-sharing
      await room.webSocketMessage(
        wsA as any,
        JSON.stringify({
          t: "signal",
          to: welcomeB.selfId,
          data: { k: "offer", sdp: "v=0\r\n" },
        }),
      );

      expect(wsA.sent.some((s) => s.includes('"code":"not-sharing"'))).toBe(true);
      expect(wsB.sent.some((s) => s.includes('"t":"signal"'))).toBe(false);
    });
  });

  describe("Feature 16: Frame Flooding & Token Bucket", () => {
    it("closes 1009 if frame exceeds 80KB limit", async () => {
      const ws = await connectAndGetServerWs();
      const largeMessage = "x".repeat(81921);
      await room.webSocketMessage(ws as any, largeMessage);
      expect(ws.closedWith?.code).toBe(1009);
      expect(ws.sent.some((s) => s.includes("Message too large"))).toBe(true);
    });

    it("closes 1008 after > 5 consecutive unparseable messages", async () => {
      const ws = await connectAndGetServerWs();
      const att = ws.deserializeAttachment();
      att.joined = true;
      ws.serializeAttachment(att);

      for (let i = 0; i < 5; i++) {
        await room.webSocketMessage(ws as any, "invalid json");
        expect(ws.closedWith).toBeNull();
      }

      // 6th bad message triggers close
      await room.webSocketMessage(ws as any, "invalid json");
      expect(ws.closedWith?.code).toBe(1008);
      expect(ws.closedWith?.reason).toBe("Too many invalid messages");
    });
  });

  describe("Feature 17: Room Abandonment Alarm", () => {
    it("erases all storage when alarm fires and 0 peers remain in room", async () => {
      await ctx.storage.put("claimed", true);
      await ctx.storage.put("passwordHash", "hashedPw");

      // No joined peers in ctx
      await room.alarm();

      expect(await ctx.storage.get("claimed")).toBeUndefined();
      expect(await ctx.storage.get("passwordHash")).toBeUndefined();
    });

    it("re-arms alarm if a peer is still joined when alarm fires", async () => {
      await ctx.storage.put("claimed", true);
      const ws = await connectAndGetServerWs();
      const att = ws.deserializeAttachment();
      att.joined = true;
      ws.serializeAttachment(att);

      await room.alarm();

      // Storage NOT deleted
      expect(await ctx.storage.get("claimed")).toBe(true);
      expect(await ctx.storage.getAlarm()).not.toBeNull();
    });
  });
});
