import type { ServerMessage } from "@shared/protocol";
import {
  CLAIMED_KEY,
  CREATOR_HOST_KEY,
  DENY_KEY,
  EMPTY_ROOM_TTL_MS,
  EMPTY_SESSION_CLEANUP_MS,
  EMPTY_SINCE_KEY,
  EVER_JOINED_KEY,
  HOST_GONE_KEY,
  HOST_GRACE_MS,
  HOST_KEY,
  HOST_PROMOTED_KEY,
  JOIN_DEADLINE_MS,
  LAST_HOST_ACTIVE_KEY,
  LOCKED_KEY,
  MEMBERS_KEY,
  PASSWORD_KEY,
  PROMOTED_HOST_KEY,
  PeerAttachmentSchema,
  ROOM_PASSWORD_KEY,
  SESSION_CLEANED_KEY,
  UNUSED_ROOM_TTL_MS,
  filterLiveDenyList,
  filterLiveMembers,
  type MemberEntry,
  type PeerAttachment,
  type PreMintedEmptyReset,
  type PromotedHostRecord,
} from "./room-models";
import {
  computeCredentialExpiry,
  computeNextAlarmDeadline,
  selectHostPromotionCandidate,
  type AlarmDeadlineInput,
} from "./room-policy";

export interface JoinedSocket {
  ws: WebSocket;
  att: PeerAttachment;
}

export function getAttachment(ws: WebSocket): PeerAttachment | null {
  try {
    const parsed = PeerAttachmentSchema.safeParse(ws.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function sendSafe(ws: WebSocket, msg: ServerMessage): boolean {
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

export interface RoomLifecycleHost {
  readonly ctx: DurableObjectState;
  readonly refused: WeakSet<WebSocket>;
  forgetBudget(ws: WebSocket): void;
  refuse(ws: WebSocket, code: "join-timeout", message: string): void;
  joinedPeers(except?: WebSocket): JoinedSocket[];
  activeRejoinHashes(): Set<string>;
}

export function closeStaleUnjoinedSockets(host: RoomLifecycleHost, now: number): Set<WebSocket> {
  const closed = new Set<WebSocket>();
  for (const s of host.ctx.getWebSockets()) {
    const att = getAttachment(s);
    if (att && !att.joined && att.openedAt !== undefined && now - att.openedAt >= JOIN_DEADLINE_MS) {
      host.refuse(s, "join-timeout", "Did not join in time");
      closed.add(s);
    }
  }
  return closed;
}

function earliestUnjoinedDeadline(host: RoomLifecycleHost, now: number): number | null {
  let earliest: number | null = null;
  for (const s of host.ctx.getWebSockets()) {
    if (host.refused.has(s)) continue;
    const att = getAttachment(s);
    if (att && !att.joined && att.openedAt !== undefined) {
      const deadline = Math.max(now + 1000, att.openedAt + JOIN_DEADLINE_MS);
      if (earliest === null || deadline < earliest) earliest = deadline;
    }
  }
  return earliest;
}

async function scheduleAlarm(
  host: RoomLifecycleHost,
  input: Omit<AlarmDeadlineInput, "earliestUnjoinedDeadline">,
): Promise<void> {
  const next = computeNextAlarmDeadline({
    ...input,
    earliestUnjoinedDeadline: earliestUnjoinedDeadline(host, input.now),
  });
  await host.ctx.storage.setAlarm(next);
}

function occupiedAlarmInput(
  now: number, hasHost: boolean, hostGoneAt: number | undefined, creatorCap: number,
): Omit<AlarmDeadlineInput, "earliestUnjoinedDeadline"> {
  return {
    now, occupied: true, hasHost, hostGoneAt, emptySince: now,
    sessionCleaned: false, everJoined: true, lastHostActiveAt: undefined, hasCreatorHost: true, creatorCap,
  };
}

function emptyAlarmInput(
  now: number, emptySince: number, sessionCleaned: boolean, everJoined: boolean,
  lastHostActiveAt: number | undefined, hasCreatorHost: boolean,
): Omit<AlarmDeadlineInput, "earliestUnjoinedDeadline"> {
  return {
    now, occupied: false, hasHost: false, hostGoneAt: undefined, emptySince,
    sessionCleaned, everJoined, lastHostActiveAt, hasCreatorHost, creatorCap: null,
  };
}

export async function getMembers(
  host: RoomLifecycleHost,
  now: number,
  extraProtectedHashes?: ReadonlySet<string>,
): Promise<Record<string, MemberEntry>> {
  const all = (await host.ctx.storage.get<Record<string, unknown>>(MEMBERS_KEY)) ?? {};
  return filterLiveMembers(all, now, host.activeRejoinHashes(), extraProtectedHashes);
}

export async function getDenyList(host: RoomLifecycleHost, now: number): Promise<Record<string, number>> {
  const raw = (await host.ctx.storage.get<Record<string, number>>(DENY_KEY)) ?? {};
  return filterLiveDenyList(raw, now);
}

async function expireRoom(host: RoomLifecycleHost, exceptWs?: WebSocket): Promise<void> {
  for (const s of host.ctx.getWebSockets()) {
    if (s === exceptWs) continue;
    host.refused.add(s);
    host.forgetBudget(s);
    const att = getAttachment(s);
    if (att) {
      att.joined = false;
      att.host = false;
      att.creatorHost = false;
      delete att.rejoinHash;
      try {
        s.serializeAttachment(att);
      } catch {
        /* already closed */
      }
    }
    try {
      s.close(1001, "Room expired");
    } catch {
      /* already closed */
    }
  }
  await host.ctx.storage.deleteAlarm();
  await host.ctx.storage.deleteAll();
}

async function resetEmptySessionState(
  host: RoomLifecycleHost,
  now: number,
  preRotated: PreMintedEmptyReset,
): Promise<void> {
  closeStaleUnjoinedSockets(host, now);
  const [wasLocked, creatorHostHash, promoted, hostPromoted] = await Promise.all([
    host.ctx.storage.get<boolean>(LOCKED_KEY),
    host.ctx.storage.get<string>(CREATOR_HOST_KEY),
    host.ctx.storage.get<unknown>(PROMOTED_HOST_KEY),
    host.ctx.storage.get<boolean>(HOST_PROMOTED_KEY),
  ]);
  const revokeLegacyPromotedHost =
    creatorHostHash === undefined && (promoted !== undefined || hostPromoted === true);
  await host.ctx.storage.delete([
    MEMBERS_KEY,
    DENY_KEY,
    PROMOTED_HOST_KEY,
    HOST_GONE_KEY,
    HOST_PROMOTED_KEY,
    ...(revokeLegacyPromotedHost ? [HOST_KEY] : []),
  ]);
  await host.ctx.storage.put({
    [LOCKED_KEY]: false,
    [SESSION_CLEANED_KEY]: true,
    ...(creatorHostHash !== undefined ? { [HOST_KEY]: creatorHostHash } : {}),
    ...(wasLocked === true
      ? { [PASSWORD_KEY]: preRotated.passwordHash, [ROOM_PASSWORD_KEY]: preRotated.password }
      : {}),
  });
}

async function backfillUnjoinedLegacyCreatorHash(host: RoomLifecycleHost, now: number): Promise<boolean> {
  if (host.joinedPeers().length > 0) return false;
  const [
    creatorHash,
    hostHash,
    everJoined,
    sessionCleaned,
    members,
    promoted,
    hostPromoted,
    emptySince,
    lastHostActiveAt,
  ] = await Promise.all([
    host.ctx.storage.get<string>(CREATOR_HOST_KEY),
    host.ctx.storage.get<string>(HOST_KEY),
    host.ctx.storage.get<boolean>(EVER_JOINED_KEY),
    host.ctx.storage.get<boolean>(SESSION_CLEANED_KEY),
    host.ctx.storage.get<unknown>(MEMBERS_KEY),
    host.ctx.storage.get<unknown>(PROMOTED_HOST_KEY),
    host.ctx.storage.get<boolean>(HOST_PROMOTED_KEY),
    host.ctx.storage.get<number>(EMPTY_SINCE_KEY),
    host.ctx.storage.get<number>(LAST_HOST_ACTIVE_KEY),
  ]);
  const canBackfill =
    creatorHash === undefined &&
    hostHash !== undefined &&
    everJoined !== true &&
    sessionCleaned !== true &&
    members === undefined &&
    promoted === undefined &&
    hostPromoted !== true;
  if (!canBackfill) return false;
  await host.ctx.storage.put({
    [CREATOR_HOST_KEY]: hostHash,
    ...(lastHostActiveAt === undefined ? { [LAST_HOST_ACTIVE_KEY]: emptySince ?? now } : {}),
  });
  return true;
}

async function reconcileLegacyCreatorState(
  host: RoomLifecycleHost,
  now: number,
  emptySince: number,
  lastHostActiveAt: number | undefined,
): Promise<void> {
  const backfilled = await backfillUnjoinedLegacyCreatorHash(host, now);
  if (!backfilled && lastHostActiveAt === undefined) {
    await host.ctx.storage.put(LAST_HOST_ACTIVE_KEY, emptySince);
  }
}

async function creatorActivityCap(
  host: RoomLifecycleHost,
  peers: readonly JoinedSocket[],
  now: number,
): Promise<number> {
  if (peers.some(({ att }) => att.creatorHost === true)) {
    await host.ctx.storage.put(LAST_HOST_ACTIVE_KEY, now);
    return now + EMPTY_ROOM_TTL_MS;
  }
  const [everJoinedRaw, lastHostActiveAt, creatorHostHash] = await Promise.all([
    host.ctx.storage.get<boolean>(EVER_JOINED_KEY),
    host.ctx.storage.get<number>(LAST_HOST_ACTIVE_KEY),
    host.ctx.storage.get<string>(CREATOR_HOST_KEY),
  ]);
  if (creatorHostHash === undefined) {
    const baseline = lastHostActiveAt ?? now;
    if (lastHostActiveAt === undefined) await host.ctx.storage.put(LAST_HOST_ACTIVE_KEY, baseline);
    return baseline + UNUSED_ROOM_TTL_MS;
  }
  if (everJoinedRaw === true) {
    const baseline = lastHostActiveAt ?? now;
    if (lastHostActiveAt === undefined) await host.ctx.storage.put(LAST_HOST_ACTIVE_KEY, baseline);
    return baseline + EMPTY_ROOM_TTL_MS;
  }
  return Number.POSITIVE_INFINITY;
}

export async function syncAlarm(host: RoomLifecycleHost, now: number): Promise<void> {
  const peers = host.joinedPeers();
  if (peers.length === 0) {
    await host.ctx.storage.delete(HOST_GONE_KEY);
    let emptySince = await host.ctx.storage.get<number>(EMPTY_SINCE_KEY);
    if (emptySince === undefined) {
      emptySince = now;
      await host.ctx.storage.put(EMPTY_SINCE_KEY, emptySince);
    }
    const [sessionCleanedRaw, everJoinedRaw, lastHostActiveAt, creatorHostHash] = await Promise.all([
      host.ctx.storage.get<boolean>(SESSION_CLEANED_KEY),
      host.ctx.storage.get<boolean>(EVER_JOINED_KEY),
      host.ctx.storage.get<number>(LAST_HOST_ACTIVE_KEY),
      host.ctx.storage.get<string>(CREATOR_HOST_KEY),
    ]);
    await scheduleAlarm(
      host,
      emptyAlarmInput(
        now,
        emptySince,
        sessionCleanedRaw === true,
        everJoinedRaw === true,
        lastHostActiveAt,
        creatorHostHash !== undefined,
      ),
    );
    return;
  }

  const creatorCap = await creatorActivityCap(host, peers, now);
  if (peers.some(({ att }) => att.host)) {
    await host.ctx.storage.delete([EMPTY_SINCE_KEY, HOST_GONE_KEY, SESSION_CLEANED_KEY]);
    await scheduleAlarm(host, occupiedAlarmInput(now, true, undefined, creatorCap));
    return;
  }

  await host.ctx.storage.delete([EMPTY_SINCE_KEY, SESSION_CLEANED_KEY]);
  let goneAt = await host.ctx.storage.get<number>(HOST_GONE_KEY);
  if (goneAt === undefined) {
    goneAt = now;
    await host.ctx.storage.put(HOST_GONE_KEY, goneAt);
  }
  await scheduleAlarm(host, occupiedAlarmInput(now, false, goneAt, creatorCap));
}

interface EmptyRoomState {
  emptySince: number | undefined;
  sessionCleaned: boolean;
  everJoined: boolean;
  lastHostActiveAt: number | undefined;
  creatorHostHash: string | undefined;
}

async function readEmptyRoomState(storage: DurableObjectStorage): Promise<EmptyRoomState> {
  const [emptySince, sessionCleanedRaw, everJoinedRaw, lastHostActiveAt, creatorHostHash] = await Promise.all([
    storage.get<number>(EMPTY_SINCE_KEY),
    storage.get<boolean>(SESSION_CLEANED_KEY),
    storage.get<boolean>(EVER_JOINED_KEY),
    storage.get<number>(LAST_HOST_ACTIVE_KEY),
    storage.get<string>(CREATOR_HOST_KEY),
  ]);
  return {
    emptySince,
    sessionCleaned: sessionCleanedRaw === true,
    everJoined: everJoinedRaw === true,
    lastHostActiveAt,
    creatorHostHash,
  };
}

function isMissingEmptySinceExpired(state: EmptyRoomState, now: number): boolean {
  const capTtl = state.creatorHostHash !== undefined ? EMPTY_ROOM_TTL_MS : UNUSED_ROOM_TTL_MS;
  return (
    state.lastHostActiveAt !== undefined &&
    now >= state.lastHostActiveAt + capTtl &&
    (state.creatorHostHash === undefined || state.everJoined)
  );
}

async function runEmptyAlarm(
  host: RoomLifecycleHost,
  now: number,
  preRotated: PreMintedEmptyReset,
): Promise<void> {
  const state = await readEmptyRoomState(host.ctx.storage);
  let emptySince = state.emptySince;
  if (emptySince === undefined) {
    if (isMissingEmptySinceExpired(state, now)) {
      await expireRoom(host);
      return;
    }
    emptySince = now;
    await host.ctx.storage.put(EMPTY_SINCE_KEY, emptySince);
  }
  const credentialExpiry = computeCredentialExpiry(
    emptySince,
    state.everJoined,
    state.lastHostActiveAt,
    state.creatorHostHash !== undefined,
  );
  if (now >= credentialExpiry) {
    await expireRoom(host);
    return;
  }
  if (state.creatorHostHash === undefined) {
    await reconcileLegacyCreatorState(host, now, emptySince, state.lastHostActiveAt);
  }
  let sessionCleaned = state.sessionCleaned;
  if (!sessionCleaned && now - emptySince >= EMPTY_SESSION_CLEANUP_MS) {
    await resetEmptySessionState(host, now, preRotated);
    sessionCleaned = true;
  }
  await scheduleAlarm(
    host,
    emptyAlarmInput(
      now,
      emptySince,
      sessionCleaned,
      state.everJoined,
      state.lastHostActiveAt,
      state.creatorHostHash !== undefined,
    ),
  );
}

async function promoteCandidateOnAlarm(
  host: RoomLifecycleHost,
  peers: readonly JoinedSocket[],
  now: number,
  creatorCap: number,
  newHostToken: string,
  newHostHash: string,
): Promise<void> {
  const candidate = selectHostPromotionCandidate(peers);
  if (!candidate) return;

  const promotedRecord: PromotedHostRecord = { id: candidate.att.id, token: newHostToken };
  await host.ctx.storage.put({
    [HOST_KEY]: newHostHash,
    [PROMOTED_HOST_KEY]: promotedRecord,
    [HOST_PROMOTED_KEY]: true,
  });
  await host.ctx.storage.delete([EMPTY_SINCE_KEY, HOST_GONE_KEY, SESSION_CLEANED_KEY]);
  await scheduleAlarm(host, occupiedAlarmInput(now, true, undefined, creatorCap));

  candidate.att.host = true;
  try {
    candidate.ws.serializeAttachment(candidate.att);
  } catch {
    /* ignore */
  }
  const roomPassword = await host.ctx.storage.get<string>(ROOM_PASSWORD_KEY);
  sendSafe(candidate.ws, {
    t: "host-promoted",
    hostId: candidate.att.id,
    hostToken: newHostToken,
    ...(roomPassword ? { password: roomPassword } : {}),
  });
  const publicAnnouncement: ServerMessage = { t: "host-promoted", hostId: candidate.att.id };
  for (const { ws } of peers) {
    if (ws !== candidate.ws) sendSafe(ws, publicAnnouncement);
  }
}

export async function runAlarmInTransaction(
  host: RoomLifecycleHost,
  newHostToken: string,
  newHostHash: string,
  preRotated: PreMintedEmptyReset,
): Promise<void> {
  if ((await host.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) {
    await host.ctx.storage.deleteAlarm();
    return;
  }
  const now = Date.now();
  closeStaleUnjoinedSockets(host, now);
  const peers = host.joinedPeers();
  if (peers.length === 0) {
    await runEmptyAlarm(host, now, preRotated);
    return;
  }
  const creatorCap = await creatorActivityCap(host, peers, now);
  if (now >= creatorCap) {
    await expireRoom(host);
    return;
  }
  if (peers.some(({ att }) => att.host)) {
    await host.ctx.storage.delete([EMPTY_SINCE_KEY, HOST_GONE_KEY, SESSION_CLEANED_KEY]);
    await scheduleAlarm(host, occupiedAlarmInput(now, true, undefined, creatorCap));
    return;
  }
  const goneAt = await host.ctx.storage.get<number>(HOST_GONE_KEY);
  if (goneAt === undefined) {
    await host.ctx.storage.put(HOST_GONE_KEY, now);
    await scheduleAlarm(host, occupiedAlarmInput(now, false, now, creatorCap));
    return;
  }
  if (now - goneAt < HOST_GRACE_MS) {
    await scheduleAlarm(host, occupiedAlarmInput(now, false, goneAt, creatorCap));
    return;
  }
  await promoteCandidateOnAlarm(host, peers, now, creatorCap, newHostToken, newHostHash);
}

export async function reconcileEmptyTimersBeforeAdmit(
  host: RoomLifecycleHost,
  ws: WebSocket,
  now: number,
  preRotated: PreMintedEmptyReset,
): Promise<"expired" | "ok"> {
  if ((await host.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return "ok";
  const existingPeers = host.joinedPeers(ws);
  if (existingPeers.length > 0) {
    const creatorCap = await creatorActivityCap(host, existingPeers, now);
    if (now >= creatorCap) {
      await expireRoom(host, ws);
      return "expired";
    }
    return "ok";
  }
  const state = await readEmptyRoomState(host.ctx.storage);
  if (state.emptySince === undefined) {
    if (isMissingEmptySinceExpired(state, now)) {
      await expireRoom(host, ws);
      return "expired";
    }
    if (state.creatorHostHash === undefined) {
      await reconcileLegacyCreatorState(host, now, now, state.lastHostActiveAt);
    }
    await host.ctx.storage.put(EMPTY_SINCE_KEY, now);
    return "ok";
  }
  const credentialExpiry = computeCredentialExpiry(
    state.emptySince,
    state.everJoined,
    state.lastHostActiveAt,
    state.creatorHostHash !== undefined,
  );
  if (now >= credentialExpiry) {
    await expireRoom(host, ws);
    return "expired";
  }
  if (state.creatorHostHash === undefined) {
    await reconcileLegacyCreatorState(host, now, state.emptySince, state.lastHostActiveAt);
  }
  if (!state.sessionCleaned && now - state.emptySince >= EMPTY_SESSION_CLEANUP_MS) {
    await resetEmptySessionState(host, now, preRotated);
  }
  return "ok";
}
