import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalingClient } from "@src/signaling";

/** Records every socket the client opens, so reconnect behaviour is observable. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
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
  // Durable Object sends for a full room â€” an unbounded reconnect/rejoin/reject loop,
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
      }),
    });
    expect(h.onWelcome).toHaveBeenCalledWith("me", [{ id: "p1", name: "bob", sharing: false }], {
      host: false,
      locked: false,
    });

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

  it("closes and detaches prior socket when connect() is called again", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();
    expect(ws1.readyState).toBe(1);

    const oldMsgHandler = ws1.onmessage;
    const oldCloseHandler = ws1.onclose;

    // Call connect() again while ws1 is open
    c.connect();
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(ws1.readyState).toBe(3); // closed by detachSocket
    expect(ws1.onmessage).toBeNull();
    expect(ws1.onclose).toBeNull();

    // Advancing time does not ping on detached or connecting socket
    const ws1SentCount = ws1.sent.length;
    vi.advanceTimersByTime(60_000);
    expect(ws1.sent.length).toBe(ws1SentCount);

    // Even if late events were invoked on old handlers, they should be ignored
    oldMsgHandler?.({ data: JSON.stringify({ t: "peer-left", id: "p1" }) });
    expect(h.onPeerLeft).not.toHaveBeenCalled();

    // Late 1008 from server closing the replaced session does NOT make the client fatal
    oldCloseHandler?.({ code: 1008 });
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();
    expect(ws2.sent.length).toBeGreaterThan(0);

    c.close();
  });

  it("detaches prior connecting socket when connect() is called before open", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    const oldOpenHandler = ws1.onopen;

    // Call connect() again while ws1 is still connecting
    c.connect();
    const ws2 = FakeWebSocket.instances[1]!;
    expect(ws1.onopen).toBeNull();

    // Invoking old open handler does not trigger join or ping
    oldOpenHandler?.();
    expect(ws1.sent.length).toBe(0);

    // Opening ws2 works properly
    ws2.open();
    expect(ws2.sent.length).toBe(1);
    expect((JSON.parse(ws2.sent[0] ?? "{}") as { t: string }).t).toBe("join");

    c.close();
  });

  it("guards against error events on prior detached sockets", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    const oldErrorHandler = ws1.onerror;

    c.connect();
    expect(ws1.onerror).toBeNull();

    // Invoking old error handler does not trigger reconnect or error
    oldErrorHandler?.();
    vi.advanceTimersByTime(30_000);
    // Only 2 instances created (ws1 and ws2), no extra reconnect from ws1's error
    expect(FakeWebSocket.instances.length).toBe(2);

    c.close();
  });

  it("handles close() followed by connect() without staying closed", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();
    c.close();
    expect(ws1.readyState).toBe(3);

    // Call connect() after close()
    c.connect();
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();
    expect(ws2.sent.length).toBe(1);
    expect((JSON.parse(ws2.sent[0] ?? "{}") as { t: string }).t).toBe("join");

    // Server close triggers reconnect because closedByUs was reset
    ws2.serverClose(1006);
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances.length).toBe(3);

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

  /** What a refusal actually looks like: 101 handshake, so `open` fires, then close. */
  function refuse(code = 1013): void {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.open();
    ws.serverClose(code);
    vi.advanceTimersByTime(30_000);
  }

  it("retries a 1013 refusal rather than treating it as terminal", () => {
    // Capacity is transient â€” usually a half-open socket the runtime has not reaped â€”
    // so a client refused for it must come back. 1008 would strand a user who did
    // nothing wrong, and a failed handshake (1006) would retry forever with no reason
    // ever shown.
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    refuse();
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it("gives up after repeated 1013s, and says why", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    for (let i = 0; i < 6; i++) refuse();
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
    for (let i = 0; i < 4; i++) refuse();

    // A welcome, not a bare `open`, is what proves the connection worked.
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ t: "welcome", selfId: "a", peers: [] }) });

    // With the counter cleared, four more refusals must each still reconnect.
    // Without the reset the fifth cumulative refusal would have tripped the limit.
    const afterWelcome = FakeWebSocket.instances.length;
    for (let i = 0; i < 4; i++) refuse();
    expect(FakeWebSocket.instances.length).toBe(afterWelcome + 4);
  });

  it("sends the host token on every connect and passes the room state on", () => {
    const h = { ...handlers(), onRoomState: vi.fn() };
    let token: string | undefined;
    const c = new SignalingClient("ABCDEFGH", "alice", h, undefined, () => ({ hostToken: token }));
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    expect(JSON.parse(ws.sent[0]!)).not.toHaveProperty("hostToken");

    ws.onmessage?.({
      data: JSON.stringify({ t: "welcome", selfId: "me", peers: [], host: true, hostToken: "tok", locked: false }),
    });
    expect(h.onWelcome).toHaveBeenCalledWith("me", [], { host: true, hostToken: "tok", locked: false });
    token = "tok";

    ws.onmessage?.({ data: JSON.stringify({ t: "room-state", locked: true }) });
    expect(h.onRoomState).toHaveBeenCalledWith(true);

    ws.serverClose(1006);
    vi.advanceTimersByTime(20_000);
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();
    expect((JSON.parse(ws2.sent[0] ?? "{}") as { hostToken?: string }).hostToken).toBe("tok");
    c.close();
  });

  it("leaves the server's reason on screen when it refuses us", () => {
    const h = handlers();
    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ t: "error", code: "bad-password", message: "This room needs a password" }) });
    ws.serverClose(1008);
    expect(h.onError).toHaveBeenCalledWith("bad-password", "This room needs a password");
    // Reporting "closed" after the error replaced the explanation with "Connection closedâ€¦".
    expect(h.onStatus).not.toHaveBeenCalledWith("closed");
  });

  it("sends the rejoin ticket from the last welcome on the next join", () => {
    const h = handlers();
    let rejoin: string | undefined;
    const c = new SignalingClient("ABCDEFGH", "alice", h, undefined, () => ({ rejoinToken: rejoin }));
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.onmessage?.({
      data: JSON.stringify({ t: "welcome", selfId: "me", peers: [], host: false, rejoinToken: "r1", locked: true }),
    });
    expect(h.onWelcome).toHaveBeenCalledWith("me", [], { host: false, rejoinToken: "r1", locked: true });
    rejoin = "r1";
    ws.serverClose(1006);
    vi.advanceTimersByTime(20_000);
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();
    expect((JSON.parse(ws2.sent[0] ?? "{}") as { rejoinToken?: string }).rejoinToken).toBe("r1");
    c.close();
  });
});

describe("SignalingClient keepalive and session resumption", () => {
  let docListeners: Record<string, () => void>;
  let winListeners: Record<string, () => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "https:", host: "example.com" });

    docListeners = {};
    winListeners = {};
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: (ev: string, fn: () => void) => { docListeners[ev] = fn; },
      removeEventListener: (ev: string) => { delete docListeners[ev]; },
    });
    vi.stubGlobal("window", {
      addEventListener: (ev: string, fn: () => void) => { winListeners[ev] = fn; },
      removeEventListener: (ev: string) => { delete winListeners[ev]; },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends pings every 15 seconds when open", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();

    vi.advanceTimersByTime(15_000);
    expect(ws.sent).toContain("ping");
    c.close();
  });

  it("sends resume: true and sharing state on reconnect after being welcomed", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();

    // Welcome arrives and peer starts sharing
    ws1.onmessage?.({
      data: JSON.stringify({ t: "welcome", selfId: "p1", peers: [] }),
    });
    c.setSharing(true);

    // Socket blips
    ws1.serverClose(1006);
    vi.advanceTimersByTime(20_000);

    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();
    const joinMsg = JSON.parse(ws2.sent[0]!) as { resume?: boolean; sharing?: boolean };
    expect(joinMsg.resume).toBe(true);
    expect(joinMsg.sharing).toBe(true);
    c.close();
  });

  it("queues signal and state messages during reconnect and flushes them on welcome", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();
    ws1.onmessage?.({
      data: JSON.stringify({ t: "welcome", selfId: "p1", peers: [] }),
    });

    // Socket drops
    ws1.serverClose(1006);

    // Send signals and state while disconnected
    c.signal("p2", { k: "offer", sdp: "offer-sdp" });
    c.setSharing(true);

    // Reconnect socket opens
    vi.advanceTimersByTime(20_000);
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();

    // Messages should not be sent until welcome
    expect(ws2.sent.length).toBe(1); // only join message

    // Welcome arrives
    ws2.onmessage?.({
      data: JSON.stringify({ t: "welcome", selfId: "p1", peers: [] }),
    });

    // Flushed!
    expect(ws2.sent.length).toBe(3);
    expect(JSON.parse(ws2.sent[1]!)).toEqual({
      t: "signal",
      to: "p2",
      data: { k: "offer", sdp: "offer-sdp" },
    });
    expect(JSON.parse(ws2.sent[2]!)).toEqual({
      t: "state",
      sharing: true,
    });
    c.close();
  });

  it("triggers proactive reconnect if watchdog detects dead socket (>65s) while visible", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();

    // No messages received for 75s
    vi.advanceTimersByTime(75_000);

    // Watchdog should have triggered reconnect
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    c.close();
  });

  it("handles visibilitychange and online events to ping or reconnect immediately", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();

    // Visibility change when open sends ping
    const sentBefore = ws1.sent.length;
    docListeners["visibilitychange"]?.();
    expect(ws1.sent.length).toBe(sentBefore + 1);
    expect(ws1.sent[ws1.sent.length - 1]).toBe("ping");

    // Close socket to simulate offline
    ws1.serverClose(1006);

    // Online event triggers immediate reconnect without waiting for backoff timer
    winListeners["online"]?.();
    expect(FakeWebSocket.instances.length).toBe(2);

    c.close();
    // Cleaned up listeners
    expect(docListeners["visibilitychange"]).toBeUndefined();
    expect(winListeners["online"]).toBeUndefined();
  });

  it("drops oldest messages when pending queue exceeds 64 messages (FIFO limit)", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();
    ws1.onmessage?.({
      data: JSON.stringify({ t: "welcome", selfId: "p1", peers: [] }),
    });

    // Socket drops
    ws1.serverClose(1006);

    // Send 70 signals while disconnected
    for (let i = 0; i < 70; i++) {
      c.signal("p2", { k: "ice", candidate: { candidate: `cand-${i}`, sdpMid: "0", sdpMLineIndex: 0 } });
    }

    // Reconnect socket opens
    vi.advanceTimersByTime(20_000);
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();

    // Welcome arrives
    ws2.onmessage?.({
      data: JSON.stringify({ t: "welcome", selfId: "p1", peers: [] }),
    });

    // Total sent on ws2 = 1 (join) + 64 (flushed FIFO items, dropped first 6)
    expect(ws2.sent.length).toBe(65);
    const firstSent = JSON.parse(ws2.sent[1]!) as { data: { candidate: { candidate: string } } };
    expect(firstSent.data.candidate.candidate).toBe("cand-6");
    const lastSent = JSON.parse(ws2.sent[64]!) as { data: { candidate: { candidate: string } } };
    expect(lastSent.data.candidate.candidate).toBe("cand-69");
    c.close();
  });

  it("does not reconnect on visibility or online events if connect() has not been called yet", () => {
    new SignalingClient("ABCDEFGH", "alice", handlers());
    expect(FakeWebSocket.instances.length).toBe(0);

    docListeners["visibilitychange"]?.();
    expect(FakeWebSocket.instances.length).toBe(0);

    winListeners["online"]?.();
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it("does not abort or reconnect a socket that is currently in WebSocket.CONNECTING state", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    expect(FakeWebSocket.instances.length).toBe(1);
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.readyState = 0; // Simulate WebSocket.CONNECTING

    // Rapid successive wakeup events while handshake is in-flight
    docListeners["visibilitychange"]?.();
    winListeners["online"]?.();

    // Still only the single socket in-flight â€” handshake not aborted
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(ws1.readyState).toBe(0);
    c.close();
  });

  it("flushes pre-welcome queued messages before onWelcome handler executes", () => {
    const sentDuringWelcome: string[] = [];
    const h = handlers();

    const c = new SignalingClient("ABCDEFGH", "alice", h);
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();
    ws1.onmessage?.({
      data: JSON.stringify({ t: "welcome", selfId: "p1", peers: [] }),
    });

    // Socket drops
    ws1.serverClose(1006);

    // Set onWelcome spy now to observe flush order on reconnection welcome
    h.onWelcome = vi.fn(() => {
      const ws2 = FakeWebSocket.instances[1]!;
      sentDuringWelcome.push(...ws2.sent);
    });

    // Queue a signal while disconnected
    c.signal("p2", { k: "offer", sdp: "queued-offer" });

    // Reconnection socket opens
    vi.advanceTimersByTime(20_000);
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();

    // Welcome arrives
    ws2.onmessage?.({
      data: JSON.stringify({ t: "welcome", selfId: "p1", peers: [] }),
    });

    // Verify queued message was flushed BEFORE onWelcome executed
    expect(sentDuringWelcome.length).toBe(2); // join + queued offer
    expect(JSON.parse(sentDuringWelcome[1]!)).toEqual({
      t: "signal",
      to: "p2",
      data: { k: "offer", sdp: "queued-offer" },
    });
    c.close();
  });

  it("reconnects immediately when ws.send(PING) throws an exception", () => {
    const c = new SignalingClient("ABCDEFGH", "alice", handlers());
    c.connect();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();

    // Send kick and lock commands while open
    c.kick("00000000-0000-4000-8000-000000000001");
    c.setLocked(true);
    expect(JSON.parse(ws1.sent[1] ?? "{}")).toEqual({
      t: "kick",
      id: "00000000-0000-4000-8000-000000000001",
    });
    expect(JSON.parse(ws1.sent[2] ?? "{}")).toEqual({
      t: "lock",
      locked: true,
    });

    // Mock send to throw on ping
    ws1.send = (data: string) => {
      if (data === "ping") throw new Error("Socket broken");
    };

    // Trigger wakeup while ws1.send throws on PING
    winListeners["online"]?.();
    expect(FakeWebSocket.instances.length).toBe(2);

    const ws2 = FakeWebSocket.instances[1]!; // skipcq: JS-0339
    ws2.open();
    ws2.send = (data: string) => {
      if (data === "ping") throw new Error("Socket broken");
    };
    vi.advanceTimersByTime(15_000);
    expect(FakeWebSocket.instances.length).toBe(3);

    // Trigger wakeup when lastReceivedAt > 65_000ms stale
    const ws3 = FakeWebSocket.instances[2]!; // skipcq: JS-0339
    ws3.open();
    vi.setSystemTime(Date.now() + 70_000);
    winListeners["online"]?.();
    expect(FakeWebSocket.instances.length).toBe(4);

    // Calling connect() explicitly while a reconnectTimer is pending clears the timer
    const ws4 = FakeWebSocket.instances[3]!; // skipcq: JS-0339
    ws4.open();
    ws4.serverClose(1006);
    c.connect();
    expect(FakeWebSocket.instances.length).toBe(5);
    c.close();
  });
});


