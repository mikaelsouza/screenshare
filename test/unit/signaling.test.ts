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
});
