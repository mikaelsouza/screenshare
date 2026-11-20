import { DurableObject } from "cloudflare:workers";
import {
  MAX_ROOM_SIZE,
  PING,
  PONG,
  generateRoomPassword,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "@shared/protocol";
import type { Env } from "./index";
import { ipKey } from "./ipkey";
import { RateLimiter } from "./ratelimit";
import {
  admitConnection,
  handleKickAction,
  handleLockAction,
  handleRenameAction,
  handleRotatePasswordAction,
  handleSignalAction,
  handleStateAction,
} from "./room-actions";
import { hashRoomSecret, preMintEmptyResetSecret, timingSafeEqualStr } from "./room-crypto";
import {
  closeStaleUnjoinedSockets,
  getAttachment,
  getMembers,
  reconcileEmptyTimersBeforeAdmit,
  runAlarmInTransaction,
  sendSafe,
  syncAlarm,
  type JoinedSocket,
  type RoomLifecycleHost,
} from "./room-lifecycle";
import {
  applyResumeState,
  broadcastJoinOutcome,
  evictSupersededPeers,
  findSupersededPeers,
  persistMemberRecord,
  resolveAndApplyJoinPromotion,
  sendWelcomeMessage,
} from "./room-membership";
import {
  CLAIMED_KEY,
  CREATOR_HOST_KEY,
  EMPTY_SINCE_KEY,
  HOST_KEY,
  InitBodySchema,
  JOIN_DEADLINE_MS,
  LAST_HOST_ACTIVE_KEY,
  LOCKED_KEY,
  MAX_BAD_MESSAGES,
  MAX_FRAME_LENGTH,
  MAX_SOCKETS,
  MAX_SOCKETS_PER_IP,
  MAX_STORED_ENTRIES,
  MEMBERS_KEY,
  PASSWORD_KEY,
  ROOM_CODE_KEY,
  ROOM_PASSWORD_KEY,
  SESSION_CLEANED_KEY,
  capByExpiry,
  sanitiseName,
  spendBudget,
  type MessageBudget,
  type PeerAttachment,
} from "./room-models";
import { computeDisconnectTicket, type AdmissionDecision } from "./room-policy";
import { TRY_AGAIN_LATER, rejectUpgrade } from "./upgrade";

export class RoomDO extends DurableObject<Env> {
  private readonly budgets = new Map<string, MessageBudget>();
  private readonly badMessages = new Map<string, number>();
  private readonly refused = new WeakSet<WebSocket>();
  private readonly joining = new Set<string>();
  private readonly gone = new Set<string>();
  private readonly passwordFailures = new RateLimiter(15, 60_000, 2_048);
  private readonly lifecycleHost: RoomLifecycleHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycleHost = {
      ctx: this.ctx,
      refused: this.refused,
      forgetBudget: (ws) => this.forgetBudget(ws),
      refuse: (ws, code, message) => this.refuse(ws, code, message),
      joinedPeers: (except) => this.joinedPeers(except),
      activeRejoinHashes: () => this.activeRejoinHashes(),
    };
  }

  private spendMessage(peerId: string, now: number = Date.now()): boolean {
    const res = spendBudget(this.budgets.get(peerId), now);
    this.budgets.set(peerId, res.budget);
    return res.allowed;
  }

  private refuse(ws: WebSocket, code: ErrorCode, message: string, closeCode = 1008): void {
    this.refused.add(ws);
    this.forgetBudget(ws);
    sendSafe(ws, { t: "error", code, message });
    try { ws.close(closeCode, message); } catch { /* already closed */ }
  }

  private activeRejoinHashes(): Set<string> {
    const active = new Set<string>();
    for (const { att } of this.joinedPeers()) {
      if (att.rejoinHash) active.add(att.rejoinHash);
    }
    return active;
  }

  private joinedPeers(except?: WebSocket): JoinedSocket[] {
    const out: JoinedSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || this.refused.has(ws)) continue;
      const att = getAttachment(ws);
      if (att && att.joined) out.push({ ws, att });
    }
    return out;
  }

  override async alarm(): Promise<void> {
    const roomId = this.ctx.id.toString();
    const newHostToken = crypto.randomUUID();
    const [newHostHash, preRotated] = await Promise.all([
      hashRoomSecret(roomId, newHostToken, "host"),
      preMintEmptyResetSecret(roomId),
    ]);
    await this.ctx.blockConcurrencyWhile(async () => {
      await runAlarmInTransaction(this.lifecycleHost, newHostToken, newHostHash, preRotated);
    });
  }

  override fetch(request: Request): Promise<Response> {
    return this.handleFetch(request);
  }

  private async handleInit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400 });
    }
    const parsed = InitBodySchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: "Invalid room code" }), { status: 400 });
    }
    const roomId = this.ctx.id.toString();
    const password = generateRoomPassword();
    const hostToken = crypto.randomUUID();
    const [passwordHash, hostHash] = await Promise.all([
      hashRoomSecret(roomId, password, "password"),
      hashRoomSecret(roomId, hostToken, "host"),
    ]);

    return this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) === true) {
        return new Response(JSON.stringify({ error: "Room already initialized" }), { status: 409 });
      }
      const now = Date.now();
      await this.ctx.storage.put({
        [CLAIMED_KEY]: true,
        [ROOM_CODE_KEY]: parsed.data.code,
        [PASSWORD_KEY]: passwordHash,
        [ROOM_PASSWORD_KEY]: password,
        [HOST_KEY]: hostHash,
        [CREATOR_HOST_KEY]: hostHash,
        [LOCKED_KEY]: false,
        [EMPTY_SINCE_KEY]: now,
        [SESSION_CLEANED_KEY]: true,
        [LAST_HOST_ACTIVE_KEY]: now,
      });
      await syncAlarm(this.lifecycleHost, now);
      return new Response(JSON.stringify({ code: parsed.data.code, password, hostToken }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    });
  }

  private validateUpgradeRequest(request: Request, url: URL): Response | null {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const origin = request.headers.get("Origin");
    if (!origin) return null;
    try {
      if (new URL(origin).origin !== url.origin) {
        return rejectUpgrade("forbidden-origin", "Connections from this origin are not allowed");
      }
      return null;
    } catch {
      return rejectUpgrade("forbidden-origin", "Malformed Origin header");
    }
  }

  private checkSocketCapacity(live: readonly WebSocket[], clientIp: string | null): Response | null {
    if (clientIp) {
      let ipCount = 0;
      for (const s of live) {
        if (getAttachment(s)?.ip === clientIp) ipCount++;
      }
      if (ipCount >= MAX_SOCKETS_PER_IP) {
        return rejectUpgrade("rate-limited", "Too many connections from your network", TRY_AGAIN_LATER);
      }
    }
    if (live.length >= MAX_SOCKETS) {
      return rejectUpgrade("rate-limited", "Too many connections to this room", TRY_AGAIN_LATER);
    }
    return null;
  }

  private async ensureUnjoinedAlarm(now: number): Promise<void> {
    if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > now + JOIN_DEADLINE_MS) {
      await this.ctx.storage.setAlarm(now + JOIN_DEADLINE_MS);
    }
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "internal" && url.pathname === "/init" && request.method === "POST") {
      return this.handleInit(request);
    }
    const upgradeErr = this.validateUpgradeRequest(request, url);
    if (upgradeErr) return upgradeErr;

    const now = Date.now();
    const justClosed = closeStaleUnjoinedSockets(this.lifecycleHost, now);
    const live = this.ctx.getWebSockets().filter((s) => !justClosed.has(s));
    const rawIp = request.headers.get("CF-Connecting-IP");
    const clientIp = rawIp ? ipKey(rawIp) : null;
    const capErr = this.checkSocketCapacity(live, clientIp);
    if (capErr) return capErr;

    const pathRoomCode = /^\/ws\/([A-Za-z0-9]+)$/i.exec(url.pathname)?.[1]?.toUpperCase();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      id: crypto.randomUUID(),
      name: "",
      sharing: false,
      joined: false,
      ...(clientIp ? { ip: clientIp } : {}),
      ...(pathRoomCode ? { roomCode: pathRoomCode } : {}),
      openedAt: now,
    } satisfies PeerAttachment);

    await this.ensureUnjoinedAlarm(now);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.refused.has(ws)) return;
    if (typeof message !== "string") {
      this.refuse(ws, "bad-message", "Binary frames are not supported");
      return;
    }
    const attachment = getAttachment(ws);
    if (!attachment) return;
    if (message.length > MAX_FRAME_LENGTH) {
      this.refuse(ws, "bad-message", "Message too large", 1009);
      return;
    }
    if (!attachment.joined && attachment.openedAt !== undefined && Date.now() - attachment.openedAt >= JOIN_DEADLINE_MS) {
      this.refuse(ws, "join-timeout", "Did not join in time");
      return;
    }
    if (!this.spendMessage(attachment.id)) {
      this.refuse(ws, "rate-limited", "Too many messages");
      return;
    }
    if (message === PING) {
      try { ws.send(PONG); } catch { /* ignore */ }
      return;
    }
    if (message === PONG) return;

    const clientMsg = parseClientMessage(message);
    if (!clientMsg) {
      this.recordBadMessage(ws, attachment.id);
      return;
    }
    await this.dispatchClientMessage(ws, attachment, clientMsg);
  }

  private recordBadMessage(ws: WebSocket, peerId: string): void {
    const bad = (this.badMessages.get(peerId) ?? 0) + 1;
    this.badMessages.set(peerId, bad);
    if (bad > MAX_BAD_MESSAGES) {
      this.refuse(ws, "bad-message", "Too many invalid messages");
      return;
    }
    sendSafe(ws, { t: "error", code: "bad-message", message: "Invalid or malformed client message" });
  }

  private async dispatchClientMessage(ws: WebSocket, attachment: PeerAttachment, clientMsg: ClientMessage): Promise<void> {
    switch (clientMsg.t) {
      case "join":
        await this.onJoinMessage(ws, attachment, clientMsg);
        break;
      case "kick":
        await handleKickAction(this.lifecycleHost, ws, attachment, clientMsg, (targetWs) =>
          this.handleLeaveInternal(targetWs, { kicked: true, skipAlarmSync: true }),
        );
        break;
      case "lock":
        await handleLockAction(this.lifecycleHost, ws, attachment, clientMsg);
        break;
      case "rotate-password":
        await handleRotatePasswordAction(this.lifecycleHost, ws, attachment);
        break;
      case "rename":
        handleRenameAction(this.lifecycleHost, ws, attachment, clientMsg);
        break;
      case "signal":
        handleSignalAction(this.lifecycleHost, ws, attachment, clientMsg);
        break;
      case "state":
        await handleStateAction(this.lifecycleHost, ws, attachment, clientMsg);
        break;
    }
  }

  private async onJoinMessage(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
  ): Promise<void> {
    if (attachment.joined || this.joining.has(attachment.id) || this.gone.has(attachment.id)) return;
    const joinId = attachment.id;
    this.joining.add(joinId);
    try {
      await this.handleJoin(ws, attachment, clientMsg);
    } finally {
      this.joining.delete(joinId);
      this.gone.delete(joinId);
    }
  }

  private async handleJoin(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
  ): Promise<void> {
    const msgRoom = clientMsg.room.toUpperCase();
    if (attachment.roomCode !== undefined && msgRoom !== attachment.roomCode) {
      this.refuse(ws, "bad-room-code", "Wrong room code for this connection");
      return;
    }

    // Pre-compute ALL WebCrypto hashes BEFORE entering blockConcurrencyWhile / storage I/O.
    const roomId = this.ctx.id.toString();
    const normalizedPassword = clientMsg.password?.trim().toUpperCase();
    const newRejoinToken = crypto.randomUUID();
    const [offeredPasswordHash, offeredHostHash, offeredRejoinHash, newRejoinHash, preRotated] = await Promise.all([
      normalizedPassword ? hashRoomSecret(roomId, normalizedPassword, "password") : Promise.resolve(null),
      clientMsg.hostToken ? hashRoomSecret(roomId, clientMsg.hostToken, "host") : Promise.resolve(null),
      clientMsg.rejoinToken ? hashRoomSecret(roomId, clientMsg.rejoinToken, "rejoin") : Promise.resolve(null),
      hashRoomSecret(roomId, newRejoinToken, "rejoin"),
      preMintEmptyResetSecret(roomId),
    ]);

    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.gone.has(attachment.id) || this.refused.has(ws)) return;
      const now = Date.now();
      if ((await reconcileEmptyTimersBeforeAdmit(this.lifecycleHost, ws, now, preRotated)) === "expired") {
        this.refuse(ws, "bad-password", "Invalid or expired room invite.");
        return;
      }
      if (this.refused.has(ws)) return;
      const hasActiveSocketMatch =
        offeredRejoinHash !== null &&
        this.joinedPeers(ws).some(
          ({ att }) => att.rejoinHash !== undefined && timingSafeEqualStr(att.rejoinHash, offeredRejoinHash),
        );
      const admission = await admitConnection(this.lifecycleHost, this.passwordFailures, {
        msgRoom, pathRoomCode: attachment.roomCode, offeredPasswordHash, offeredHostHash,
        offeredRejoinHash, hasActiveSocketMatch, ip: attachment.ip,
      });
      if (!admission.ok) {
        this.refuse(ws, admission.code, admission.message);
        return;
      }
      await this.commitJoin(ws, attachment, clientMsg, admission, offeredRejoinHash, newRejoinToken, newRejoinHash);
    });
  }

  private finalizeJoinedAttachment(
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
    admission: Extract<AdmissionDecision, { ok: true }>,
    supersededSocket: JoinedSocket | undefined,
    isResume: boolean,
    effectiveIsHost: boolean,
    newRejoinHash: string,
  ): void {
    attachment.name = sanitiseName(clientMsg.displayName);
    attachment.joined = true;
    if (!isResume) attachment.sharing = false;
    attachment.host = effectiveIsHost;
    attachment.creatorHost =
      admission.isCreatorHost || admission.memberTicket?.creatorHost === true || supersededSocket?.att.creatorHost === true;
    attachment.rejoinHash = newRejoinHash;
  }

  private async prepareResumeAndEvict(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
    admission: Extract<AdmissionDecision, { ok: true }>,
    superseded: readonly JoinedSocket[],
    isResume: boolean,
    joinNow: number,
  ): Promise<boolean> {
    const supersededSocket = superseded[0];
    attachment.joinedAt = supersededSocket?.att.joinedAt ?? admission.memberTicket?.joinedAt ?? joinNow;
    if (isResume) {
      applyResumeState(attachment, clientMsg, supersededSocket, admission.memberTicket, (oldId, newId) => {
        this.budgets.delete(oldId);
        this.badMessages.delete(oldId);
        this.gone.delete(newId);
      });
    }
    const resumedInPlace =
      isResume && superseded.length > 0 && (!supersededSocket || supersededSocket.att.id === attachment.id);
    await evictSupersededPeers(
      this.lifecycleHost,
      {
        deletePeerState: (id) => { this.budgets.delete(id); this.badMessages.delete(id); },
        clearGone: (id) => this.gone.delete(id),
        handleLeaveNoSync: (oldWs) => this.handleLeaveInternal(oldWs, { skipAlarmSync: true }),
      },
      ws, attachment, isResume, superseded,
    );
    return resumedInPlace;
  }

  private async commitJoin(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
    admission: Extract<AdmissionDecision, { ok: true }>,
    offeredRejoinHash: string | null,
    newRejoinToken: string,
    newRejoinHash: string,
  ): Promise<void> {
    const activeOthers = this.joinedPeers(ws);
    const superseded = findSupersededPeers(activeOthers, offeredRejoinHash, admission.isHost, admission.memberTicket?.id);
    if (activeOthers.length - superseded.length >= MAX_ROOM_SIZE) {
      this.refuse(ws, "room-full", "Room is full");
      return;
    }
    const isResume = clientMsg.resume === true && admission.returning;
    const supersededSocket = superseded[0];
    const replacesId = supersededSocket?.att.id ?? admission.memberTicket?.id;
    const promo = await resolveAndApplyJoinPromotion(this.ctx.storage, admission, supersededSocket, replacesId);
    const prevPeerState = supersededSocket
      ? { sharing: supersededSocket.att.sharing, name: supersededSocket.att.name, host: supersededSocket.att.host === true }
      : undefined;

    const joinNow = Date.now();
    const resumedInPlace = await this.prepareResumeAndEvict(ws, attachment, clientMsg, admission, superseded, isResume, joinNow);

    const others = this.joinedPeers(ws);
    if (others.length >= MAX_ROOM_SIZE) {
      this.refuse(ws, "room-full", "Room is full");
      return;
    }
    this.finalizeJoinedAttachment(attachment, clientMsg, admission, supersededSocket, isResume, promo.effectiveIsHost, newRejoinHash);
    await persistMemberRecord(this.lifecycleHost, attachment, offeredRejoinHash, newRejoinHash, promo.effectiveIsHost, superseded, joinNow);
    try { ws.serializeAttachment(attachment); } catch { return; }
    await syncAlarm(this.lifecycleHost, joinNow);
    sendWelcomeMessage(ws, attachment, others, admission, promo, newRejoinToken);
    broadcastJoinOutcome(attachment, resumedInPlace, prevPeerState, promo.effectiveIsHost, replacesId, others);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.forgetBudget(ws);
    await this.handleLeave(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.forgetBudget(ws);
    await this.handleLeave(ws);
    try { ws.close(1011, "socket error"); } catch { /* already closed */ }
  }

  private forgetBudget(ws: WebSocket): void {
    const att = getAttachment(ws);
    if (!att) return;
    this.budgets.delete(att.id);
    this.badMessages.delete(att.id);
    if (this.joining.has(att.id)) this.gone.add(att.id);
  }

  private async handleLeave(ws: WebSocket): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.handleLeaveInternal(ws);
    });
  }

  private async handleLeaveInternal(ws: WebSocket, opts?: { kicked?: boolean; skipAlarmSync?: boolean }): Promise<void> {
    const attachment = getAttachment(ws);
    if (!attachment || !attachment.joined) return;
    attachment.joined = false;
    try { ws.serializeAttachment(attachment); } catch { /* ignore */ }

    const leftMsg: ServerMessage = { t: "peer-left", id: attachment.id, ...(opts?.kicked ? { kicked: true } : {}) };
    for (const { ws: s } of this.joinedPeers(ws)) sendSafe(s, leftMsg);
    if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return;

    const now = Date.now();
    if (!opts?.kicked && attachment.rejoinHash) {
      const members = await getMembers(this.lifecycleHost, now, new Set([attachment.rejoinHash]));
      members[attachment.rejoinHash] = computeDisconnectTicket({ now, attachment, existing: members[attachment.rejoinHash] });
      await this.ctx.storage.put({
        [MEMBERS_KEY]: capByExpiry(members, (m) => m.until, MAX_STORED_ENTRIES, this.activeRejoinHashes()),
      });
    }
    if (attachment.creatorHost === true) await this.ctx.storage.put(LAST_HOST_ACTIVE_KEY, now);
    if (!opts?.skipAlarmSync) await syncAlarm(this.lifecycleHost, now);
  }
}
