/**
 * WebSocket client for the signalling server.
 *
 * Carries a few KB per session and then goes quiet — once ICE completes, media is
 * peer-to-peer and this socket does nothing but hold the room membership open.
 */

import {
  type IceServerConfig,
  PING,
  PONG,
  type ClientMessage,
  type PeerId,
  type PeerInfo,
  type ServerMessage,
  type SignalData,
} from "@shared/protocol";

export interface SignalingHandlers {
  onWelcome(selfId: PeerId, peers: PeerInfo[], iceServers: IceServerConfig[]): void;
  onPeerJoined(peer: PeerInfo): void;
  onPeerLeft(id: PeerId): void;
  onSignal(from: PeerId, data: SignalData): void;
  onPeerState(id: PeerId, sharing: boolean): void;
  onError(code: string, message: string): void;
  onStatus(status: "connecting" | "open" | "closed"): void;
}

/**
 * Cloudflare's proxy drops idle WebSockets after ~100s, so we must ping. The DO
 * answers these via setWebSocketAutoResponse(), which replies WITHOUT waking the
 * object — so keepalives cost nothing in either duration or request billing.
 */
const PING_INTERVAL_MS = 30_000;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closedByUs = false;
  /** Set when the server rejected us permanently; suppresses all reconnection. */
  private fatal = false;

  constructor(
    private readonly room: string,
    private readonly displayName: string,
    private readonly handlers: SignalingHandlers,
  ) {}

  connect(): void {
    if (this.fatal) return;
    this.closedByUs = false;
    this.handlers.onStatus("connecting");

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(this.room)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onStatus("open");
      this.send({ t: "join", room: this.room, displayName: this.displayName });
      this.startPing();
    };

    ws.onmessage = (ev) => {
      const raw = String(ev.data);
      if (raw === PONG || raw === PING) return; // keepalive, not protocol traffic
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw) as ServerMessage;
      } catch {
        console.warn("[signaling] unparseable message", raw.slice(0, 120));
        return;
      }
      this.dispatch(msg);
    };

    ws.onclose = (ev) => {
      this.stopPing();
      this.handlers.onStatus("closed");
      // 1008 (policy violation) is how the server says "do not come back" — room
      // full, or a bad room code. Reconnecting re-triggers the same rejection
      // forever at the backoff cap, burning a Worker request and a Durable Object
      // wake-up per cycle while overwriting the message explaining what happened.
      if (ev.code === 1008) {
        this.fatal = true;
        return;
      }
      if (!this.closedByUs) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // 'close' always follows; reconnect is handled there.
    };
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.handlers.onWelcome(msg.selfId, msg.peers, msg.iceServers ?? []);
        break;
      case "peer-joined":
        this.handlers.onPeerJoined(msg.peer);
        break;
      case "peer-left":
        this.handlers.onPeerLeft(msg.id);
        break;
      case "signal":
        this.handlers.onSignal(msg.from, msg.data);
        break;
      case "peer-state":
        this.handlers.onPeerState(msg.id, msg.sharing);
        break;
      case "error":
        this.handlers.onError(msg.code, msg.message);
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  signal(to: PeerId, data: SignalData): void {
    this.send({ t: "signal", to, data });
  }

  setSharing(sharing: boolean): void {
    this.send({ t: "state", sharing });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(PING);
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.fatal || this.reconnectTimer !== null) return;
    // Exponential backoff with jitter, capped at 15s.
    const delay = Math.min(15_000, 500 * 2 ** this.attempts) * (0.7 + Math.random() * 0.6);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  close(): void {
    this.closedByUs = true;
    this.stopPing();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}
