import type { ClientMessage, ServerMessage } from "@shared/protocol";
import { timingSafeEqualStr } from "./room-crypto";
import {
  getMembers,
  sendSafe,
  type JoinedSocket,
  type RoomLifecycleHost,
} from "./room-lifecycle";
import {
  CONNECTED_TICKET_TTL_MS,
  EVER_JOINED_KEY,
  HOST_GONE_KEY,
  HOST_PROMOTED_KEY,
  LAST_HOST_ACTIVE_KEY,
  MAX_STORED_ENTRIES,
  MEMBERS_KEY,
  PASSWORD_KEY,
  PROMOTED_HOST_KEY,
  PromotedHostSchema,
  ROOM_PASSWORD_KEY,
  ROTATION_REJOIN_GRACE_MS,
  capByExpiry,
  type MemberEntry,
  type PeerAttachment,
  type PreMintedRotation,
} from "./room-models";
import {
  evaluateJoinPromotion,
  resolveResumeAttachment,
  type AdmissionDecision,
  type JoinPromotionOutcome,
} from "./room-policy";

export function findSupersededPeers(
  others: readonly JoinedSocket[],
  offeredRejoinHash: string | null,
  isHost: boolean,
  ticketPeerId?: string,
): JoinedSocket[] {
  return others.filter(
    ({ att }) =>
      (offeredRejoinHash !== null &&
        att.rejoinHash !== undefined &&
        timingSafeEqualStr(att.rejoinHash, offeredRejoinHash)) ||
      (ticketPeerId !== undefined && att.id === ticketPeerId) ||
      (isHost && att.host === true),
  );
}

export function broadcastJoinOutcome(
  attachment: PeerAttachment,
  resumedInPlace: boolean,
  prevPeerState: { sharing: boolean; name: string; host: boolean } | undefined,
  isHost: boolean,
  replacesId: string | undefined,
  others: readonly JoinedSocket[],
): void {
  if (resumedInPlace && prevPeerState) {
    if (attachment.sharing !== prevPeerState.sharing) {
      const stateMsg: ServerMessage = { t: "peer-state", id: attachment.id, sharing: attachment.sharing };
      for (const { ws } of others) sendSafe(ws, stateMsg);
    }
    if (attachment.name !== prevPeerState.name) {
      const renameMsg: ServerMessage = { t: "peer-renamed", id: attachment.id, name: attachment.name };
      for (const { ws } of others) sendSafe(ws, renameMsg);
    }
    if (isHost && !prevPeerState.host) {
      const promoteMsg: ServerMessage = { t: "host-promoted", hostId: attachment.id };
      for (const { ws } of others) sendSafe(ws, promoteMsg);
    }
    return;
  }
  const joinedMsg: ServerMessage = {
    t: "peer-joined",
    peer: {
      id: attachment.id,
      name: attachment.name,
      sharing: attachment.sharing,
      ...(isHost ? { host: true } : {}),
    },
    ...(replacesId !== undefined ? { replaces: replacesId } : {}),
  };
  for (const { ws } of others) sendSafe(ws, joinedMsg);
}

export function sendWelcomeMessage(
  ws: WebSocket,
  attachment: PeerAttachment,
  others: readonly JoinedSocket[],
  admission: Extract<AdmissionDecision, { ok: true }>,
  promo: JoinPromotionOutcome,
  newRejoinToken: string,
): void {
  const canSeePassword = promo.effectiveIsHost || !admission.locked;
  sendSafe(ws, {
    t: "welcome",
    selfId: attachment.id,
    peers: others.map(({ att }) => ({
      id: att.id,
      name: att.name,
      sharing: att.sharing,
      ...(att.host ? { host: true } : {}),
    })),
    host: promo.effectiveIsHost,
    ...(promo.reissuedHostToken !== undefined ? { hostToken: promo.reissuedHostToken } : {}),
    ...(canSeePassword && admission.roomPassword ? { password: admission.roomPassword } : {}),
    rejoinToken: newRejoinToken,
    locked: admission.locked,
  });
}

export async function resolveAndApplyJoinPromotion(
  storage: DurableObjectStorage,
  admission: Extract<AdmissionDecision, { ok: true }>,
  supersededSocket: JoinedSocket | undefined,
  replacesId: string | undefined,
): Promise<JoinPromotionOutcome> {
  const rawPromoted = await storage.get<unknown>(PROMOTED_HOST_KEY);
  const promotedParsed = PromotedHostSchema.safeParse(rawPromoted);
  const promo = evaluateJoinPromotion({
    admissionIsHost: admission.isHost,
    admissionReturning: admission.returning,
    supersededWasHost: supersededSocket?.att.host === true,
    replacesId,
    hasRawPromoted: rawPromoted !== undefined,
    promoted: promotedParsed.success ? promotedParsed.data : null,
  });
  if (promo.clearPromotedHost) await storage.delete(PROMOTED_HOST_KEY);
  if (promo.markHostPromoted) await storage.put(HOST_PROMOTED_KEY, true);
  return promo;
}

export interface EvictionCallbacks {
  deletePeerState(peerId: string): void;
  clearGone(peerId: string): void;
  handleLeaveNoSync(ws: WebSocket): Promise<void>;
}

export async function evictSupersededPeers(
  host: RoomLifecycleHost,
  cb: EvictionCallbacks,
  ws: WebSocket,
  attachment: PeerAttachment,
  isResume: boolean,
  superseded: readonly JoinedSocket[],
): Promise<void> {
  const replaceErr: ServerMessage = {
    t: "error",
    code: "session-replaced",
    message: "Your session was replaced from another tab.",
  };
  if (isResume && superseded.length > 0) {
    for (const { ws: oldWs, att: oldAtt } of superseded) {
      const origOldId = oldAtt.id;
      if (origOldId !== attachment.id) {
        cb.deletePeerState(origOldId);
        for (const { ws: peerWs } of host.joinedPeers(ws)) {
          if (peerWs !== oldWs) sendSafe(peerWs, { t: "peer-left", id: origOldId });
        }
      }
      oldAtt.id = crypto.randomUUID();
      oldAtt.joined = false;
      try {
        oldWs.serializeAttachment(oldAtt);
      } catch {
        /* ignore */
      }
      host.refused.add(oldWs);
      host.forgetBudget(oldWs);
      sendSafe(oldWs, replaceErr);
      try {
        oldWs.close(1008, "Session replaced");
      } catch {
        /* ignore */
      }
    }
    cb.clearGone(attachment.id);
    return;
  }
  for (const { ws: oldWs } of superseded) {
    host.refused.add(oldWs);
    host.forgetBudget(oldWs);
    sendSafe(oldWs, replaceErr);
    await cb.handleLeaveNoSync(oldWs);
    try {
      oldWs.close(1008, "Session replaced");
    } catch {
      /* ignore */
    }
  }
}

export function applyResumeState(
  attachment: PeerAttachment,
  clientMsg: Extract<ClientMessage, { t: "join" }>,
  supersededSocket: JoinedSocket | undefined,
  memberTicket: MemberEntry | undefined,
  onIdReplaced: (oldId: string, newId: string) => void,
): void {
  const tempJoinId = attachment.id;
  const res = resolveResumeAttachment({
    currentId: tempJoinId,
    clientSharing: clientMsg.sharing,
    superseded: supersededSocket?.att,
    memberTicket,
    activePeerIds: new Set<string>(),
  });
  if (res.id !== tempJoinId) {
    attachment.id = res.id;
    onIdReplaced(tempJoinId, res.id);
  }
  attachment.sharing = res.sharing;
}

function seedRotationGraceMembers(
  now: number,
  rawMembers: Record<string, MemberEntry>,
  remainingActiveHashes: ReadonlySet<string>,
  purgeDisconnected: boolean,
): Record<string, MemberEntry> {
  const nextMembers: Record<string, MemberEntry> = {};
  for (const [hash, entry] of Object.entries(rawMembers)) {
    if (purgeDisconnected && !remainingActiveHashes.has(hash)) continue;
    nextMembers[hash] = {
      ...entry,
      until: Math.min(entry.until, now + ROTATION_REJOIN_GRACE_MS),
      rotationGrace: true,
    };
  }
  return nextMembers;
}

function buildConnectedMemberEntry(now: number, att: PeerAttachment): MemberEntry {
  const joinedAt = att.joinedAt ?? att.openedAt;
  return {
    until: now + CONNECTED_TICKET_TTL_MS,
    id: att.id,
    ...(att.sharing ? { sharing: true } : {}),
    ...(att.ip ? { ip: att.ip } : {}),
    ...(joinedAt !== undefined ? { joinedAt } : {}),
    ...(att.creatorHost ? { creatorHost: true } : {}),
  };
}

export async function applyRotationInTransaction(
  host: RoomLifecycleHost,
  now: number,
  locked: boolean,
  peers: readonly JoinedSocket[],
  rawMembers: Record<string, MemberEntry>,
  creds: PreMintedRotation,
  opts: { purgeDisconnected: boolean; extraWrites?: Record<string, unknown>; deferNotifications?: boolean },
): Promise<() => void> {
  const remainingActiveHashes = new Set<string>();
  for (const { att } of peers) {
    if (att.rejoinHash) remainingActiveHashes.add(att.rejoinHash);
  }
  const nextMembers = seedRotationGraceMembers(now, rawMembers, remainingActiveHashes, opts.purgeDisconnected);
  const pendingUpdates: Array<{ ws: WebSocket; att: PeerAttachment; hash: string; msg: ServerMessage }> = [];
  const protectedHashes = new Set<string>(remainingActiveHashes);
  let ticketIdx = 0;
  for (const { ws: peerWs, att } of peers) {
    const minted = creds.tickets[ticketIdx++];
    if (!minted) continue;
    nextMembers[minted.hash] = buildConnectedMemberEntry(now, att);
    protectedHashes.add(minted.hash);
    const canSeeSecret = att.host === true || !locked;
    pendingUpdates.push({
      ws: peerWs,
      att,
      hash: minted.hash,
      msg: {
        t: "room-password",
        ...(canSeeSecret ? { password: creds.newPassword } : {}),
        rejoinToken: minted.token,
      },
    });
  }
  await host.ctx.storage.put({
    ...opts.extraWrites,
    [PASSWORD_KEY]: creds.newPasswordHash,
    [ROOM_PASSWORD_KEY]: creds.newPassword,
    [MEMBERS_KEY]: capByExpiry(nextMembers, (m) => m.until, MAX_STORED_ENTRIES, protectedHashes),
  });
  for (const { ws: peerWs, att, hash } of pendingUpdates) {
    att.rejoinHash = hash;
    try { peerWs.serializeAttachment(att); } catch { /* ignore */ }
  }
  const flushNotifications = (): void => {
    for (const { ws: peerWs, msg } of pendingUpdates) sendSafe(peerWs, msg);
  };
  if (!opts.deferNotifications) flushNotifications();
  return flushNotifications;
}

export async function persistMemberRecord(
  host: RoomLifecycleHost,
  attachment: PeerAttachment,
  offeredRejoinHash: string | null,
  newRejoinHash: string,
  isHost: boolean,
  superseded: readonly JoinedSocket[],
  now: number,
): Promise<void> {
  const members = await getMembers(host, now);
  if (offeredRejoinHash) delete members[offeredRejoinHash];
  for (const { att } of superseded) {
    if (att.rejoinHash) delete members[att.rejoinHash];
  }
  members[newRejoinHash] = {
    until: now + CONNECTED_TICKET_TTL_MS,
    id: attachment.id,
    ...(attachment.sharing ? { sharing: true } : {}),
    ...(attachment.ip ? { ip: attachment.ip } : {}),
    ...(attachment.joinedAt !== undefined ? { joinedAt: attachment.joinedAt } : {}),
    ...(attachment.creatorHost ? { creatorHost: true } : {}),
  };
  const protectedHashes = host.activeRejoinHashes();
  protectedHashes.add(newRejoinHash);
  await host.ctx.storage.put({
    [MEMBERS_KEY]: capByExpiry(members, (m) => m.until, MAX_STORED_ENTRIES, protectedHashes),
    [EVER_JOINED_KEY]: true,
    ...(attachment.creatorHost === true ? { [LAST_HOST_ACTIVE_KEY]: now } : {}),
  });
  if (isHost) await host.ctx.storage.delete(HOST_GONE_KEY);
}
