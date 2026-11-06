/**
 * WebSocket client for the signalling server.
 *
 * Carries a few KB per session and then goes quiet — once ICE completes, media is
 * peer-to-peer and this socket does nothing but hold the room membership open.
 */

import {
  PING,
  PONG,
  parseServerMessage,
  type ClientMessage,
  type PeerId,
  type PeerInfo,
  type ServerMessage,
  type SignalData,
} from "@shared/protocol";

/** Room control state carried by the welcome. */
interface RoomInfo {
  /** Whether we are the room's host. */
  host: boolean;
  /** Present only on the welcome that created the room. Keep it to stay host. */
  hostToken?: string;
  /** Fresh on every welcome. Present it on the next join to get back in if locked. */
  rejoinToken?: string;
  locked: boolean;
}

interface SignalingHandlers {
  onWelcome(selfId: PeerId, peers: PeerInfo[], room: RoomInfo): void;
  onPeerJoined(peer: PeerInfo): void;
  onPeerLeft(id: PeerId): void;
  onSignal(from: PeerId, data: SignalData): void;
  onPeerState(id: PeerId, sharing: boolean): void;
  onRoomState?(locked: boolean): void;
  onError(code: string, message: string): void;
  onStatus(status: "connecting" | "open" | "closed"): void;
}

/**
 * Cloudflare's proxy drops idle WebSockets after ~100s, so we must ping. The DO
 * answers these via setWebSocketAutoResponse(), which replies WITHOUT waking the
 * object — so keepalives cost nothing in either duration or request billing.
 */
const PING_INTERVAL_MS = 15_000;

/**
 * "Try Again Later": the server is at capacity right now. Worth retrying — the
 * condition is usually a half-open socket that has not been reaped yet — but not
 * forever, or a genuinely over-subscribed room becomes an endless silent retry.
 */
const TRY_AGAIN_LATER = 1013;
const MAX_CAPACITY_RETRIES = 5;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closedByUs = false;
  /** Set when the server rejected us permanently; suppresses all reconnection. */
  private fatal = false;
  /** Consecutive 1013 refusals, so a full room does not retry indefinitely. */
  private capacityRefusals = 0;
  private started = false;
  private welcomed = false;
  private sharing = false;
  private lastReceivedAt = 0;
  private pendingMessages: ClientMessage[] = [];
  private readonly room: string;
  private readonly displayName: string;
  private readonly handlers: SignalingHandlers;
  /** Read on every (re)connect, so tokens issued by one welcome are sent on the next join. */
  private readonly tokens:
    | (() => { hostToken?: string | undefined; rejoinToken?: string | undefined })
    | undefined;

  constructor(
    room: string,
    displayName: string,
    handlers: SignalingHandlers,
    tokens?: () => { hostToken?: string | undefined; rejoinToken?: string | undefined },
  ) {
    this.room = room;
    this.displayName = displayName;
    this.handlers = handlers;
    this.tokens = tokens;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
    }
  }

  connect(): void {
    if (this.fatal) return;
    this.started = true;
    this.closedByUs = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.stopPing();
      const oldWs = this.ws;
      this.ws = null;
      this.detachSocket(oldWs);
    }
    this.handlers.onStatus("connecting");

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(this.room)}`);
    this.ws = ws;

    ws.onopen = (): void => {
      if (this.ws !== ws) return;
      // Deliberately NOT resetting attempts or capacityRefusals here. A refusal also
      // completes the handshake — the server answers 101 and then closes, so that the
      // close code can carry a reason at all — so `open` fires for rejected sockets
      // too. Resetting on open made the backoff and the capacity bound unreachable:
      // every refusal looked like a fresh success, so the client hammered the Worker
      // roughly twice a second forever and never reported why. Only a welcome proves
      // we are actually in the room.
      this.lastReceivedAt = Date.now();
      this.handlers.onStatus("open");
      const joinMsg: ClientMessage = {
        t: "join",
        room: this.room,
        displayName: this.displayName,
      };
      const { hostToken, rejoinToken } = this.tokens?.() ?? {};
      if (hostToken) joinMsg.hostToken = hostToken;
      if (rejoinToken) joinMsg.rejoinToken = rejoinToken;
      if (this.welcomed) {
        joinMsg.resume = true;
        joinMsg.sharing = this.sharing;
      }
      this.send(joinMsg);
      this.startPing();
    };

    ws.onmessage = (ev): void => {
      if (this.ws !== ws) return;
      this.lastReceivedAt = Date.now();
      const raw = String(ev.data);
      if (raw === PONG || raw === PING) return; // keepalive, not protocol traffic
      const msg = parseServerMessage(raw);
      if (!msg) {
        console.warn("[signaling] unparseable message", raw.slice(0, 120));
        return;
      }
      this.dispatch(msg);
    };

    ws.onclose = (ev): void => {
      if (this.ws !== ws) return;
      this.stopPing();
      // Closed on purpose: whoever closed it has already said what happened, e.g. that
      // the host removed us, and "Connection closed" would overwrite it. The same goes
      // for 1008, below: the server sent its reason (wrong password, room full) as an
      // error just before closing, and that is what the user needs to read.
      if (this.closedByUs) return;
      if (ev.code !== 1008) this.handlers.onStatus("closed");
      // 1008 (policy violation) is how the server says "do not come back" — room
      // full, or a bad room code. Reconnecting re-triggers the same rejection
      // forever at the backoff cap, burning a Worker request and a Durable Object
      // wake-up per cycle while overwriting the message explaining what happened.
      if (ev.code === 1008) {
        this.fatal = true;
        this.pendingMessages = [];
        return;
      }
      // Capacity is transient, so retry — but bounded, and say so when giving up.
      if (ev.code === TRY_AGAIN_LATER) {
        this.capacityRefusals++;
        if (this.capacityRefusals > MAX_CAPACITY_RETRIES) {
          this.fatal = true;
          this.pendingMessages = [];
          this.handlers.onError("rate-limited", "The room is still at capacity. Try again in a minute.");
          return;
        }
      }
      if (!this.closedByUs) this.scheduleReconnect();
    };

    ws.onerror = (): void => {
      if (this.ws !== ws) return;
      // 'close' always follows; reconnect is handled there.
    };
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        // Proof the connection actually worked, which is what clears the counters.
        this.attempts = 0;
        this.capacityRefusals = 0;
        this.welcomed = true;
        {
          const queued = this.pendingMessages;
          this.pendingMessages = [];
          for (const m of queued) {
            this.send(m);
          }
        }
        this.handlers.onWelcome(msg.selfId, msg.peers, {
          host: msg.host === true,
          ...(typeof msg.hostToken === "string" ? { hostToken: msg.hostToken } : {}),
          ...(typeof msg.rejoinToken === "string" ? { rejoinToken: msg.rejoinToken } : {}),
          locked: msg.locked === true,
        });
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
      case "room-state":
        this.handlers.onRoomState?.(msg.locked);
        break;
      case "error":
        this.handlers.onError(msg.code, msg.message);
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    if (this.welcomed && !this.closedByUs && !this.fatal) {
      if (msg.t === "signal" || msg.t === "state") {
        if (this.pendingMessages.length >= 64) {
          this.pendingMessages.shift();
        }
        this.pendingMessages.push(msg);
      }
    }
  }

  signal(to: PeerId, data: SignalData): void {
    this.send({ t: "signal", to, data });
  }

  setSharing(sharing: boolean): void {
    this.sharing = sharing;
    this.send({ t: "state", sharing });
  }

  /** Host only: remove someone from the room. */
  kick(id: PeerId): void {
    this.send({ t: "kick", id });
  }

  /** Host only: refuse or allow new joins. */
  setLocked(locked: boolean): void {
    this.send({ t: "lock", locked });
  }

  private onVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      this.handleWakeup();
    }
  };

  private onOnline = (): void => {
    this.handleWakeup();
  };

  private handleWakeup(): void {
    if (!this.started || this.closedByUs || this.fatal) return;
    if (this.ws?.readyState === WebSocket.CONNECTING) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (this.lastReceivedAt > 0 && Date.now() - this.lastReceivedAt > 65_000) {
        this.reconnectNow();
      } else {
        try {
          this.ws.send(PING);
        } catch {
          this.reconnectNow();
        }
      }
    } else {
      this.reconnectNow();
    }
  }

  private reconnectNow(): void {
    if (this.fatal || this.closedByUs) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.attempts = 0;
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      this.detachSocket(oldWs);
    }
    this.connect();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const isVisible = typeof document === "undefined" || document.visibilityState === "visible";
        if (
          isVisible &&
          this.lastReceivedAt > 0 &&
          Date.now() - this.lastReceivedAt > 65_000
        ) {
          this.reconnectNow();
          return;
        }
        try {
          this.ws.send(PING);
        } catch {
          this.reconnectNow();
        }
      }
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

  private detachSocket(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close(1000);
    } catch {}
  }

  close(): void {
    this.started = false;
    this.closedByUs = true;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
    }
    this.pendingMessages = [];
    this.stopPing();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      this.detachSocket(oldWs);
    }
  }
}
