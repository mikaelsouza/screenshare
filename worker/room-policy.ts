import type { ErrorCode } from "@shared/protocol";
import { timingSafeEqualStr } from "./room-crypto";
import {
  DISCONNECTED_REJOIN_TTL_MS,
  DUMMY_HASH_HEX,
  EMPTY_ROOM_TTL_MS,
  EMPTY_SESSION_CLEANUP_MS,
  HOST_GRACE_MS,
  OCCUPIED_FALLBACK_ALARM_MS,
  UNUSED_ROOM_TTL_MS,
  type MemberEntry,
  type PeerAttachment,
  type PromotedHostRecord,
} from "./room-models";

/**
 * Compute empty-room credential expiry:
 * - Pre-deploy rooms lacking `CREATOR_HOST_KEY` keep their non-sliding 12-hour TTL.
 * - Never-joined rooms expire 12 hours after creation (`UNUSED_ROOM_TTL_MS`).
 * - Joined rooms with `CREATOR_HOST_KEY` expire 90 days after the earlier of
 *   `emptySince` and `lastHostActiveAt`.
 */
export function computeCredentialExpiry(
  emptySince: number,
  everJoined: boolean,
  lastHostActiveAt: number | undefined,
  hasCreatorHost: boolean,
): number {
  if (!hasCreatorHost) {
    const legacyIdle = emptySince + UNUSED_ROOM_TTL_MS;
    return lastHostActiveAt !== undefined
      ? Math.min(legacyIdle, lastHostActiveAt + UNUSED_ROOM_TTL_MS)
      : legacyIdle;
  }
  if (!everJoined) return emptySince + UNUSED_ROOM_TTL_MS;
  const idleExpiry = emptySince + EMPTY_ROOM_TTL_MS;
  const hostExpiry = lastHostActiveAt !== undefined ? lastHostActiveAt + EMPTY_ROOM_TTL_MS : idleExpiry;
  return Math.min(idleExpiry, hostExpiry);
}

export interface AdmissionInput {
  claimed: boolean;
  storedRoomCode: string | undefined;
  expectedPasswordHash: string | undefined;
  roomPassword: string | undefined;
  hostHash: string | null;
  creatorHostHash: string | null;
  locked: boolean;
  memberTicket: MemberEntry | undefined;
  denied: boolean;
  msgRoom: string;
  pathRoomCode: string | undefined;
  offeredPasswordHash: string | null;
  offeredHostHash: string | null;
  hasActiveSocketMatch: boolean;
  /** True when the IP has already exhausted its password failure budget for the current window. */
  passwordFailureRateLimited?: boolean;
  /** Called ONLY when auth fails (unclaimed or invalid credentials). Returns false when rate-limited. */
  checkPasswordFailureRate: () => boolean;
}

export type AdmissionDecision =
  | {
      ok: true;
      isHost: boolean;
      isCreatorHost: boolean;
      locked: boolean;
      returning: boolean;
      roomPassword?: string | undefined;
      memberTicket?: MemberEntry | undefined;
    }
  | { ok: false; code: ErrorCode; message: string };

const RATE_LIMITED_DECISION: AdmissionDecision = {
  ok: false,
  code: "rate-limited",
  message: "Too many wrong invite codes. Wait a minute before trying again.",
};

function passwordFailureDecision(checkRate: () => boolean): AdmissionDecision {
  if (!checkRate()) return RATE_LIMITED_DECISION;
  return {
    ok: false,
    code: "bad-password",
    message: "Invalid or expired room invite.",
  };
}

function hasRoomCodeMismatch(
  storedRoomCode: string | undefined,
  msgRoom: string,
  pathRoomCode: string | undefined,
): boolean {
  if (storedRoomCode === undefined) return false;
  return msgRoom !== storedRoomCode || (pathRoomCode !== undefined && pathRoomCode !== storedRoomCode);
}

function hashMatches(offered: string | null, expected: string | null): boolean {
  return offered !== null && expected !== null && timingSafeEqualStr(offered, expected);
}

function constantTimePasswordMatch(
  claimed: boolean,
  offered: string | null,
  expected: string | undefined,
): boolean {
  const target = claimed ? (expected ?? DUMMY_HASH_HEX) : DUMMY_HASH_HEX;
  return timingSafeEqualStr(offered ?? DUMMY_HASH_HEX, target) && offered !== null && expected !== undefined;
}

/**
 * Pure join admission policy.
 *
 * Always runs constant-time password comparison BEFORE branching on `claimed`,
 * `locked`, `denied`, or rate limits so unclaimed/locked/denied rooms do not act
 * as existence oracles.
 */
export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
  const passwordMatch = constantTimePasswordMatch(
    input.claimed,
    input.offeredPasswordHash,
    input.expectedPasswordHash,
  );

  if (input.passwordFailureRateLimited === true) {
    return RATE_LIMITED_DECISION;
  }
  if (!input.claimed) {
    return passwordFailureDecision(input.checkPasswordFailureRate);
  }
  if (hasRoomCodeMismatch(input.storedRoomCode, input.msgRoom, input.pathRoomCode)) {
    return { ok: false, code: "bad-room-code", message: "Wrong room code for this connection" };
  }

  const isHost = hashMatches(input.offeredHostHash, input.hostHash);
  const isCreatorHost = hashMatches(input.offeredHostHash, input.creatorHostHash);
  const returning = input.memberTicket !== undefined || input.hasActiveSocketMatch;

  if (!passwordMatch && !isHost && !returning) {
    return passwordFailureDecision(input.checkPasswordFailureRate);
  }
  if (isHost || returning) {
    return {
      ok: true,
      isHost,
      isCreatorHost,
      locked: input.locked,
      returning,
      roomPassword: input.roomPassword,
      memberTicket: input.memberTicket,
    };
  }
  if (input.locked) {
    return { ok: false, code: "room-locked", message: "This room is locked. Ask the host to unlock it." };
  }
  if (input.denied) {
    return { ok: false, code: "kicked", message: "You were removed from this room." };
  }
  return {
    ok: true,
    isHost,
    isCreatorHost,
    locked: input.locked,
    returning: false,
    roomPassword: input.roomPassword,
  };
}

/** Pick the earliest-joined peer for host promotion (tie-break: joinedAt -> openedAt -> id). */
export function selectHostPromotionCandidate<T extends { att: Pick<PeerAttachment, "id" | "joinedAt" | "openedAt"> }>(
  peers: readonly T[],
): T | null {
  let candidate: T | null = null;
  for (const peer of peers) {
    if (!candidate) {
      candidate = peer;
      continue;
    }
    const aJoined = peer.att.joinedAt ?? peer.att.openedAt ?? Number.MAX_SAFE_INTEGER;
    const bJoined = candidate.att.joinedAt ?? candidate.att.openedAt ?? Number.MAX_SAFE_INTEGER;
    if (aJoined < bJoined || (aJoined === bJoined && peer.att.id < candidate.att.id)) {
      candidate = peer;
    }
  }
  return candidate;
}

export interface JoinPromotionInput {
  admissionIsHost: boolean;
  admissionReturning: boolean;
  supersededWasHost: boolean;
  replacesId: string | undefined;
  hasRawPromoted: boolean;
  promoted: PromotedHostRecord | null;
}

export interface JoinPromotionOutcome {
  effectiveIsHost: boolean;
  reissuedHostToken?: string;
  clearPromotedHost: boolean;
  markHostPromoted: boolean;
}

/** Resolve host status and pending promoted-host token claim on join/resume. */
export function evaluateJoinPromotion(input: JoinPromotionInput): JoinPromotionOutcome {
  if (input.admissionIsHost) {
    return {
      effectiveIsHost: true,
      clearPromotedHost: input.hasRawPromoted,
      markHostPromoted: input.hasRawPromoted,
    };
  }
  if (input.admissionReturning && input.promoted && input.replacesId === input.promoted.id) {
    return {
      effectiveIsHost: true,
      reissuedHostToken: input.promoted.token,
      clearPromotedHost: true,
      markHostPromoted: true,
    };
  }
  return {
    effectiveIsHost: input.supersededWasHost,
    clearPromotedHost: false,
    markHostPromoted: false,
  };
}

export interface ResumeAttachmentInput {
  currentId: string;
  clientSharing: boolean | undefined;
  superseded: Pick<PeerAttachment, "id" | "sharing"> | undefined;
  memberTicket: Pick<MemberEntry, "id" | "sharing"> | undefined;
  activePeerIds: ReadonlySet<string>;
}

/** Compute the resumed peer id and sharing flag for an in-place resume. */
export function resolveResumeAttachment(input: ResumeAttachmentInput): { id: string; sharing: boolean } {
  const resumedId = input.superseded?.id ?? input.memberTicket?.id;
  const id = resumedId !== undefined && !input.activePeerIds.has(resumedId) ? resumedId : input.currentId;
  const priorSharing = input.superseded?.sharing ?? input.memberTicket?.sharing;
  const sharing = input.clientSharing ?? priorSharing ?? false;
  return { id, sharing };
}

/** Enforce partial-mesh invariant on signal relay: viewers never offer to viewers. */
export function evaluateSignalRelay(
  sender: Pick<PeerAttachment, "sharing">,
  target: Pick<PeerAttachment, "sharing">,
  signalKind: string,
): { allowed: true } | { allowed: false; code: ErrorCode; message: string } {
  if (signalKind === "offer" && !sender.sharing && !target.sharing) {
    return {
      allowed: false,
      code: "not-sharing",
      message: "Neither of you is sharing",
    };
  }
  return { allowed: true };
}

export interface DisconnectTicketInput {
  now: number;
  attachment: Pick<PeerAttachment, "id" | "sharing" | "ip" | "joinedAt" | "openedAt" | "creatorHost">;
  existing: MemberEntry | undefined;
}

function applyDisconnectMetadata(
  ticket: MemberEntry,
  attachment: DisconnectTicketInput["attachment"],
  existing: MemberEntry | undefined,
): void {
  if (attachment.sharing) ticket.sharing = true;
  const ip = existing?.ip ?? attachment.ip;
  if (ip !== undefined) ticket.ip = ip;
  const joinedAt = existing?.joinedAt ?? attachment.joinedAt ?? attachment.openedAt;
  if (joinedAt !== undefined) ticket.joinedAt = joinedAt;
  if (existing?.creatorHost === true || attachment.creatorHost === true) ticket.creatorHost = true;
}

/** Build the persisted rejoin ticket on non-kicked disconnect (preserving active rotation grace). */
export function computeDisconnectTicket(input: DisconnectTicketInput): MemberEntry {
  const { now, attachment, existing } = input;
  const isRotationGrace = existing !== undefined && existing.rotationGrace === true && existing.until > now;
  const ticket: MemberEntry = {
    until: isRotationGrace ? existing.until : now + DISCONNECTED_REJOIN_TTL_MS,
    id: attachment.id,
  };
  if (isRotationGrace) ticket.rotationGrace = true;
  applyDisconnectMetadata(ticket, attachment, existing);
  return ticket;
}

export interface AlarmDeadlineInput {
  now: number;
  occupied: boolean;
  hasHost: boolean;
  hostGoneAt: number | undefined;
  emptySince: number;
  sessionCleaned: boolean;
  everJoined: boolean;
  lastHostActiveAt: number | undefined;
  hasCreatorHost: boolean;
  creatorCap: number | null;
  earliestUnjoinedDeadline: number | null;
}

/** Compute the next Durable Object alarm timestamp across occupied, host-grace, empty-cleanup, and credential-expiry states. */
export function computeNextAlarmDeadline(input: AlarmDeadlineInput): number {
  let lifecycleDeadline: number;
  if (input.occupied) {
    const fallback = input.now + OCCUPIED_FALLBACK_ALARM_MS;
    const base = !input.hasHost && input.hostGoneAt !== undefined
      ? Math.min(fallback, input.hostGoneAt + HOST_GRACE_MS)
      : fallback;
    lifecycleDeadline = input.creatorCap !== null ? Math.min(base, input.creatorCap) : base;
  } else {
    const credentialExpiry = computeCredentialExpiry(
      input.emptySince,
      input.everJoined,
      input.lastHostActiveAt,
      input.hasCreatorHost,
    );
    lifecycleDeadline = input.sessionCleaned
      ? credentialExpiry
      : Math.min(input.emptySince + EMPTY_SESSION_CLEANUP_MS, credentialExpiry);
  }
  const combined =
    input.earliestUnjoinedDeadline !== null
      ? Math.min(lifecycleDeadline, input.earliestUnjoinedDeadline)
      : lifecycleDeadline;
  return Math.max(input.now + 1000, combined);
}
