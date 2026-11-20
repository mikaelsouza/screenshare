import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { MAX_ROOM_SIZE, generateRoomCode, generateRoomPassword, type SignalData } from "@shared/protocol";
import type { CaptureResult } from "@src/capture";
import { Mesh, type MeshCallbacks, type MeshOptions } from "@src/mesh";
import { SignalingClient, type RoomInfo } from "@src/signaling";
import {
  CONNECTED_TICKET_TTL_MS,
  DISCONNECTED_REJOIN_TTL_MS,
  EMPTY_ROOM_TTL_MS,
  EMPTY_SESSION_CLEANUP_MS,
  HOST_GRACE_MS,
  KICK_BAN_MS,
  MAX_STORED_ENTRIES,
  ROTATION_REJOIN_GRACE_MS,
  UNUSED_ROOM_TTL_MS,
  capByExpiry,
  filterLiveDenyList,
  filterLiveMembers,
  type MemberEntry,
  type PeerAttachment,
  type PromotedHostRecord,
} from "@worker/room-models";
import {
  computeCredentialExpiry,
  computeDisconnectTicket,
  computeNextAlarmDeadline,
  evaluateAdmission,
  evaluateJoinPromotion,
  evaluateSignalRelay,
  resolveResumeAttachment,
  selectHostPromotionCandidate,
} from "@worker/room-policy";

// ---------------------------------------------------------------------------
// Deterministic Model Digest + Virtual Room Simulator (faithful to worker/room*.ts)
// ---------------------------------------------------------------------------

/**
 * Deterministic 64-hex-char fingerprint for the synchronous virtual model.
 * Real production hashing uses WebCrypto SHA-256 on 96-bit CSPRNG room secrets
 * in `worker/room-crypto.ts`; the model only requires an injective 64-hex digest
 * for constant-time comparison in `evaluateAdmission`.
 */
function syncHashSecret(roomId: string, secret: string, kind: "host" | "rejoin" | "password"): string {
  const input = `${roomId}:${kind}:${secret}`;
  let out = "";
  for (let lane = 0; lane < 8; lane++) {
    let h = (0x811c9dc5 ^ (lane * 0x9e3779b9)) >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= input.length;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

interface SimClientPeer {
  id: string;
  ip: string;
  name: string;
  sharing: boolean;
  host: boolean;
  creatorHost: boolean;
  openedAt: number;
  joinedAt: number;
  rejoinHash: string;
  rejoinToken: string;
  hostToken?: string;
}

interface UnjoinedSocketSpec {
  id: string;
  openedAt: number;
}

class VirtualRoomHarness {
  readonly roomId = "do-sim-room-1";
  readonly roomCode = generateRoomCode();
  now = 1_700_000_000_000;

  claimed = true;
  everJoined = false;
  sessionCleaned = false;
  locked = false;
  hostPromoted = false;
  promotedHost: PromotedHostRecord | null = null;
  emptySince: number | undefined;
  hostGoneAt: number | undefined;
  lastHostActiveAt: number | undefined;
  readonly passwordFailures = new Map<string, number[]>();
  readonly unjoinedSockets: UnjoinedSocketSpec[] = [];

  password: string;
  passwordHash: string;
  readonly creatorHostToken: string;
  creatorHostHash: string | null;
  hostHash: string | null;
  alarmDeadline: number | null = null;

  members: Record<string, MemberEntry> = {};
  deny: Record<string, number> = {};
  readonly peers = new Map<string, SimClientPeer>();

  private seq = 0;

  constructor(opts: { legacy?: boolean; legacyJoined?: boolean } = {}) {
    this.password = generateRoomPassword();
    this.passwordHash = syncHashSecret(this.roomId, this.password, "password");
    this.creatorHostToken = `host-tok-${this.nextSeq()}`;
    const cHash = syncHashSecret(this.roomId, this.creatorHostToken, "host");
    this.hostHash = cHash;
    this.creatorHostHash = opts.legacy ? null : cHash;
    this.emptySince = this.now;
    this.lastHostActiveAt = opts.legacy ? undefined : this.now;
    if (opts.legacy && opts.legacyJoined) {
      this.everJoined = true;
      this.sessionCleaned = true;
    }
    this.syncAlarm();
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private nextUuid(prefix: string): string {
    return `${prefix}-${String(this.nextSeq()).padStart(4, "0")}`;
  }

  private activeRejoinHashes(): Set<string> {
    const out = new Set<string>();
    for (const p of this.peers.values()) out.add(p.rejoinHash);
    return out;
  }

  private filterMembers(extraProtected?: ReadonlySet<string>): Record<string, MemberEntry> {
    return filterLiveMembers(this.members, this.now, this.activeRejoinHashes(), extraProtected);
  }

  private filterDeny(): Record<string, number> {
    return filterLiveDenyList(this.deny, this.now);
  }

  private hasCreatorHostKey(): boolean {
    return this.creatorHostHash !== null;
  }

  private earliestUnjoinedDeadline(): number | null {
    let earliest: number | null = null;
    for (const s of this.unjoinedSockets) {
      const d = s.openedAt + 10_000;
      if (earliest === null || d < earliest) earliest = d;
    }
    return earliest;
  }

  private sweepStaleUnjoined(): void {
    for (let i = this.unjoinedSockets.length - 1; i >= 0; i--) {
      if (this.now - this.unjoinedSockets[i]!.openedAt >= 10_000) {
        this.unjoinedSockets.splice(i, 1);
      }
    }
  }

  private checkPasswordFailureRate(ip: string, now: number): boolean {
    const recent = (this.passwordFailures.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 20) {
      this.passwordFailures.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.passwordFailures.set(ip, recent);
    return true;
  }

  private creatorActivityCap(): number {
    if ([...this.peers.values()].some((p) => p.creatorHost)) {
      this.lastHostActiveAt = this.now;
      return this.now + EMPTY_ROOM_TTL_MS;
    }
    if (!this.hasCreatorHostKey()) {
      const baseline = this.lastHostActiveAt ?? this.now;
      if (this.lastHostActiveAt === undefined) this.lastHostActiveAt = baseline;
      return baseline + UNUSED_ROOM_TTL_MS;
    }
    if (this.everJoined) {
      const baseline = this.lastHostActiveAt ?? this.now;
      if (this.lastHostActiveAt === undefined) this.lastHostActiveAt = baseline;
      return baseline + EMPTY_ROOM_TTL_MS;
    }
    return Number.POSITIVE_INFINITY;
  }

  private syncAlarm(): void {
    if (!this.claimed) {
      this.alarmDeadline = null;
      return;
    }
    const earliestUnjoined = this.earliestUnjoinedDeadline();
    const occupied = this.peers.size > 0;
    if (!occupied) {
      this.hostGoneAt = undefined;
      if (this.emptySince === undefined) this.emptySince = this.now;
      this.alarmDeadline = computeNextAlarmDeadline({
        now: this.now,
        occupied: false,
        hasHost: false,
        hostGoneAt: undefined,
        emptySince: this.emptySince,
        sessionCleaned: this.sessionCleaned,
        everJoined: this.everJoined,
        lastHostActiveAt: this.lastHostActiveAt,
        hasCreatorHost: this.hasCreatorHostKey(),
        creatorCap: null,
        earliestUnjoinedDeadline: earliestUnjoined,
      });
      return;
    }
    const creatorCap = this.creatorActivityCap();
    const hasHost = [...this.peers.values()].some((p) => p.host);
    this.emptySince = undefined;
    this.sessionCleaned = false;
    if (hasHost) {
      this.hostGoneAt = undefined;
      this.alarmDeadline = computeNextAlarmDeadline({
        now: this.now,
        occupied: true,
        hasHost: true,
        hostGoneAt: undefined,
        emptySince: this.now,
        sessionCleaned: false,
        everJoined: true,
        lastHostActiveAt: undefined,
        hasCreatorHost: this.hasCreatorHostKey(),
        creatorCap,
        earliestUnjoinedDeadline: earliestUnjoined,
      });
      return;
    }
    if (this.hostGoneAt === undefined) this.hostGoneAt = this.now;
    this.alarmDeadline = computeNextAlarmDeadline({
      now: this.now,
      occupied: true,
      hasHost: false,
      hostGoneAt: this.hostGoneAt,
      emptySince: this.now,
      sessionCleaned: false,
      everJoined: true,
      lastHostActiveAt: undefined,
      hasCreatorHost: this.hasCreatorHostKey(),
      creatorCap,
      earliestUnjoinedDeadline: earliestUnjoined,
    });
  }

  private expireRoom(): void {
    this.claimed = false;
    this.peers.clear();
    this.unjoinedSockets.length = 0;
    this.members = {};
    this.deny = {};
    this.promotedHost = null;
    this.hostPromoted = false;
    this.locked = false;
    this.hostHash = null;
    this.emptySince = undefined;
    this.hostGoneAt = undefined;
    this.alarmDeadline = null;
  }

  private resetEmptySession(): void {
    const wasLocked = this.locked;
    const revokeLegacy = !this.hasCreatorHostKey() && (this.promotedHost !== null || this.hostPromoted);
    this.sweepStaleUnjoined();
    this.members = {};
    this.deny = {};
    this.promotedHost = null;
    this.hostGoneAt = undefined;
    this.hostPromoted = false;
    if (revokeLegacy) this.hostHash = null;
    if (this.creatorHostHash !== null) this.hostHash = this.creatorHostHash;
    this.locked = false;
    this.sessionCleaned = true;
    if (wasLocked) {
      this.password = generateRoomPassword();
      this.passwordHash = syncHashSecret(this.roomId, this.password, "password");
    }
  }

  private backfillUnjoinedLegacyCreatorHash(): boolean {
    if (this.peers.size > 0) return false;
    const canBackfill =
      this.creatorHostHash === null &&
      this.hostHash !== null &&
      !this.everJoined &&
      !this.sessionCleaned &&
      Object.keys(this.members).length === 0 &&
      this.promotedHost === null &&
      !this.hostPromoted;
    if (!canBackfill || this.hostHash === null) return false;
    this.creatorHostHash = this.hostHash;
    if (this.lastHostActiveAt === undefined) {
      this.lastHostActiveAt = this.emptySince ?? this.now;
    }
    return true;
  }

  private reconcileBeforeAdmit(): "expired" | "ok" {
    if (!this.claimed) return "ok";
    if (this.peers.size > 0) {
      const cap = this.creatorActivityCap();
      if (this.now >= cap) {
        this.expireRoom();
        return "expired";
      }
      return "ok";
    }
    if (this.emptySince === undefined) {
      this.emptySince = this.now;
      return "ok";
    }
    const expiry = computeCredentialExpiry(
      this.emptySince,
      this.everJoined,
      this.lastHostActiveAt,
      this.hasCreatorHostKey(),
    );
    if (this.now >= expiry) {
      this.expireRoom();
      return "expired";
    }
    if (!this.hasCreatorHostKey()) {
      const backfilled = this.backfillUnjoinedLegacyCreatorHash();
      if (!backfilled && this.lastHostActiveAt === undefined) {
        this.lastHostActiveAt = this.emptySince;
      }
    }
    if (!this.sessionCleaned && this.now - this.emptySince >= EMPTY_SESSION_CLEANUP_MS) {
      this.resetEmptySession();
    }
    return "ok";
  }

  openUnjoinedSocket(): void {
    this.unjoinedSockets.push({ id: this.nextUuid("unjoined"), openedAt: this.now });
    this.syncAlarm();
  }

  admitAndJoin(req: {
    name: string;
    ip: string;
    password?: string;
    hostToken?: string;
    rejoinToken?: string;
    resume?: boolean;
    sharing?: boolean;
  }): { ok: true; peer: SimClientPeer; password?: string } | { ok: false; code: string } {
    if (this.reconcileBeforeAdmit() === "expired") {
      return { ok: false, code: "bad-password" };
    }
    const offeredPasswordHash = req.password ? syncHashSecret(this.roomId, req.password, "password") : null;
    const offeredHostHash = req.hostToken ? syncHashSecret(this.roomId, req.hostToken, "host") : null;
    const offeredRejoinHash = req.rejoinToken ? syncHashSecret(this.roomId, req.rejoinToken, "rejoin") : null;
    const liveMembers = this.filterMembers();
    const liveDeny = this.filterDeny();
    const activeMatch =
      offeredRejoinHash !== null &&
      [...this.peers.values()].some((p) => p.rejoinHash === offeredRejoinHash);

    const decision = evaluateAdmission({
      claimed: this.claimed,
      storedRoomCode: this.roomCode,
      expectedPasswordHash: this.passwordHash,
      roomPassword: this.password,
      hostHash: this.hostHash,
      creatorHostHash: this.creatorHostHash,
      locked: this.locked,
      memberTicket: offeredRejoinHash !== null ? liveMembers[offeredRejoinHash] : undefined,
      denied: liveDeny[req.ip] !== undefined,
      msgRoom: this.roomCode,
      pathRoomCode: this.roomCode,
      offeredPasswordHash,
      offeredHostHash,
      hasActiveSocketMatch: activeMatch,
      checkPasswordFailureRate: () => this.checkPasswordFailureRate(req.ip, this.now),
    });
    if (!decision.ok) return { ok: false, code: decision.code };

    const superseded = [...this.peers.values()].filter(
      (p) =>
        (offeredRejoinHash !== null && p.rejoinHash === offeredRejoinHash) ||
        (decision.memberTicket?.id !== undefined && p.id === decision.memberTicket.id) ||
        (decision.isHost && p.host),
    );
    if (this.peers.size - superseded.length >= MAX_ROOM_SIZE) {
      return { ok: false, code: "room-full" };
    }

    const isResume = req.resume === true && decision.returning;
    const sup = superseded[0];
    const replacesId = sup?.id ?? decision.memberTicket?.id;
    const promo = evaluateJoinPromotion({
      admissionIsHost: decision.isHost,
      admissionReturning: decision.returning,
      supersededWasHost: sup?.host === true,
      replacesId,
      hasRawPromoted: this.promotedHost !== null,
      promoted: this.promotedHost,
    });
    if (promo.clearPromotedHost) this.promotedHost = null;
    if (promo.markHostPromoted) this.hostPromoted = true;

    const currentId = this.nextUuid("peer");
    const resumed = isResume
      ? resolveResumeAttachment({
          currentId,
          clientSharing: req.sharing,
          superseded: sup,
          memberTicket: decision.memberTicket,
          activePeerIds: new Set<string>(),
        })
      : { id: currentId, sharing: false };

    for (const oldPeer of superseded) {
      this.peers.delete(oldPeer.id);
      if (!isResume && oldPeer.rejoinHash) {
        delete liveMembers[oldPeer.rejoinHash];
      }
    }

    const newRejoinToken = this.nextUuid("rej");
    const newRejoinHash = syncHashSecret(this.roomId, newRejoinToken, "rejoin");
    if (offeredRejoinHash) delete liveMembers[offeredRejoinHash];
    for (const oldPeer of superseded) delete liveMembers[oldPeer.rejoinHash];

    const creatorHost =
      decision.isCreatorHost ||
      decision.memberTicket?.creatorHost === true ||
      sup?.creatorHost === true;
    const joinedAt = sup?.joinedAt ?? decision.memberTicket?.joinedAt ?? this.now;

    liveMembers[newRejoinHash] = {
      until: this.now + CONNECTED_TICKET_TTL_MS,
      id: resumed.id,
      ...(resumed.sharing ? { sharing: true } : {}),
      ip: req.ip,
      joinedAt,
      ...(creatorHost ? { creatorHost: true } : {}),
    };
    const protectedHashes = this.activeRejoinHashes();
    protectedHashes.add(newRejoinHash);
    this.members = capByExpiry(liveMembers, (m) => m.until, MAX_STORED_ENTRIES, protectedHashes);
    this.deny = capByExpiry(liveDeny, (u) => u, MAX_STORED_ENTRIES);
    this.everJoined = true;
    if (creatorHost) this.lastHostActiveAt = this.now;

    const peer: SimClientPeer = {
      id: resumed.id,
      ip: req.ip,
      name: req.name,
      sharing: resumed.sharing,
      host: promo.effectiveIsHost,
      creatorHost,
      openedAt: this.now,
      joinedAt,
      rejoinHash: newRejoinHash,
      rejoinToken: newRejoinToken,
      ...(promo.reissuedHostToken !== undefined
        ? { hostToken: promo.reissuedHostToken }
        : decision.isHost && req.hostToken
          ? { hostToken: req.hostToken }
          : {}),
    };
    this.peers.set(peer.id, peer);
    this.syncAlarm();
    const canSeePassword = promo.effectiveIsHost || !this.locked;
    return {
      ok: true,
      peer,
      ...(canSeePassword ? { password: this.password } : {}),
    };
  }

  disconnect(peerId: string, opts: { kicked?: boolean; skipSync?: boolean } = {}): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    if (!this.claimed) return;
    if (!opts.kicked) {
      const liveMembers = this.filterMembers(new Set([peer.rejoinHash]));
      const att: Pick<PeerAttachment, "id" | "sharing" | "ip" | "joinedAt" | "openedAt" | "creatorHost"> = {
        id: peer.id,
        sharing: peer.sharing,
        ip: peer.ip,
        joinedAt: peer.joinedAt,
        openedAt: peer.openedAt,
        creatorHost: peer.creatorHost,
      };
      liveMembers[peer.rejoinHash] = computeDisconnectTicket({
        now: this.now,
        attachment: att,
        existing: liveMembers[peer.rejoinHash],
      });
      this.members = capByExpiry(liveMembers, (m) => m.until, MAX_STORED_ENTRIES, this.activeRejoinHashes());
    }
    if (peer.creatorHost) this.lastHostActiveAt = this.now;
    if (!opts.skipSync) this.syncAlarm();
  }

  rotatePassword(opts: { purgeDisconnected: boolean }): Map<string, { password?: string; rejoinToken: string }> {
    const nextPassword = generateRoomPassword();
    const nextHash = syncHashSecret(this.roomId, nextPassword, "password");
    const liveMembers = this.filterMembers();
    const remainingActiveHashes = this.activeRejoinHashes();
    const nextMembers: Record<string, MemberEntry> = {};
    for (const [hash, entry] of Object.entries(liveMembers)) {
      if (opts.purgeDisconnected && !remainingActiveHashes.has(hash)) continue;
      nextMembers[hash] = {
        ...entry,
        until: Math.min(entry.until, this.now + ROTATION_REJOIN_GRACE_MS),
        rotationGrace: true,
      };
    }
    const protectedHashes = new Set<string>(remainingActiveHashes);
    const deliveries = new Map<string, { password?: string; rejoinToken: string }>();
    for (const peer of this.peers.values()) {
      const token = this.nextUuid("rej");
      const hash = syncHashSecret(this.roomId, token, "rejoin");
      nextMembers[hash] = {
        until: this.now + CONNECTED_TICKET_TTL_MS,
        id: peer.id,
        ...(peer.sharing ? { sharing: true } : {}),
        ip: peer.ip,
        joinedAt: peer.joinedAt,
        ...(peer.creatorHost ? { creatorHost: true } : {}),
      };
      protectedHashes.add(hash);
      peer.rejoinToken = token;
      peer.rejoinHash = hash;
      deliveries.set(peer.id, {
        ...(peer.host || !this.locked ? { password: nextPassword } : {}),
        rejoinToken: token,
      });
    }
    this.password = nextPassword;
    this.passwordHash = nextHash;
    this.members = capByExpiry(nextMembers, (m) => m.until, MAX_STORED_ENTRIES, protectedHashes);
    return deliveries;
  }

  kick(actorId: string, targetId: string): { ok: true; kickedIp: string; previousPassword: string } | { ok: false; code: string } {
    const actor = this.peers.get(actorId);
    if (!actor || !actor.host) return { ok: false, code: "not-host" };
    if (actorId === targetId) return { ok: false, code: "self" };
    const target = this.peers.get(targetId);
    if (!target) return { ok: false, code: "unknown-peer" };
    const previousPassword = this.password;
    const liveDeny = this.filterDeny();
    liveDeny[target.ip] = this.now + KICK_BAN_MS;
    this.deny = capByExpiry(liveDeny, (u) => u, MAX_STORED_ENTRIES);
    this.disconnect(targetId, { kicked: true, skipSync: true });
    this.rotatePassword({ purgeDisconnected: true });
    this.syncAlarm();
    return { ok: true, kickedIp: target.ip, previousPassword };
  }

  setLock(actorId: string, locked: boolean): { ok: boolean } {
    const actor = this.peers.get(actorId);
    if (!actor || !actor.host || !this.claimed) return { ok: false };
    this.locked = locked;
    return { ok: true };
  }

  setSharing(peerId: string, sharing: boolean): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.sharing = sharing;
    const member = this.members[peer.rejoinHash];
    if (member) member.sharing = sharing;
  }

  relayOffer(fromId: string, toId: string): { allowed: true } | { allowed: false; code: string } {
    const from = this.peers.get(fromId);
    const to = this.peers.get(toId);
    if (!from || !to) return { allowed: false, code: "unknown-peer" };
    return evaluateSignalRelay(from, to, "offer");
  }

  advanceTimeAndRunAlarm(deltaMs: number): void {
    this.now += deltaMs;
    if (!this.claimed) {
      this.alarmDeadline = null;
      return;
    }
    this.sweepStaleUnjoined();
    if (this.peers.size === 0) {
      if (this.emptySince === undefined) this.emptySince = this.now;
      const expiry = computeCredentialExpiry(
        this.emptySince,
        this.everJoined,
        this.lastHostActiveAt,
        this.hasCreatorHostKey(),
      );
      if (this.now >= expiry) {
        this.expireRoom();
        return;
      }
      if (!this.hasCreatorHostKey()) {
        const backfilled = this.backfillUnjoinedLegacyCreatorHash();
        if (!backfilled && this.lastHostActiveAt === undefined) {
          this.lastHostActiveAt = this.emptySince;
        }
      }
      if (!this.sessionCleaned && this.now - this.emptySince >= EMPTY_SESSION_CLEANUP_MS) {
        this.resetEmptySession();
      }
      this.syncAlarm();
      return;
    }

    const cap = this.creatorActivityCap();
    if (this.now >= cap) {
      this.expireRoom();
      return;
    }
    const hasHost = [...this.peers.values()].some((p) => p.host);
    if (hasHost) {
      this.hostGoneAt = undefined;
      this.syncAlarm();
      return;
    }
    if (this.hostGoneAt === undefined) {
      this.hostGoneAt = this.now;
      this.syncAlarm();
      return;
    }
    if (this.now - this.hostGoneAt < HOST_GRACE_MS) {
      this.syncAlarm();
      return;
    }

    const candidate = selectHostPromotionCandidate(
      [...this.peers.values()].map((p) => ({
        peer: p,
        att: { id: p.id, joinedAt: p.joinedAt, openedAt: p.openedAt },
      })),
    );
    if (!candidate) return;
    const newToken = this.nextUuid("promo-host");
    const newHash = syncHashSecret(this.roomId, newToken, "host");
    this.hostHash = newHash;
    this.promotedHost = { id: candidate.peer.id, token: newToken };
    this.hostPromoted = true;
    candidate.peer.host = true;
    candidate.peer.hostToken = newToken;
    this.hostGoneAt = undefined;
    this.syncAlarm();
  }
}

// ---------------------------------------------------------------------------
// Room Lifecycle Model + Commands (PR #52 12h / 15m / 90d + legacy + moderation)
// ---------------------------------------------------------------------------

type LegacyVariant = "modern" | "legacy-unjoined" | "legacy-joined";

interface RoomModel {
  expired: boolean;
  everJoined: boolean;
  locked: boolean;
  connectedIds: string[];
  hostIds: string[];
  emptySince: number | null;
  hostGoneAt: number | null;
  sessionCleaned: boolean;
  disconnectedTokens: Map<string, { ip: string; rejoinToken: string; issuedAt: number; rotatedAt?: number }>;
  kickedIps: Map<string, number>;
  leakedPreLockPasswords: string[];
  rotatedPasswords: string[];
  legacyVariant: LegacyVariant;
  promotedSinceLastReset: boolean;
}

type RoomCommand = fc.Command<RoomModel, VirtualRoomHarness>;

const IP_POOL = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4", "198.51.100.5"];

function syncHostGoneAt(m: RoomModel, now: number): void {
  if (m.connectedIds.length === 0 || m.hostIds.length > 0) {
    m.hostGoneAt = null;
  } else if (m.hostGoneAt === null) {
    m.hostGoneAt = now;
  }
}

function assertRoomInvariants(m: Readonly<RoomModel>, real: VirtualRoomHarness): void {
  assert.ok(real.peers.size <= MAX_ROOM_SIZE);
  assert.ok(Object.keys(real.members).length <= MAX_STORED_ENTRIES);
  assert.ok(Object.keys(real.deny).length <= MAX_STORED_ENTRIES);

  const actualHosts = [...real.peers.values()].filter((p) => p.host);
  assert.ok(actualHosts.length <= 1);
  assert.ok(m.hostIds.length <= 1);
  assert.deepEqual(
    actualHosts.map((p) => p.id),
    m.hostIds,
  );

  if (!real.claimed) {
    assert.equal(real.peers.size, 0);
    assert.equal(Object.keys(real.members).length, 0);
    assert.equal(Object.keys(real.deny).length, 0);
    assert.equal(real.alarmDeadline, null);
  } else {
    assert.equal(real.locked, m.locked);
    assert.equal(real.sessionCleaned, m.sessionCleaned);
    assert.notEqual(real.alarmDeadline, null);
  }
}

function syncModelAfterAlarm(
  m: RoomModel,
  real: VirtualRoomHarness,
  ctx: {
    wasEmpty: boolean;
    wasLocked: boolean;
    wasSessionCleaned: boolean;
    emptySinceBefore: number | null;
    hostGoneAtBefore: number | null;
    preEmptyPassword: string;
    hadNoHost: boolean;
  },
): void {
  if (!real.claimed) {
    m.expired = true;
    m.connectedIds = [];
    m.hostIds = [];
    m.locked = false;
    m.emptySince = null;
    m.hostGoneAt = null;
    m.sessionCleaned = false;
    m.disconnectedTokens.clear();
    m.kickedIps.clear();
    assertRoomInvariants(m, real);
    return;
  }

  const reachedEmptyCleanup =
    ctx.wasEmpty &&
    !ctx.wasSessionCleaned &&
    ctx.emptySinceBefore !== null &&
    real.now - ctx.emptySinceBefore >= EMPTY_SESSION_CLEANUP_MS;

  if (reachedEmptyCleanup) {
    m.sessionCleaned = true;
    m.locked = false;
    m.kickedIps.clear();
    m.disconnectedTokens.clear();
    if (ctx.wasLocked) {
      assert.notEqual(real.password, ctx.preEmptyPassword);
      m.leakedPreLockPasswords.push(ctx.preEmptyPassword);
    }
    if (real.creatorHostHash !== null) {
      assert.equal(real.hostHash, real.creatorHostHash);
    } else if (m.promotedSinceLastReset) {
      assert.equal(real.hostHash, null);
    }
    m.promotedSinceLastReset = false;
  }

  const reachedHostPromotion =
    ctx.hadNoHost &&
    ctx.hostGoneAtBefore !== null &&
    real.now - ctx.hostGoneAtBefore >= HOST_GRACE_MS &&
    real.peers.size > 0;

  if (reachedHostPromotion) {
    m.promotedSinceLastReset = true;
    m.hostIds = [...real.peers.values()].filter((p) => p.host).map((p) => p.id);
    m.hostGoneAt = null;
    assert.equal(m.hostIds.length, 1);
    assert.equal(real.locked, m.locked);
  }
  assertRoomInvariants(m, real);
}

class JoinCreatorCommand implements RoomCommand {
  readonly usePassword: boolean;
  constructor(usePassword: boolean) {
    this.usePassword = usePassword;
  }
  check = (m: Readonly<RoomModel>): boolean => !m.expired && m.connectedIds.length < MAX_ROOM_SIZE;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const prevFailureCount = real.passwordFailures.get("198.51.100.1")?.length ?? 0;
    const prevLastActive = real.lastHostActiveAt;
    const res = real.admitAndJoin({
      name: "creator",
      ip: "198.51.100.1",
      hostToken: real.creatorHostToken,
      ...(this.usePassword ? { password: real.password } : {}),
    });
    if (!real.claimed) {
      assert.deepEqual(res, { ok: false, code: "bad-password" });
      assert.equal(real.passwordFailures.get("198.51.100.1")?.length ?? 0, prevFailureCount);
      m.expired = true;
      m.connectedIds = [];
      m.hostIds = [];
      m.locked = false;
      m.emptySince = null;
      m.hostGoneAt = null;
      m.sessionCleaned = false;
      m.disconnectedTokens.clear();
      m.kickedIps.clear();
      assertRoomInvariants(m, real);
      return;
    }
    if (!res.ok) {
      if (m.locked) {
        assert.ok(res.code === "room-locked" || res.code === "bad-password" || res.code === "rate-limited");
      }
      assertRoomInvariants(m, real);
      return;
    }
    m.everJoined = true;
    m.emptySince = null;
    m.sessionCleaned = false;
    m.connectedIds = [...real.peers.keys()];
    m.hostIds = [...real.peers.values()].filter((p) => p.host).map((p) => p.id);
    syncHostGoneAt(m, real.now);
    if (!m.promotedSinceLastReset && real.creatorHostHash !== null) {
      assert.equal(res.peer.host, true);
      assert.equal(res.password, real.password);
    } else if (m.promotedSinceLastReset && real.creatorHostHash !== null) {
      assert.equal(res.peer.creatorHost, true);
      assert.equal(res.peer.host, false);
    } else if (real.creatorHostHash === null) {
      // Joined legacy room without CREATOR_HOST_KEY: creatorHost stays false and lastHostActiveAt
      // anchors once without sliding on subsequent visits.
      assert.equal(res.peer.creatorHost, false);
      if (prevLastActive !== undefined) {
        assert.equal(real.lastHostActiveAt, prevLastActive);
      }
    }
    assertRoomInvariants(m, real);
  }
  toString = (): string => `JoinCreator(usePassword=${String(this.usePassword)})`;
}

class JoinGuestCommand implements RoomCommand {
  readonly ipIdx: number;
  constructor(ipIdx: number) {
    this.ipIdx = ipIdx;
  }
  check = (m: Readonly<RoomModel>): boolean => !m.expired && m.connectedIds.length < MAX_ROOM_SIZE;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const prevLastActive = real.lastHostActiveAt;
    const ip = IP_POOL[this.ipIdx % IP_POOL.length] ?? "198.51.100.2";
    const res = real.admitAndJoin({ name: `guest-${String(this.ipIdx)}`, ip, password: real.password });
    const banUntil = m.kickedIps.get(ip);
    const isBanned = banUntil !== undefined && banUntil > real.now;
    if (!real.claimed) {
      assert.deepEqual(res, { ok: false, code: "bad-password" });
      m.expired = true;
      m.connectedIds = [];
      m.hostIds = [];
      m.locked = false;
      m.emptySince = null;
      m.hostGoneAt = null;
      m.sessionCleaned = false;
      m.disconnectedTokens.clear();
      m.kickedIps.clear();
    } else if (m.locked) {
      assert.deepEqual(res, { ok: false, code: "room-locked" });
    } else if (isBanned) {
      assert.deepEqual(res, { ok: false, code: "kicked" });
    } else {
      assert.equal(res.ok, true);
      if (res.ok) {
        assert.equal(res.peer.host, false);
        // Guest admission must not advance creator's lastHostActiveAt once established
        if (prevLastActive !== undefined) {
          assert.equal(real.lastHostActiveAt, prevLastActive);
        }
        m.everJoined = true;
        m.emptySince = null;
        m.sessionCleaned = false;
        m.connectedIds = [...real.peers.keys()];
        syncHostGoneAt(m, real.now);
      }
    }
    assertRoomInvariants(m, real);
  }
  toString = (): string => `JoinGuest(${String(this.ipIdx)})`;
}

class OpenUnjoinedPreemptCommand implements RoomCommand {
  check = (m: Readonly<RoomModel>): boolean => !m.expired;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const hadNoHost = real.peers.size > 0 && m.hostIds.length === 0;
    const wasEmpty = real.peers.size === 0;
    const wasLocked = real.locked;
    const wasSessionCleaned = m.sessionCleaned;
    const emptySinceBefore = m.emptySince;
    const hostGoneAtBefore = m.hostGoneAt;
    const preEmptyPassword = real.password;

    real.openUnjoinedSocket();
    assert.ok(real.alarmDeadline !== null && real.alarmDeadline <= real.now + 10_000);
    real.advanceTimeAndRunAlarm(10_000);
    assert.equal(real.unjoinedSockets.length, 0);
    syncModelAfterAlarm(m, real, {
      wasEmpty,
      wasLocked,
      wasSessionCleaned,
      emptySinceBefore,
      hostGoneAtBefore,
      preEmptyPassword,
      hadNoHost,
    });
  }
  toString = (): string => "OpenUnjoinedPreempt()";
}

class FloodMembersCapCommand implements RoomCommand {
  check = (m: Readonly<RoomModel>): boolean => !m.expired;
  run(_m: RoomModel, real: VirtualRoomHarness): void {
    const activeHashes = new Set([...real.peers.values()].map((p) => p.rejoinHash));
    const injected: Record<string, MemberEntry> = { ...real.members };
    for (let i = 0; i < MAX_STORED_ENTRIES + 24; i++) {
      injected[`synth-${String(real.now)}-${String(i)}`] = {
        until: real.now + 1000 + i,
        id: `synth-${String(i)}`,
        ip: "198.51.100.250",
        joinedAt: real.now,
      };
    }
    real.members = capByExpiry(injected, (e) => e.until, MAX_STORED_ENTRIES, activeHashes);
    assert.ok(Object.keys(real.members).length <= MAX_STORED_ENTRIES);
    for (const h of activeHashes) {
      assert.ok(real.members[h] !== undefined);
    }
  }
  toString = (): string => "FloodMembersCap()";
}

class JoinWithStaleSecretCommand implements RoomCommand {
  readonly usePreLock: boolean;
  constructor(usePreLock: boolean) {
    this.usePreLock = usePreLock;
  }
  check = (m: Readonly<RoomModel>): boolean =>
    !m.expired && (this.usePreLock ? m.leakedPreLockPasswords.length > 0 : m.rotatedPasswords.length > 0);
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const pool = this.usePreLock ? m.leakedPreLockPasswords : m.rotatedPasswords;
    const staleSecret = pool[pool.length - 1];
    if (!staleSecret || staleSecret === real.password) return;
    const recentFailures = (real.passwordFailures.get("198.51.100.99") ?? []).filter(
      (t) => real.now - t < 60_000,
    ).length;
    const res = real.admitAndJoin({ name: "eve", ip: "198.51.100.99", password: staleSecret });
    assert.deepEqual(res, { ok: false, code: recentFailures >= 20 ? "rate-limited" : "bad-password" });
    assertRoomInvariants(m, real);
  }
  toString = (): string => `JoinWithStaleSecret(preLock=${String(this.usePreLock)})`;
}

class DisconnectPeerCommand implements RoomCommand {
  readonly idx: number;
  constructor(idx: number) {
    this.idx = idx;
  }
  check = (m: Readonly<RoomModel>): boolean => !m.expired && m.connectedIds.length > 0;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const targetId = m.connectedIds[this.idx % m.connectedIds.length];
    if (!targetId) return;
    const peer = real.peers.get(targetId);
    if (!peer) return;
    m.disconnectedTokens.set(peer.id, {
      ip: peer.ip,
      rejoinToken: peer.rejoinToken,
      issuedAt: real.now,
    });
    real.disconnect(peer.id);
    m.connectedIds = [...real.peers.keys()];
    m.hostIds = [...real.peers.values()].filter((p) => p.host).map((p) => p.id);
    if (m.connectedIds.length === 0) {
      m.emptySince = real.now;
      m.sessionCleaned = false;
    }
    syncHostGoneAt(m, real.now);
    assertRoomInvariants(m, real);
  }
  toString = (): string => `DisconnectPeer(${String(this.idx)})`;
}

class ReconnectResumeCommand implements RoomCommand {
  readonly idx: number;
  constructor(idx: number) {
    this.idx = idx;
  }
  check = (m: Readonly<RoomModel>): boolean => !m.expired && m.disconnectedTokens.size > 0;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const entries = [...m.disconnectedTokens.entries()];
    const chosen = entries[this.idx % entries.length];
    if (!chosen) return;
    const [peerId, ticket] = chosen;
    const res = real.admitAndJoin({
      name: "resumer",
      ip: ticket.ip,
      rejoinToken: ticket.rejoinToken,
      resume: true,
    });
    const expiredNormally = real.now - ticket.issuedAt >= DISCONNECTED_REJOIN_TTL_MS;
    const expiredGrace = ticket.rotatedAt !== undefined && real.now - ticket.rotatedAt >= ROTATION_REJOIN_GRACE_MS;
    if (real.claimed && (expiredNormally || expiredGrace)) {
      assert.equal(res.ok, false);
    }
    if (res.ok) {
      m.emptySince = null;
      m.sessionCleaned = false;
      m.disconnectedTokens.delete(peerId);
      m.connectedIds = [...real.peers.keys()];
      m.hostIds = [...real.peers.values()].filter((p) => p.host).map((p) => p.id);
      syncHostGoneAt(m, real.now);
      if (m.locked && !res.peer.host) {
        assert.equal(res.password, undefined);
      }
    }
    assertRoomInvariants(m, real);
  }
  toString = (): string => `ReconnectResume(${String(this.idx)})`;
}

class ToggleLockCommand implements RoomCommand {
  readonly locked: boolean;
  constructor(locked: boolean) {
    this.locked = locked;
  }
  check = (m: Readonly<RoomModel>): boolean => !m.expired && m.hostIds.length === 1;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const hostId = m.hostIds[0];
    if (!hostId) return;
    const res = real.setLock(hostId, this.locked);
    assert.equal(res.ok, true);
    m.locked = this.locked;
    if (this.locked && !m.leakedPreLockPasswords.includes(real.password)) {
      m.leakedPreLockPasswords.push(real.password);
    }
    assertRoomInvariants(m, real);
  }
  toString = (): string => `ToggleLock(${String(this.locked)})`;
}

class RotateSecretCommand implements RoomCommand {
  check = (m: Readonly<RoomModel>): boolean => !m.expired && m.hostIds.length === 1;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const oldPassword = real.password;
    m.rotatedPasswords.push(oldPassword);
    const deliveries = real.rotatePassword({ purgeDisconnected: false });
    for (const [id, msg] of deliveries) {
      const peer = real.peers.get(id);
      if (m.locked && peer && !peer.host) {
        assert.equal(msg.password, undefined);
      } else {
        assert.equal(msg.password, real.password);
      }
    }
    for (const ticket of m.disconnectedTokens.values()) {
      ticket.rotatedAt = ticket.rotatedAt ?? real.now;
    }
    assertRoomInvariants(m, real);
  }
  toString = (): string => "RotateSecret()";
}

class KickPeerCommand implements RoomCommand {
  readonly idx: number;
  constructor(idx: number) {
    this.idx = idx;
  }
  check = (m: Readonly<RoomModel>): boolean => !m.expired && m.hostIds.length === 1 && m.connectedIds.length > 1;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const hostId = m.hostIds[0];
    const nonHosts = m.connectedIds.filter((id) => id !== hostId);
    const targetId = nonHosts[this.idx % nonHosts.length];
    if (!hostId || !targetId) return;
    const res = real.kick(hostId, targetId);
    assert.equal(res.ok, true);
    if (res.ok) {
      m.rotatedPasswords.push(res.previousPassword);
      m.kickedIps.set(res.kickedIp, real.now + KICK_BAN_MS);
      m.disconnectedTokens.clear();
      m.connectedIds = [...real.peers.keys()];
      m.hostIds = [...real.peers.values()].filter((p) => p.host).map((p) => p.id);
      const retry = real.admitAndJoin({ name: "kicked", ip: res.kickedIp, password: real.password });
      assert.deepEqual(retry, { ok: false, code: m.locked ? "room-locked" : "kicked" });
    }
    assertRoomInvariants(m, real);
  }
  toString = (): string => `KickPeer(${String(this.idx)})`;
}

class ToggleShareAndRelayCommand implements RoomCommand {
  readonly idxA: number;
  readonly idxB: number;
  readonly sharingA: boolean;
  constructor(idxA: number, idxB: number, sharingA: boolean) {
    this.idxA = idxA;
    this.idxB = idxB;
    this.sharingA = sharingA;
  }
  check = (m: Readonly<RoomModel>): boolean => !m.expired && m.connectedIds.length >= 2;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const idA = m.connectedIds[this.idxA % m.connectedIds.length];
    const idB = m.connectedIds[this.idxB % m.connectedIds.length];
    if (!idA || !idB || idA === idB) return;
    real.setSharing(idA, this.sharingA);
    const peerA = real.peers.get(idA)!;
    const peerB = real.peers.get(idB)!;
    const relay = real.relayOffer(idA, idB);
    if (!peerA.sharing && !peerB.sharing) {
      assert.equal(relay.allowed, false);
      if (!relay.allowed) assert.equal(relay.code, "not-sharing");
    } else {
      assert.deepEqual(relay, { allowed: true });
    }
    assertRoomInvariants(m, real);
  }
  toString = (): string => `ToggleShareAndRelay(${String(this.idxA)},${String(this.idxB)},${String(this.sharingA)})`;
}

class AdvanceClockAlarmCommand implements RoomCommand {
  readonly step: "host-grace" | "empty-15m" | "unused-12h" | "cap-90d";
  constructor(step: "host-grace" | "empty-15m" | "unused-12h" | "cap-90d") {
    this.step = step;
  }
  check = (m: Readonly<RoomModel>): boolean => !m.expired;
  run(m: RoomModel, real: VirtualRoomHarness): void {
    const hadNoHost = real.peers.size > 0 && m.hostIds.length === 0;
    const wasEmpty = real.peers.size === 0;
    const wasLocked = real.locked;
    const wasSessionCleaned = m.sessionCleaned;
    const emptySinceBefore = m.emptySince;
    const hostGoneAtBefore = m.hostGoneAt;
    const preEmptyPassword = real.password;

    const delta =
      this.step === "host-grace"
        ? HOST_GRACE_MS + 1000
        : this.step === "empty-15m"
          ? EMPTY_SESSION_CLEANUP_MS + 1000
          : this.step === "unused-12h"
            ? UNUSED_ROOM_TTL_MS + 1000
            : EMPTY_ROOM_TTL_MS + 1000;

    real.advanceTimeAndRunAlarm(delta);
    syncModelAfterAlarm(m, real, {
      wasEmpty,
      wasLocked,
      wasSessionCleaned,
      emptySinceBefore,
      hostGoneAtBefore,
      preEmptyPassword,
      hadNoHost,
    });
  }
  toString = (): string => `AdvanceClockAlarm(${this.step})`;
}

// ---------------------------------------------------------------------------
// Stateful Mesh + SignalingClient Harness
// ---------------------------------------------------------------------------

class FakeRtcSender {
  track: MediaStreamTrack | null;
  private params: RTCRtpSendParameters;
  constructor(track: MediaStreamTrack | null) {
    this.track = track;
    this.params = {
      encodings: [{ active: true }],
      transactionId: "0",
      codecs: [],
      headerExtensions: [],
      rtcp: {},
    };
  }
  getParameters(): RTCRtpSendParameters {
    return structuredClone(this.params);
  }
  async setParameters(next: RTCRtpSendParameters): Promise<void> {
    this.params = structuredClone(next);
  }
  async replaceTrack(next: MediaStreamTrack | null): Promise<void> {
    this.track = next;
  }
}

class FakeRtcPeerConnection {
  connectionState: RTCPeerConnectionState = "connected";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly transceivers: Array<{ direction: RTCRtpTransceiverDirection; sender: FakeRtcSender; setCodecPreferences: () => void }> = [];
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((ev: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((ev: { channel: unknown }) => void) | null = null;

  createDataChannel(): { readyState: string; onopen: null; onmessage: null; send: () => void; close: () => void } {
    return { readyState: "open", onopen: null, onmessage: null, send: () => {}, close: () => {} };
  }
  addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit): unknown {
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const tx = {
      direction: init?.direction ?? "sendonly",
      sender: new FakeRtcSender(track),
      setCodecPreferences: () => {},
    };
    this.transceivers.push(tx);
    return tx;
  }
  getTransceivers(): unknown[] {
    return this.transceivers;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const mLines = this.transceivers.map((tx) => `m=${tx.sender.track?.kind ?? "audio"} 9 UDP/TLS/RTP/SAVPF 96`).join("\r\n");
    return { type: "offer", sdp: `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n${mLines}\r\n` };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return this.createOffer();
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
  }
  async addIceCandidate(): Promise<void> {}
  restartIce(): void {}
  close(): void {
    this.connectionState = "closed";
    this.signalingState = "closed";
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

interface MeshHarness {
  mesh: Mesh;
  signals: Array<{ to: string; data: SignalData }>;
  reemitted: string[];
  allPcs: FakeRtcPeerConnection[];
  peers: string[];
}

interface MeshModel {
  localSharing: boolean;
  withAudio: boolean;
  degradation: "framerate" | "clarity";
  peers: Map<string, boolean>;
  remoteStreams: Set<string>;
}

function makeFakeCapture(tag: string, withAudio: boolean): CaptureResult {
  const video = { kind: "video", contentHint: "motion", stop: () => {} } as unknown as MediaStreamTrack;
  const audio = withAudio
    ? ({ kind: "audio", contentHint: "music", stop: () => {} } as unknown as MediaStreamTrack)
    : null;
  const stream = {
    id: `stream-${tag}`,
    getVideoTracks: () => [video],
    getAudioTracks: () => (audio ? [audio] : []),
    getTracks: () => (audio ? [video, audio] : [video]),
  } as unknown as MediaStream;
  return { stream, video, audio };
}

function assertMeshInvariants(m: Readonly<MeshModel>, real: MeshHarness): void {
  const activeLinks = real.mesh.peers();
  for (const [peerId, remoteSharing] of m.peers) {
    const hasLink = activeLinks.includes(peerId);
    if (!m.localSharing && !remoteSharing) {
      assert.equal(hasLink, false);
    }
    if (hasLink) {
      const pc = real.mesh.getConnection(peerId) as unknown as FakeRtcPeerConnection | undefined;
      assert.ok(pc !== undefined);
      assert.ok(pc.transceivers.length <= 2);
      const mLineCount = (pc.localDescription?.sdp?.match(/^m=/gm) ?? []).length;
      assert.ok(mLineCount <= 3);
      if (m.localSharing && pc.transceivers.length > 0) {
        assert.equal(pc.transceivers[0]?.sender.track?.contentHint, "motion");
        const expectedDegrad =
          m.degradation === "clarity" ? "maintain-framerate-and-resolution" : "maintain-framerate";
        assert.equal(pc.transceivers[0]?.sender.getParameters().degradationPreference, expectedDegrad);
      }
      if (!m.localSharing && pc.transceivers.length > 0) {
        assert.equal(pc.transceivers[0]?.sender.track, null);
      }
    }
  }
  const activeSet = new Set(activeLinks);
  for (const pc of real.allPcs) {
    const stillActive = [...activeSet].some((id) => (real.mesh.getConnection(id) as unknown) === pc);
    if (!stillActive) assert.equal(pc.connectionState, "closed");
  }
  if (!m.localSharing && [...m.peers.values()].every((s) => !s)) {
    assert.equal(activeLinks.length, 0);
  }
}

describe("Stateful Model-Based Invariants: RoomDO Multi-Tier Lifecycle & Client Mesh/Signaling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies PR #52 12h/15m/90d lifecycle, promotion, lock/unlock, kick+rotate, and legacy rules across 50-step command sequences", () => {
    const cmds = [
      fc.boolean().map((usePw) => new JoinCreatorCommand(usePw)),
      fc.integer({ min: 0, max: 4 }).map((i) => new JoinGuestCommand(i)),
      fc.constant(new OpenUnjoinedPreemptCommand()),
      fc.constant(new FloodMembersCapCommand()),
      fc.boolean().map((preLock) => new JoinWithStaleSecretCommand(preLock)),
      fc.integer({ min: 0, max: 9 }).map((i) => new DisconnectPeerCommand(i)),
      fc.integer({ min: 0, max: 9 }).map((i) => new ReconnectResumeCommand(i)),
      fc.boolean().map((locked) => new ToggleLockCommand(locked)),
      fc.constant(new RotateSecretCommand()),
      fc.integer({ min: 0, max: 9 }).map((i) => new KickPeerCommand(i)),
      fc.tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 }), fc.boolean()).map(
        ([a, b, s]) => new ToggleShareAndRelayCommand(a, b, s),
      ),
      fc.constantFrom("host-grace" as const, "empty-15m" as const, "unused-12h" as const, "cap-90d" as const).map(
        (step) => new AdvanceClockAlarmCommand(step),
      ),
    ];

    let totalRuns = 0;
    fc.assert(
      fc.property(
        fc.constantFrom<LegacyVariant>("modern", "legacy-unjoined", "legacy-joined"),
        fc.commands(cmds, { maxCommands: 50 }),
        (legacyVariant, seq) => {
          totalRuns += 1;
          const real = new VirtualRoomHarness({
            legacy: legacyVariant !== "modern",
            legacyJoined: legacyVariant === "legacy-joined",
          });
          const model: RoomModel = {
            expired: false,
            everJoined: legacyVariant === "legacy-joined",
            locked: false,
            connectedIds: [],
            hostIds: [],
            emptySince: real.now,
            hostGoneAt: null,
            sessionCleaned: legacyVariant === "legacy-joined",
            disconnectedTokens: new Map(),
            kickedIps: new Map(),
            leakedPreLockPasswords: [],
            rotatedPasswords: [],
            legacyVariant,
            promotedSinceLastReset: false,
          };
          fc.modelRun(() => ({ model, real }), seq);
        },
      ),
      { numRuns: 150 },
    );
    expect(totalRuns).toBe(150);

    // Deterministic regression 1: creator joins, locks, disconnects, then 3x host-grace steps (301s each = 903s >= 15m)
    // must trigger cumulative empty-session cleanup (unlock + secret rotation) in both harness and model.
    const regReal = new VirtualRoomHarness();
    const regModel: RoomModel = {
      expired: false,
      everJoined: false,
      locked: false,
      connectedIds: [],
      hostIds: [],
      emptySince: regReal.now,
      hostGoneAt: null,
      sessionCleaned: false,
      disconnectedTokens: new Map(),
      kickedIps: new Map(),
      leakedPreLockPasswords: [],
      rotatedPasswords: [],
      legacyVariant: "modern",
      promotedSinceLastReset: false,
    };
    const preLockPassword = regReal.password;
    for (const cmd of [
      new JoinCreatorCommand(true),
      new ToggleLockCommand(true),
      new DisconnectPeerCommand(0),
      new AdvanceClockAlarmCommand("host-grace"),
      new AdvanceClockAlarmCommand("host-grace"),
      new AdvanceClockAlarmCommand("host-grace"),
    ]) {
      assert.equal(cmd.check(regModel), true);
      cmd.run(regModel, regReal);
    }
    expect(regReal.locked).toBe(false);
    expect(regModel.locked).toBe(false);
    expect(regModel.sessionCleaned).toBe(true);
    expect(regReal.password).not.toBe(preLockPassword);

    // Deterministic regression 2: creator + guest join, creator leaves, then 30x 10s unjoined-socket alarms
    // reach cumulative HOST_GRACE_MS (300s) and promote guest; returning creator stays non-host creatorHost.
    const promoReal = new VirtualRoomHarness();
    const promoModel: RoomModel = {
      expired: false,
      everJoined: false,
      locked: false,
      connectedIds: [],
      hostIds: [],
      emptySince: promoReal.now,
      hostGoneAt: null,
      sessionCleaned: false,
      disconnectedTokens: new Map(),
      kickedIps: new Map(),
      leakedPreLockPasswords: [],
      rotatedPasswords: [],
      legacyVariant: "modern",
      promotedSinceLastReset: false,
    };
    const promoSeq: RoomCommand[] = [
      new JoinCreatorCommand(true),
      new JoinGuestCommand(1),
      new DisconnectPeerCommand(0),
      ...Array.from({ length: 30 }, () => new OpenUnjoinedPreemptCommand()),
      new JoinCreatorCommand(true),
    ];
    for (const cmd of promoSeq) {
      assert.equal(cmd.check(promoModel), true);
      cmd.run(promoModel, promoReal);
    }
    expect(promoModel.promotedSinceLastReset).toBe(true);
    expect(promoModel.hostIds).toHaveLength(1);
    expect(promoModel.hostGoneAt).toBeNull();
  });

  it("verifies partial-mesh zero-idle-link, bounded-transceiver, reemit, and degradation invariants across randomized Mesh command sequences", async () => {
    vi.stubGlobal("RTCPeerConnection", FakeRtcPeerConnection);
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: () => { codecs: unknown[] } } }).RTCRtpSender = {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }),
    };

    const peerIds = ["peer-0001", "peer-0002", "peer-0003"];
    const meshCmds = [
      fc.boolean().map((withAudio): fc.AsyncCommand<MeshModel, MeshHarness> => ({
        check: () => true,
        async run(m, real) {
          m.localSharing = true;
          m.withAudio = withAudio;
          await real.mesh.setCapture(makeFakeCapture("local", withAudio));
          const latestPcs = peerIds
            .map((id) => real.mesh.getConnection(id) as unknown as FakeRtcPeerConnection | undefined)
            .filter((pc): pc is FakeRtcPeerConnection => pc !== undefined);
          for (const pc of latestPcs) {
            if (!real.allPcs.includes(pc)) real.allPcs.push(pc);
          }
          assertMeshInvariants(m, real);
        },
        toString: () => `StartLocalShare(audio=${String(withAudio)})`,
      })),
      fc.constant<fc.AsyncCommand<MeshModel, MeshHarness>>({
        check: (m) => m.localSharing,
        async run(m, real) {
          m.localSharing = false;
          await real.mesh.setCapture(null);
          assertMeshInvariants(m, real);
        },
        toString: () => "StopLocalShare()",
      }),
      fc.constantFrom("framerate" as const, "clarity" as const).map(
        (mode): fc.AsyncCommand<MeshModel, MeshHarness> => ({
          check: () => true,
          async run(m, real) {
            m.degradation = mode;
            await real.mesh.setDegradation(mode);
            assertMeshInvariants(m, real);
          },
          toString: () => `SetDegradation(${mode})`,
        }),
      ),
      fc.tuple(fc.integer({ min: 0, max: 2 }), fc.boolean()).map(
        ([idx, sharing]): fc.AsyncCommand<MeshModel, MeshHarness> => ({
          check: () => true,
          async run(m, real) {
            const peerId = peerIds[idx]!;
            const prev = m.peers.get(peerId) === true;
            m.peers.set(peerId, sharing);
            const preReemit = real.reemitted.length;
            real.mesh.setMemberSharing(peerId, sharing);
            if (sharing && !real.mesh.getConnection(peerId)) {
              await real.mesh.handleSignal(peerId, {
                k: "offer",
                sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
              });
              const pc = real.mesh.getConnection(peerId) as unknown as FakeRtcPeerConnection | undefined;
              if (pc && !real.allPcs.includes(pc)) real.allPcs.push(pc);
              if (pc?.ontrack && !m.remoteStreams.has(peerId)) {
                const track = { kind: "video", addEventListener: () => {} } as unknown as MediaStreamTrack;
                pc.ontrack({
                  track,
                  streams: [{ id: `remote-${peerId}` } as unknown as MediaStream],
                  receiver: {} as RTCRtpReceiver,
                } as unknown as RTCTrackEvent);
                m.remoteStreams.add(peerId);
              }
            } else if (!prev && sharing && m.remoteStreams.has(peerId) && real.mesh.getConnection(peerId)) {
              assert.equal(real.reemitted.length, preReemit + 1);
            }
            if (!sharing && !m.localSharing) m.remoteStreams.delete(peerId);
            assertMeshInvariants(m, real);
          },
          toString: () => `SetRemoteSharing(${peerIds[idx]},${String(sharing)})`,
        }),
      ),
      fc.integer({ min: 0, max: 2 }).map((idx): fc.AsyncCommand<MeshModel, MeshHarness> => ({
        check: (m) => !m.localSharing && m.peers.get(peerIds[idx]!) !== true,
        async run(m, real) {
          const peerId = peerIds[idx]!;
          await real.mesh.handleSignal(peerId, {
            k: "offer",
            sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
          });
          assert.equal(real.mesh.getConnection(peerId), undefined);
          assertMeshInvariants(m, real);
        },
        toString: () => `RejectViewerOffer(${peerIds[idx]})`,
      })),
    ];

    let totalRuns = 0;
    await fc.assert(
      fc.asyncProperty(fc.commands(meshCmds, { maxCommands: 30 }), async (seq) => {
        totalRuns += 1;
        const signals: Array<{ to: string; data: SignalData }> = [];
        const reemitted: string[] = [];
        const allPcs: FakeRtcPeerConnection[] = [];
        const opts: MeshOptions = {
          iceServers: [{ urls: "stun:stun.example.com" }],
          preset: { label: "1080p60", width: 1920, height: 1080, frameRate: 60, maxBitrate: 12_000_000 },
          codec: "h264",
          degradation: "framerate",
          jitterBufferTargetMs: 0,
        };
        const cb: MeshCallbacks = {
          onRemoteStream: (peerId) => reemitted.push(peerId),
          onRemoteStreamGone: () => {},
          onConnectionState: () => {},
        };
        const mesh = new Mesh("peer-0000", opts, (to, data) => signals.push({ to, data }), cb);
        for (const id of peerIds) mesh.addMember(id, false);
        const real: MeshHarness = { mesh, signals, reemitted, allPcs, peers: peerIds };
        const model: MeshModel = {
          localSharing: false,
          withAudio: false,
          degradation: "framerate",
          peers: new Map(peerIds.map((id) => [id, false])),
          remoteStreams: new Set(),
        };
        try {
          await fc.asyncModelRun(() => ({ model, real }), seq);
        } finally {
          mesh.close();
        }
      }),
      { numRuns: 75 },
    );
    expect(totalRuns).toBe(75);
  });

  it("verifies SignalingClient fatal close codes, retry caps, pending queue, and cross-selfId suppression", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "https:", host: "screenshare.example" });
    const events: string[] = [];
    const welcomes: RoomInfo[] = [];

    interface SigModel {
      fatal: boolean;
      welcomed: boolean;
      closed: boolean;
      capRefusals: number;
      initAttempts: number;
      selfId: string | null;
      pendingSignals: number;
      pendingStates: number;
    }

    const sigCmds = [
      fc.constantFrom("self-A", "self-B").map((nextSelfId): fc.Command<SigModel, SignalingClient> => ({
        check: (m) => !m.fatal && !m.closed,
        run(m, real) {
          const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
          if (!ws || ws.readyState === FakeWebSocket.CLOSED) return;
          if (ws.readyState === FakeWebSocket.CONNECTING) {
            ws.readyState = FakeWebSocket.OPEN;
            ws.onopen?.();
          }
          const sentBefore = ws.sent.length;
          ws.onmessage?.({
            data: JSON.stringify({
              t: "welcome",
              selfId: nextSelfId,
              peers: [],
              host: true,
              locked: false,
              rejoinToken: "rej-1",
            }),
          });
          const flushed = ws.sent.slice(sentBefore).map((s) => JSON.parse(s) as { t: string });
          const sameSelf = m.selfId === null || m.selfId === nextSelfId;
          const sigFlushed = flushed.filter((x) => x.t === "signal").length;
          if (!sameSelf) {
            assert.equal(sigFlushed, 0);
          } else {
            assert.equal(sigFlushed, m.pendingSignals);
          }
          assert.equal(flushed.filter((x) => x.t === "state").length, m.pendingStates);
          m.selfId = nextSelfId;
          m.welcomed = true;
          m.capRefusals = 0;
          m.initAttempts = 0;
          m.pendingSignals = 0;
          m.pendingStates = 0;
          assert.equal(real.isReady, true);
        },
        toString: () => `Welcome(${nextSelfId})`,
      })),
      fc.constantFrom("bad-password", "kicked", "room-locked", "session-replaced").map(
        (code): fc.Command<SigModel, SignalingClient> => ({
          check: (m) => !m.fatal && !m.closed,
          run(m, real) {
            const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
            if (!ws || ws.readyState === FakeWebSocket.CLOSED) return;
            ws.onmessage?.({ data: JSON.stringify({ t: "error", code, message: code }) });
            ws.close(1008, code);
            m.fatal = true;
            assert.equal(real.isFatal, true);
            assert.equal(real.isReady, false);
          },
          toString: () => `FatalError(${code})`,
        }),
      ),
      fc.constant<fc.Command<SigModel, SignalingClient>>({
        check: (m) => !m.fatal && !m.closed,
        run(m, real) {
          const prevCount = FakeWebSocket.instances.length;
          const ws = FakeWebSocket.instances[prevCount - 1];
          if (!ws || ws.readyState === FakeWebSocket.CLOSED) return;
          ws.close(1013, "room-full");
          m.capRefusals += 1;
          if (m.capRefusals > 5) {
            m.fatal = true;
            assert.equal(real.isFatal, true);
          } else {
            assert.equal(real.isFatal, false);
            if (!m.welcomed) m.initAttempts += 1;
            // Max reconnect delay is 15_000 * 1.3 = 19_500ms; advance 25s so replacement socket always opens.
            vi.advanceTimersByTime(25_000);
            assert.equal(FakeWebSocket.instances.length, prevCount + 1);
          }
        },
        toString: () => "Transient1013()",
      }),
      fc.constant<fc.Command<SigModel, SignalingClient>>({
        check: (m) => !m.fatal && !m.closed && !m.welcomed,
        run(m, real) {
          const prevCount = FakeWebSocket.instances.length;
          const ws = FakeWebSocket.instances[prevCount - 1];
          if (!ws || ws.readyState === FakeWebSocket.CLOSED) return;
          ws.close(1006, "abnormal");
          m.initAttempts += 1;
          if (m.initAttempts >= 8) {
            m.fatal = true;
            assert.equal(real.isFatal, true);
          } else {
            assert.equal(real.isFatal, false);
            vi.advanceTimersByTime(25_000);
            assert.equal(FakeWebSocket.instances.length, prevCount + 1);
          }
        },
        toString: () => "Transient1006()",
      }),
      fc.constant<fc.Command<SigModel, SignalingClient>>({
        check: (m) => !m.fatal && !m.closed,
        run(m, real) {
          const wasReady = real.isReady;
          real.signal("peer-x", { k: "ice", candidate: { candidate: "c", sdpMid: "0", sdpMLineIndex: 0 } });
          if (!wasReady) m.pendingSignals = Math.min(64, m.pendingSignals + 1);
        },
        toString: () => "SendSignal()",
      }),
      fc.boolean().map((sharing): fc.Command<SigModel, SignalingClient> => ({
        check: (m) => !m.closed,
        run(m, real) {
          const wasReady = real.isReady;
          real.setSharing(sharing);
          if (!wasReady && !m.fatal) m.pendingStates = Math.min(64, m.pendingStates + 1);
        },
        toString: () => `SetSharing(${String(sharing)})`,
      })),
    ];

    let totalRuns = 0;
    try {
      fc.assert(
        fc.property(fc.commands(sigCmds, { maxCommands: 20 }), (seq) => {
          totalRuns += 1;
          FakeWebSocket.instances = [];
          const client = new SignalingClient(
            "ABCD2345",
            "Alice",
            {
              onWelcome: (_id, _peers, room) => welcomes.push(room),
              onPeerJoined: () => {},
              onPeerLeft: () => {},
              onSignal: () => {},
              onPeerState: () => {},
              onError: (code) => events.push(code),
              onStatus: () => {},
            },
            () => ({ password: "SECRET23456789AB", rejoinToken: "rej-1" }),
          );
          client.connect();
          try {
            fc.modelRun(
              () => ({
                model: {
                  fatal: false,
                  welcomed: false,
                  closed: false,
                  capRefusals: 0,
                  initAttempts: 0,
                  selfId: null,
                  pendingSignals: 0,
                  pendingStates: 0,
                },
                real: client,
              }),
              seq,
            );
          } finally {
            client.close();
          }
        }),
        { numRuns: 50 },
      );
    } finally {
      vi.useRealTimers();
    }
    expect(totalRuns).toBe(50);
  });
});

