import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalingClient } from "@src/signaling";

/** Records every socket the client opens, so reconnect behaviour is observable. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }

  open(): void { this.onopen?.(); }
  /** Simulate the server closing with a given code. */
  serverClose(code: number): void { this.readyState = 3; this.onclose?.({ code }); }
}

const handlers = () => ({
  onWelcome: vi.fn(), onPeerJoined: vi.fn(), onPeerLeft: vi.fn(),
  onSignal: vi.fn(), onPeerState: vi.fn(), onError: vi.fn(), onStatus: vi.fn(),
});

describe("SignalingClient reconnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "https:", host: "example.com" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects and joins on open", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe("wss://example.com/ws/ABCDEFGH");
    ws.open();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ t: "join", room: "ABCDEFGH", displayName: "alice" });
  });

  it("reconnects after a transient close", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.serverClose(1006); // abnormal / network blip
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
  });

  // Regression: the client reconnected on every close, including the fatal 1008 the
  // Durable Object sends for a full room — an unbounded reconnect/rejoin/reject loop,
  // each cycle a billable Worker request plus a DO wake-up.
  it("does not reconnect after a fatal 1008 close", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.serverClose(1008); // room-full / bad-room-code

    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("stays down after 1008 even if connect() is called again", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.serverClose(1008);
    c.connect();
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("does not reconnect when the client closed deliberately", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    FakeWebSocket.instances[0]!.open();
    c.close();
    FakeWebSocket.instances[0]!.serverClose(1000);
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("reports the room-full error to the UI before giving up", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ t: "error", code: "room-full", message: "Room is full" }) });
    ws.serverClose(1008);
    expect(h.onError).toHaveBeenCalledWith("room-full", "Room is full");
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("dispatches all incoming server messages to their respective handlers", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();

    // welcome
    ws.onmessage?.({
      data: JSON.stringify({
        t: "welcome",
        selfId: "me",
        peers: [{ id: "p1", name: "bob", sharing: false }],
        iceServers: [{ urls: "stun:example.com" }],
      }),
    });
    expect(h.onWelcome).toHaveBeenCalledWith("me", [{ id: "p1", name: "bob", sharing: false }], [{ urls: "stun:example.com" }]);

    // peer-joined
    ws.onmessage?.({
      data: JSON.stringify({ t: "peer-joined", peer: { id: "p2", name: "charlie", sharing: true } }),
    });
    expect(h.onPeerJoined).toHaveBeenCalledWith({ id: "p2", name: "charlie", sharing: true });

    // peer-left
    ws.onmessage?.({
      data: JSON.stringify({ t: "peer-left", id: "p2" }),
    });
    expect(h.onPeerLeft).toHaveBeenCalledWith("p2");

    // signal
    ws.onmessage?.({
      data: JSON.stringify({ t: "signal", from: "p1", data: { k: "offer", sdp: "v=0" } }),
    });
    expect(h.onSignal).toHaveBeenCalledWith("p1", { k: "offer", sdp: "v=0" });

    // peer-state
    ws.onmessage?.({
      data: JSON.stringify({ t: "peer-state", id: "p1", sharing: true }),
    });
    expect(h.onPeerState).toHaveBeenCalledWith("p1", true);

    // ping and pong are ignored
    ws.onmessage?.({ data: "ping" });
    ws.onmessage?.({ data: "pong" });

    // unparseable message is ignored without throwing
    ws.onmessage?.({ data: "not json" });
    ws.onerror?.();
  });

  it("sends signals and state updates", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers(), "my-password");
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();

    expect(JSON.parse(ws.sent[0]!)).toEqual({
      t: "join",
      room: "ABCDEFGH",
      displayName: "alice",
      password: "my-password",
    });

    c.signal("p1", { k: "answer", sdp: "v=0" });
    expect(JSON.parse(ws.sent[1]!)).toEqual({
      t: "signal",
      to: "p1",
      data: { k: "answer", sdp: "v=0" },
    });

    c.setSharing(true);
    expect(JSON.parse(ws.sent[2]!)).toEqual({
      t: "state",
      sharing: true,
    });
  });

  it("sends pings every 30 seconds when open", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();

    vi.advanceTimersByTime(30_000);
    expect(ws.sent).toContain("ping");

    c.close();
  });

  it("uses ws: protocol when running on http:", () => {
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:8787" });
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe("ws://localhost:8787/ws/ABCDEFGH");
    c.close();
  });

  it("safely handles send when socket is not open", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    // Not connected yet
    expect(() => c.send({ t: "state", sharing: false })).not.toThrow();
  });

  it("defaults to empty array when welcome message omits iceServers", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.onmessage?.({
      data: JSON.stringify({
        t: "welcome",
        selfId: "p1",
        peers: [],
      }),
    });
    expect(h.onWelcome).toHaveBeenCalledWith("p1", [], []);
    c.close();
  });
});

describe("SignalingClient capacity refusals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "https:", host: "example.com" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a 1013 refusal rather than treating it as terminal", () => {
    // Capacity is transient — usually a half-open socket the runtime has not reaped —
    // so a client refused for it must come back. 1008 would strand a user who did
    // nothing wrong, and a failed handshake (1006) would retry forever with no reason
    // ever shown.
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    FakeWebSocket.instances[0]!.serverClose(1013);
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it("gives up after repeated 1013s, and says why", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    for (let i = 0; i < 6; i++) {
      FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.serverClose(1013);
      vi.advanceTimersByTime(30_000);
    }
    const opened = FakeWebSocket.instances.length;
    expect(h.onError).toHaveBeenCalledWith("rate-limited", expect.stringContaining("capacity"));

    // And it stays given up: no further sockets after the last refusal.
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances.length).toBe(opened);
  });

  it("forgets earlier refusals once a connection succeeds", () => {
    // Otherwise a long-lived session that hit capacity a few times over an evening
    // would eventually refuse to reconnect at all.
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    for (let i = 0; i < 4; i++) {
      FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.serverClose(1013);
      vi.advanceTimersByTime(30_000);
    }
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.open();

    // With the counter reset, four more refusals must each still produce a reconnect.
    // Without the reset the fifth cumulative refusal would have tripped the limit.
    const afterOpen = FakeWebSocket.instances.length;
    for (let i = 0; i < 4; i++) {
      FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.serverClose(1013);
      vi.advanceTimersByTime(30_000);
    }
    expect(FakeWebSocket.instances.length).toBe(afterOpen + 4);
  });
});
