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
  type ChatMessage,
  type ClientMessage,
  type PeerId,
  type PeerInfo,
  type ServerMessage,
  type SignalData,
} from "@shared/protocol";

/** Room control state carried by the welcome. */
export interface RoomInfo {
  /** Whether we are the room's host. */
  host: boolean;
  /** Present when room is unlocked (or always for host) so Invite ▾ can share CODE-SECRET. */
  password?: string;
  /** Present on creation or promotion. Keep it to stay host. */
  hostToken?: string;
  /** Fresh on every welcome. Present it on the next join to get back in if locked. */
  rejoinToken?: string;
  locked: boolean;
}

export interface SignalingHandlers {
  onWelcome(selfId: PeerId, peers: PeerInfo[], room: RoomInfo): void;
  onPeerJoined(peer: PeerInfo, replaces?: PeerId): void;
  onPeerLeft(id: PeerId, kicked?: boolean): void;
  onSignal(from: PeerId, data: SignalData): void;
  onPeerState(id: PeerId, sharing: boolean): void;
  onRoomState?(locked: boolean, password?: string): void;
  onRoomPassword?(password: string | undefined, rejoinToken: string | undefined): void;
  onPeerRenamed?(id: PeerId, name: string): void;
  onHostPromoted?(hostId: PeerId, hostToken?: string, password?: string): void;
  onChat?(msg: ChatMessage): void;
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
const POLICY_VIOLATION = 1008;
const MESSAGE_TOO_BIG = 1009;
const MAX_CAPACITY_RETRIES = 5;
const MAX_INITIAL_RETRIES = 8;
const MAX_PENDING_MESSAGES = 64;

const FATAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "bad-password",
  "bad-room-code",
  "kicked",
  "room-locked",
  "session-replaced",
  "forbidden-origin",
  "room-full",
  "join-timeout",
]);

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
  private receivedError = false;
  private lastError: { code: string; message: string } | null = null;
  private started = false;
  private welcomed = false;
  private socketWelcomed = false;
  private currentSelfId: PeerId | null = null;
  private sharing = false;
  private lastReceivedAt = 0;
  private pendingMessages: ClientMessage[] = [];
  private readonly room: string;
  private displayName: string;
  private readonly handlers: SignalingHandlers;
  /** Read on every (re)connect, so tokens issued by one welcome are sent on the next join. */
  private readonly tokens:
    | (() => { password?: string | undefined; hostToken?: string | undefined; rejoinToken?: string | undefined })
    | undefined;

  constructor(
    room: string,
    displayName: string,
    handlers: SignalingHandlers,
    tokens?: () => { password?: string | undefined; hostToken?: string | undefined; rejoinToken?: string | undefined },
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

  get isFatal(): boolean {
    return this.fatal;
  }

  get isReady(): boolean {
    return this.socketWelcomed && this.ws?.readyState === WebSocket.OPEN;
  }

  private markFatal(): void {
    this.fatal = true;
    this.socketWelcomed = false;
    this.pendingMessages = [];
    this.stopPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
    }
  }

  connect(): void {
    if (this.fatal) return;
    this.started = true;
    this.closedByUs = false;
    this.receivedError = false;
    this.lastError = null;
    this.socketWelcomed = false;
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
      this.socketWelcomed = false;
      this.receivedError = false;
      this.lastError = null;
      this.lastReceivedAt = Date.now();
      this.handlers.onStatus("open");
      const joinMsg: ClientMessage = {
        t: "join",
        room: this.room,
        displayName: this.displayName,
      };
      const { password, hostToken, rejoinToken } = this.tokens?.() ?? {};
      if (password) joinMsg.password = password;
      if (hostToken) joinMsg.hostToken = hostToken;
      if (rejoinToken) joinMsg.rejoinToken = rejoinToken;
      if (this.welcomed) {
        joinMsg.resume = true;
        joinMsg.sharing = this.sharing;
      }
      this.sendRaw(joinMsg);
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
      this.socketWelcomed = false;
      this.stopPing();
      // Closed on purpose: whoever closed it has already said what happened, e.g. that
      // the host removed us, and "Connection closed" would overwrite it.
      if (this.closedByUs || this.fatal) return;
      this.handlers.onStatus("closed");
      // 1008 / 1009 close means the server rejected this socket permanently.
      if (ev.code === POLICY_VIOLATION || ev.code === MESSAGE_TOO_BIG) {
        const prevErr = this.lastError;
        this.markFatal();
        if (!this.receivedError) {
          this.handlers.onError("bad-password", ev.reason || "Invalid or expired room invite.");
        } else if (prevErr) {
          this.handlers.onError(prevErr.code, prevErr.message);
        }
        return;
      }
      // Capacity is transient, so retry — but bounded, and say so when giving up.
      if (ev.code === TRY_AGAIN_LATER) {
        this.capacityRefusals++;
        if (this.capacityRefusals > MAX_CAPACITY_RETRIES) {
          this.markFatal();
          this.handlers.onError("rate-limited", "The room is still at capacity. Try again in a minute.");
          return;
        }
      } else if (!this.welcomed && this.attempts + 1 >= MAX_INITIAL_RETRIES) {
        this.markFatal();
        this.handlers.onError(
          "connection-failed",
          "Could not connect to that room. Check your connection and try again.",
        );
        return;
      }
      if (!this.closedByUs) this.scheduleReconnect();
    };

    ws.onerror = (): void => {
      if (this.ws !== ws) return;
      // 'close' always follows; reconnect is handled there.
    };
  }

  private handleWelcome(msg: Extract<ServerMessage, { t: "welcome" }>): void {
    // Proof the connection actually worked, which is what clears the counters.
    const sameSelf = this.currentSelfId === null || this.currentSelfId === msg.selfId;
    this.currentSelfId = msg.selfId;
    this.attempts = 0;
    this.capacityRefusals = 0;
    this.welcomed = true;
    this.socketWelcomed = true;
    const queued = this.pendingMessages;
    this.pendingMessages = [];
    for (const m of queued) {
      if (!sameSelf && m.t === "signal") continue;
      this.send(m);
    }
    this.handlers.onWelcome(msg.selfId, msg.peers, {
      host: msg.host === true,
      ...(typeof msg.password === "string" ? { password: msg.password } : {}),
      ...(typeof msg.hostToken === "string" ? { hostToken: msg.hostToken } : {}),
      ...(typeof msg.rejoinToken === "string" ? { rejoinToken: msg.rejoinToken } : {}),
      locked: msg.locked === true,
    });
  }

  private handleError(msg: Extract<ServerMessage, { t: "error" }>): void {
    this.receivedError = true;
    this.lastError = { code: msg.code, message: msg.message };
    if (FATAL_ERROR_CODES.has(msg.code)) {
      this.markFatal();
    }
    this.handlers.onError(msg.code, msg.message);
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.handleWelcome(msg);
        break;
      case "peer-joined":
        this.handlers.onPeerJoined(msg.peer, msg.replaces);
        break;
      case "peer-left":
        this.handlers.onPeerLeft(msg.id, msg.kicked);
        break;
      case "signal":
        this.handlers.onSignal(msg.from, msg.data);
        break;
      case "peer-state":
        this.handlers.onPeerState(msg.id, msg.sharing);
        break;
      case "room-state":
      case "room-password":
      case "peer-renamed":
      case "host-promoted":
      case "chat":
        this.dispatchRoomEvent(msg);
        break;
      case "error":
        this.handleError(msg);
        break;
    }
  }

  private dispatchRoomEvent(
    msg: Extract<ServerMessage, { t: "room-state" | "room-password" | "peer-renamed" | "host-promoted" | "chat" }>,
  ): void {
    switch (msg.t) {
      case "room-state":
        this.handlers.onRoomState?.(msg.locked, msg.password);
        break;
      case "room-password":
        this.handlers.onRoomPassword?.(msg.password, msg.rejoinToken);
        break;
      case "peer-renamed":
        this.handlers.onPeerRenamed?.(msg.id, msg.name);
        break;
      case "host-promoted":
        this.handlers.onHostPromoted?.(msg.hostId, msg.hostToken, msg.password);
        break;
      case "chat":
        this.handlers.onChat?.({ id: msg.id, from: msg.from, name: msg.name, text: msg.text, ts: msg.ts });
        break;
    }
  }

  private sendRaw(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  send(msg: ClientMessage): void {
    if (this.socketWelcomed && this.sendRaw(msg)) {
      return;
    }
    if ((this.started || this.welcomed) && !this.closedByUs && !this.fatal) {
      if (msg.t === "signal" || msg.t === "state" || msg.t === "rename") {
        if (this.pendingMessages.length >= MAX_PENDING_MESSAGES) {
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
    if (!this.isReady) return;
    this.sendRaw({ t: "kick", id });
  }

  /** Host only: refuse or allow new joins. */
  setLocked(locked: boolean): void {
    if (!this.isReady) return;
    this.sendRaw({ t: "lock", locked });
  }

  /** Host only: rotate the room's invite secret (disconnects are barred unless unlocked or holding a fresh ticket). */
  rotatePassword(): boolean {
    if (!this.isReady) return false;
    return this.sendRaw({ t: "rotate-password" });
  }

  /** Update our display name live inside the room. */
  rename(displayName: string): void {
    this.displayName = displayName;
    this.send({ t: "rename", displayName });
  }

  /** Send an ephemeral chat message when the signaling socket is ready (never queued across disconnects). */
  sendChat(text: string): boolean {
    if (!this.isReady) return false;
    return this.sendRaw({ t: "chat", text });
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
        const shouldCheckStale = isVisible || this.sharing;
        if (
          shouldCheckStale &&
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
