import { MAX_ROOM_SIZE, type ClientMessage, type ServerMessage } from "@shared/protocol";
import type { RateLimiter } from "./ratelimit";
import { preMintRotationCredentials } from "./room-crypto";
import {
  getAttachment,
  getDenyList,
  getMembers,
  sendSafe,
  syncAlarm,
  type RoomLifecycleHost,
} from "./room-lifecycle";
import { applyRotationInTransaction } from "./room-membership";
import {
  CLAIMED_KEY,
  CREATOR_HOST_KEY,
  DENY_KEY,
  HOST_KEY,
  KICK_BAN_MS,
  LOCKED_KEY,
  MAX_STORED_ENTRIES,
  MEMBERS_KEY,
  PASSWORD_KEY,
  ROOM_CODE_KEY,
  ROOM_PASSWORD_KEY,
  capByExpiry,
  sanitiseName,
  type PeerAttachment,
} from "./room-models";
import { evaluateAdmission, evaluateSignalRelay, type AdmissionDecision } from "./room-policy";

export interface AdmitTokens {
  msgRoom: string;
  pathRoomCode: string | undefined;
  offeredPasswordHash: string | null;
  offeredHostHash: string | null;
  offeredRejoinHash: string | null;
  hasActiveSocketMatch: boolean;
  ip: string | undefined;
}

export async function admitConnection(
  host: RoomLifecycleHost,
  passwordFailures: RateLimiter,
  tokens: AdmitTokens,
): Promise<AdmissionDecision> {
  const claimed = (await host.ctx.storage.get<boolean>(CLAIMED_KEY)) === true;
  const rateIp = tokens.ip ?? "unknown";
  const passwordFailureRateLimited = passwordFailures.isLimited(rateIp);
  if (!claimed) {
    return evaluateAdmission({
      claimed: false, storedRoomCode: undefined, expectedPasswordHash: undefined, roomPassword: undefined,
      hostHash: null, creatorHostHash: null, locked: false, memberTicket: undefined, denied: false,
      msgRoom: tokens.msgRoom, pathRoomCode: tokens.pathRoomCode,
      offeredPasswordHash: tokens.offeredPasswordHash, offeredHostHash: tokens.offeredHostHash,
      hasActiveSocketMatch: false, passwordFailureRateLimited,
      checkPasswordFailureRate: () => passwordFailures.check(rateIp),
    });
  }
  const now = Date.now();
  const [expectedPasswordHash, storedRoomCode, hostHash, creatorHostHash, lockedRaw, roomPassword, members, deny] =
    await Promise.all([
      host.ctx.storage.get<string>(PASSWORD_KEY),
      host.ctx.storage.get<string>(ROOM_CODE_KEY),
      host.ctx.storage.get<string>(HOST_KEY),
      host.ctx.storage.get<string>(CREATOR_HOST_KEY),
      host.ctx.storage.get<boolean>(LOCKED_KEY),
      host.ctx.storage.get<string>(ROOM_PASSWORD_KEY),
      getMembers(host, now),
      tokens.ip ? getDenyList(host, now) : Promise.resolve<Record<string, number>>({}),
    ]);
  return evaluateAdmission({
    claimed: true, storedRoomCode, expectedPasswordHash, roomPassword,
    hostHash: hostHash ?? null, creatorHostHash: creatorHostHash ?? null, locked: lockedRaw === true,
    memberTicket: tokens.offeredRejoinHash !== null ? members[tokens.offeredRejoinHash] : undefined,
    denied: tokens.ip !== undefined && deny[tokens.ip] !== undefined,
    msgRoom: tokens.msgRoom, pathRoomCode: tokens.pathRoomCode,
    offeredPasswordHash: tokens.offeredPasswordHash, offeredHostHash: tokens.offeredHostHash,
    hasActiveSocketMatch: tokens.hasActiveSocketMatch, passwordFailureRateLimited,
    checkPasswordFailureRate: () => passwordFailures.check(rateIp),
  });
}

export async function handleKickAction(
  host: RoomLifecycleHost,
  ws: WebSocket,
  attachment: PeerAttachment,
  clientMsg: Extract<ClientMessage, { t: "kick" }>,
  handleKickedLeave: (targetWs: WebSocket) => Promise<void>,
): Promise<void> {
  if (!attachment.joined || !attachment.host) {
    sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can remove people" });
    return;
  }
  if (clientMsg.id === attachment.id) return;
  if (!host.joinedPeers(ws).some(({ att }) => att.id === clientMsg.id)) {
    sendSafe(ws, { t: "error", code: "unknown-peer", message: "Peer not found" });
    return;
  }
  // Pre-compute ALL WebCrypto hashes BEFORE blockConcurrencyWhile.
  const creds = await preMintRotationCredentials(host.ctx.id.toString(), MAX_ROOM_SIZE);
  await host.ctx.blockConcurrencyWhile(async () => {
    if ((await host.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return;
    const freshCaller = getAttachment(ws);
    if (!freshCaller?.joined || !freshCaller.host) {
      sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can remove people" });
      return;
    }
    const target = host.joinedPeers(ws).find(({ att }) => att.id === clientMsg.id);
    if (!target) {
      sendSafe(ws, { t: "error", code: "unknown-peer", message: "Peer not found" });
      return;
    }
    const now = Date.now();
    const extraWrites: Record<string, unknown> = {};
    if (target.att.ip) {
      const deny = await getDenyList(host, now);
      deny[target.att.ip] = now + KICK_BAN_MS;
      extraWrites[DENY_KEY] = capByExpiry(deny, (u) => u);
    }
    const remainingPeers = host.joinedPeers(target.ws);
    const [lockedRaw, members] = await Promise.all([
      host.ctx.storage.get<boolean>(LOCKED_KEY),
      getMembers(host, now),
    ]);
    const flushNotifications = await applyRotationInTransaction(
      host,
      now,
      lockedRaw === true,
      remainingPeers,
      members,
      creds,
      { purgeDisconnected: true, extraWrites, deferNotifications: true },
    );
    host.refused.add(target.ws);
    sendSafe(target.ws, { t: "error", code: "kicked", message: "You were removed from this room." });
    await handleKickedLeave(target.ws);
    try { target.ws.close(1008, "Kicked"); } catch { /* already closed */ }
    flushNotifications();
    await syncAlarm(host, now);
  });
}

export async function handleLockAction(
  host: RoomLifecycleHost,
  ws: WebSocket,
  attachment: PeerAttachment,
  clientMsg: Extract<ClientMessage, { t: "lock" }>,
): Promise<void> {
  if (!attachment.joined || !attachment.host) {
    sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can lock the room" });
    return;
  }
  await host.ctx.blockConcurrencyWhile(async () => {
    if ((await host.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return;
    const freshCaller = getAttachment(ws);
    if (!freshCaller?.joined || !freshCaller.host) {
      sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can lock the room" });
      return;
    }
    await host.ctx.storage.put(LOCKED_KEY, clientMsg.locked);
    const password = !clientMsg.locked ? await host.ctx.storage.get<string>(ROOM_PASSWORD_KEY) : undefined;
    const stateMsg: ServerMessage = {
      t: "room-state",
      locked: clientMsg.locked,
      ...(password ? { password } : {}),
    };
    sendSafe(ws, stateMsg);
    for (const { ws: s } of host.joinedPeers(ws)) sendSafe(s, stateMsg);
  });
}

export async function handleRotatePasswordAction(
  host: RoomLifecycleHost,
  ws: WebSocket,
  attachment: PeerAttachment,
): Promise<void> {
  if (!attachment.joined || !attachment.host) {
    sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can rotate the invite code" });
    return;
  }
  const creds = await preMintRotationCredentials(host.ctx.id.toString(), MAX_ROOM_SIZE);
  await host.ctx.blockConcurrencyWhile(async () => {
    if ((await host.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return;
    const freshCaller = getAttachment(ws);
    if (!freshCaller?.joined || !freshCaller.host) {
      sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can rotate the invite code" });
      return;
    }
    const now = Date.now();
    const locked = (await host.ctx.storage.get<boolean>(LOCKED_KEY)) === true;
    const rawMembers = await getMembers(host, now);
    await applyRotationInTransaction(host, now, locked, host.joinedPeers(), rawMembers, creds, {
      purgeDisconnected: false,
    });
    await syncAlarm(host, now);
  });
}

export function handleRenameAction(
  host: RoomLifecycleHost,
  ws: WebSocket,
  attachment: PeerAttachment,
  clientMsg: Extract<ClientMessage, { t: "rename" }>,
): void {
  if (!attachment.joined) return;
  const cleaned = sanitiseName(clientMsg.displayName);
  if (cleaned === attachment.name) return;
  attachment.name = cleaned;
  try { ws.serializeAttachment(attachment); } catch { /* ignore */ }
  const renameMsg: ServerMessage = { t: "peer-renamed", id: attachment.id, name: attachment.name };
  for (const { ws: s } of host.joinedPeers()) sendSafe(s, renameMsg);
}

export function handleSignalAction(
  host: RoomLifecycleHost,
  ws: WebSocket,
  attachment: PeerAttachment,
  clientMsg: Extract<ClientMessage, { t: "signal" }>,
): void {
  if (!attachment.joined) {
    sendSafe(ws, { t: "error", code: "unknown-peer", message: "Must join room before sending signals" });
    return;
  }
  const target = host.joinedPeers().find(({ att }) => att.id === clientMsg.to);
  if (!target) {
    sendSafe(ws, { t: "error", code: "unknown-peer", message: "Peer not found" });
    return;
  }
  const verdict = evaluateSignalRelay(attachment, target.att, clientMsg.data.k);
  if (!verdict.allowed) {
    sendSafe(ws, { t: "error", code: verdict.code, message: verdict.message });
    return;
  }
  sendSafe(target.ws, { t: "signal", from: attachment.id, data: clientMsg.data });
}

export async function handleStateAction(
  host: RoomLifecycleHost,
  ws: WebSocket,
  attachment: PeerAttachment,
  clientMsg: Extract<ClientMessage, { t: "state" }>,
): Promise<void> {
  if (!attachment.joined) return;
  attachment.sharing = clientMsg.sharing;
  try { ws.serializeAttachment(attachment); } catch { /* ignore */ }
  if (attachment.rejoinHash) {
    await host.ctx.blockConcurrencyWhile(async () => {
      const members = await getMembers(host, Date.now());
      const member = attachment.rejoinHash ? members[attachment.rejoinHash] : undefined;
      if (!member) return;
      member.sharing = attachment.sharing;
      await host.ctx.storage.put({
        [MEMBERS_KEY]: capByExpiry(members, (m) => m.until, MAX_STORED_ENTRIES, host.activeRejoinHashes()),
      });
    });
  }
  const stateMsg: ServerMessage = { t: "peer-state", id: attachment.id, sharing: attachment.sharing };
  for (const { ws: s } of host.joinedPeers(ws)) sendSafe(s, stateMsg);
}
