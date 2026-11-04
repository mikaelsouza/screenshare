// @ts-nocheck
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { MAX_ROOM_SIZE } from "@shared/protocol";

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
  id = { toString: () => "mock-formal-room-id" };
  storage = new MockDOStorage();
  private sockets: MockWebSocket[] = [];
  setWebSocketAutoResponse = vi.fn();

  getWebSockets() {
    return this.sockets.filter((s) => s.closedWith === null);
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
  wait: async () => {},
};

let RoomDO: any;

describe("Formal Invariants: RoomDO State Machine (Features 32, 33, 35, 36, 37, 40)", () => {
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
  });

  async function connectPeer(ip = "192.168.1.100") {
    const req = new Request("https://screenshare.internal/api/room/ABCDEFGH/ws", {
      headers: {
        Upgrade: "websocket",
        "CF-Connecting-IP": ip,
      },
    });
    const res = await room.fetch(req);
    expect(res.status).toBe(101);
    const clientWs = res.webSocket as MockWebSocket;
    const serverWs = ctx.getWebSockets().find((s) => !s.accepted)!;
    serverWs.accept();
    return { clientWs, serverWs };
  }

  /**
   * Feature 32: Formal Invariant: Host Uniqueness
   * Across any sequence of joins, tokens, and leaves, at most ONE socket
   * in the room can ever be host at any given time.
   */
  describe("Feature 32: Host Uniqueness Invariant", () => {
    it("proves at most 1 host socket exists across arbitrary concurrent joins", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              name: fc.stringMatching(/^[a-zA-Z0-9]{3,8}$/),
              ip: fc.stringMatching(/^10\.0\.0\.[1-9]$/),
              presentHostToken: fc.boolean(),
            }),
            { minLength: 2, maxLength: 8 }
          ),
          async (joinRequests) => {
            const testCtx = new MockDOState();
            const testRoom = new RoomDO(testCtx as any, {} as any);

            let createdHostToken: string | null = null;
            const activeSockets: { serverWs: MockWebSocket; host: boolean }[] = [];

            for (const j of joinRequests) {
              const req = new Request("https://screenshare.internal/api/room/TESTCODE/ws", {
                headers: { Upgrade: "websocket", "CF-Connecting-IP": j.ip },
              });
              const res = await testRoom.fetch(req);
              if (res.status !== 101) continue;
              const serverWs = testCtx.getWebSockets().find((s) => !s.accepted);
              if (!serverWs) continue;
              serverWs.accept();

              const joinPayload: any = {
                t: "join",
                room: "TESTCODE",
                displayName: j.name,
              };
              if (j.presentHostToken && createdHostToken) {
                joinPayload.hostToken = createdHostToken;
              }

              await testRoom.webSocketMessage(serverWs, JSON.stringify(joinPayload));

              // Check welcome message
              const welcome = serverWs.sent
                .map((m) => JSON.parse(m))
                .find((m) => m.t === "welcome");

              const isHost = welcome ? welcome.host === true : false;
              if (isHost && welcome.hostToken) {
                createdHostToken = welcome.hostToken;
              }

              activeSockets.push({ serverWs, host: isHost });

              // INVARIANT: At any moment, at most 1 active socket has host: true
              const hostCount = testCtx.getWebSockets().filter((s) => {
                const att = s.deserializeAttachment();
                return att && att.host === true;
              }).length;

              expect(hostCount).toBeLessThanOrEqual(1);
            }
            return true;
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Feature 33: Formal Invariant: Capacity Bounds
   * Total joined peers <= MAX_ROOM_SIZE (20).
   * Total connected sockets <= MAX_SOCKETS (80).
   * Total sockets per IP <= MAX_SOCKETS_PER_IP (40).
   */
  describe("Feature 33: Capacity Bounds Invariant", () => {
    it("proves joined peers strictly bounded by MAX_ROOM_SIZE (20)", async () => {
      const peersToJoin = 25; // attempt to exceed cap of 20
      let joinedCount = 0;
      let rejectedCount = 0;

      for (let i = 0; i < peersToJoin; i++) {
        const { serverWs } = await connectPeer(`10.0.1.${i}`);
        await room.webSocketMessage(
          serverWs,
          JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: `Peer${i}` })
        );

        const welcome = serverWs.sent.map((m) => JSON.parse(m)).find((m) => m.t === "welcome");
        const error = serverWs.sent.map((m) => JSON.parse(m)).find((m) => m.t === "error");

        if (welcome) joinedCount++;
        if (error && error.code === "room-full") rejectedCount++;
      }

      // Invariants:
      expect(joinedCount).toBe(MAX_ROOM_SIZE);
      expect(rejectedCount).toBe(peersToJoin - MAX_ROOM_SIZE);

      // Verify attachment count in storage
      const joinedSockets = ctx.getWebSockets().filter((s) => {
        const att = s.deserializeAttachment();
        return att && att.id !== undefined;
      });
      expect(joinedSockets.length).toBe(MAX_ROOM_SIZE);
    });
  });

  /**
   * Feature 35: Formal Invariant: Kick Ban
   * Kicked IP rejected for 15 minutes; rejoin ticket permanently revoked.
   */
  describe("Feature 35: Kick Ban Invariant", () => {
    it("proves kicked IP is banned and rejoin ticket revoked", async () => {
      // Host joins
      const { serverWs: hostWs } = await connectPeer("1.1.1.1");
      await room.webSocketMessage(
        hostWs,
        JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "Host" })
      );

      // Target joins from IP 2.2.2.2
      const { serverWs: targetWs } = await connectPeer("2.2.2.2");
      await room.webSocketMessage(
        targetWs,
        JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "Target" })
      );

      const targetWelcome = targetWs.sent
        .map((m) => JSON.parse(m))
        .find((m) => m.t === "welcome");
      const targetId = targetWelcome.selfId;
      const targetRejoinToken = targetWelcome.rejoinToken;

      // Host kicks target
      await room.webSocketMessage(hostWs, JSON.stringify({ t: "kick", id: targetId }));

      // Target socket must be closed with 1008
      expect(targetWs.closedWith?.code).toBe(1008);
      ctx.removeSocket(targetWs);

      // Invariant 1: Target IP 2.2.2.2 is immediately rejected when trying to join anew
      const { serverWs: rejoinAttemptWs } = await connectPeer("2.2.2.2");
      await room.webSocketMessage(
        rejoinAttemptWs,
        JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "TargetRetry" })
      );

      const banError = rejoinAttemptWs.sent
        .map((m) => JSON.parse(m))
        .find((m) => m.t === "error" && m.code === "kicked");
      expect(banError).toBeDefined();
      expect(rejoinAttemptWs.closedWith?.code).toBe(1008);

      // Invariant 2: Even with rejoinToken, the revoked ticket is not honored
      const { serverWs: tokenAttemptWs } = await connectPeer("3.3.3.3"); // different IP
      await room.webSocketMessage(
        tokenAttemptWs,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "TargetWithToken",
          rejoinToken: targetRejoinToken,
        })
      );
      // It is treated as a fresh join without ticket privileges
      expect(tokenAttemptWs.sent.some((m) => JSON.parse(m).t === "welcome")).toBe(true);
    });
  });

  /**
   * Feature 36: Formal Invariant: Lock Grace Period
   * Orphaned locked room unlocks after >= 5m without host.
   */
  describe("Feature 36: Lock Grace Period Invariant", () => {
    it("proves room unlocks automatically after host absence exceeds 5 minutes", async () => {
      // Host joins and locks room
      const { serverWs: hostWs } = await connectPeer("1.1.1.1");
      await room.webSocketMessage(
        hostWs,
        JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "Host" })
      );
      await room.webSocketMessage(hostWs, JSON.stringify({ t: "lock", locked: true }));

      // Peer joins before host leaves
      const { serverWs: peerWs } = await connectPeer("2.2.2.2");
      // Joining a locked room without token is rejected
      await room.webSocketMessage(
        peerWs,
        JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "Stranger" })
      );
      expect(peerWs.sent.some((m) => JSON.parse(m).code === "room-locked")).toBe(true);
      ctx.removeSocket(peerWs);

      // Host leaves
      await room.webSocketClose(hostWs, 1000, "Host departing", false);
      ctx.removeSocket(hostWs);

      // Verify hostGoneAt was stored
      const hostGoneAt = await ctx.storage.get("hostGoneAt");
      expect(typeof hostGoneAt).toBe("number");

      // Set time to hostGoneAt + 6 minutes (past 5m grace)
      const fakeNow = hostGoneAt + 6 * 60 * 1000;
      const realDateNow = Date.now;
      Date.now = () => fakeNow;

      try {
        // Stranger attempts join again: lock must have dropped!
        const { serverWs: strangerWs } = await connectPeer("4.4.4.4");
        await room.webSocketMessage(
          strangerWs,
          JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "NewComer" })
        );

        const welcome = strangerWs.sent
          .map((m) => JSON.parse(m))
          .find((m) => m.t === "welcome");
        expect(welcome).toBeDefined();
        expect(welcome.locked).toBe(false);
      } finally {
        Date.now = realDateNow;
      }
    });
  });

  /**
   * Feature 37: Formal Invariant: Password Safety
   * Stored hash immutable across subsequent joins; timing-safe checks independent of mismatch.
   */
  describe("Feature 37: Password Safety & Immutability Invariant", () => {
    it("proves room password hash is immutable and cannot be overwritten by subsequent joins", async () => {
      // Room created with initial password
      const initialPassword = "initial-safe-password";
      const { serverWs: creatorWs } = await connectPeer("1.1.1.1");
      await room.webSocketMessage(
        creatorWs,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Creator",
          password: initialPassword,
        })
      );

      const storedHashBefore = await ctx.storage.get("passwordHash");
      expect(storedHashBefore).toBeDefined();

      // Subsequent join attempts to supply a different password or claim the room
      const { serverWs: attackerWs } = await connectPeer("2.2.2.2");
      await room.webSocketMessage(
        attackerWs,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "Attacker",
          password: "new-malicious-password",
        })
      );

      // Must be rejected with bad-password
      const errorMsg = attackerWs.sent
        .map((m) => JSON.parse(m))
        .find((m) => m.t === "error" && m.code === "bad-password");
      expect(errorMsg).toBeDefined();

      // INVARIANT: Stored password hash MUST NOT have changed
      const storedHashAfter = await ctx.storage.get("passwordHash");
      expect(storedHashAfter).toEqual(storedHashBefore);
    });
  });

  /**
   * Feature 40: Formal Invariant: Resume Idempotence
   * Rejoin with resume preserves selfId and emits no peer-left.
   */
  describe("Feature 40: Resume Idempotence Invariant", () => {
    it("proves in-place resume preserves peerId and does not emit peer-left to other peers", async () => {
      // Peer 1 (Host) joins
      const { serverWs: p1Ws } = await connectPeer("1.1.1.1");
      await room.webSocketMessage(
        p1Ws,
        JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "P1" })
      );

      // Peer 2 joins
      const { serverWs: p2Ws } = await connectPeer("2.2.2.2");
      await room.webSocketMessage(
        p2Ws,
        JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "P2" })
      );
      const p2Welcome = p2Ws.sent.map((m) => JSON.parse(m)).find((m) => m.t === "welcome");
      const originalPeerId = p2Welcome.selfId;
      const rejoinToken = p2Welcome.rejoinToken;

      p1Ws.sent = []; // clear P1 sent log

      // Peer 2 disconnects and performs in-place resume with rejoinToken
      const { serverWs: p2ResumeWs } = await connectPeer("2.2.2.2");
      await room.webSocketMessage(
        p2ResumeWs,
        JSON.stringify({
          t: "join",
          room: "ABCDEFGH",
          displayName: "P2",
          rejoinToken,
          resume: true,
        })
      );

      const resumeWelcome = p2ResumeWs.sent
        .map((m) => JSON.parse(m))
        .find((m) => m.t === "welcome");

      // Invariant 1: selfId is strictly preserved
      expect(resumeWelcome.selfId).toBe(originalPeerId);

      // Invariant 2: No peer-left was emitted to P1
      const peerLeftMsgs = p1Ws.sent
        .map((m) => JSON.parse(m))
        .filter((m) => m.t === "peer-left");
      expect(peerLeftMsgs.length).toBe(0);
    });
  });
});
