import { describe, expect, it, vi } from "vitest";
import {
  DISCONNECTED_REJOIN_TTL_MS,
  EMPTY_ROOM_TTL_MS,
  EMPTY_SESSION_CLEANUP_MS,
  HOST_GRACE_MS,
  MESSAGE_BURST,
  MESSAGE_REFILL_PER_SEC,
  MemberEntrySchema,
  OCCUPIED_FALLBACK_ALARM_MS,
  PeerAttachmentSchema,
  PromotedHostSchema,
  UNUSED_ROOM_TTL_MS,
  capByExpiry,
  filterLiveDenyList,
  filterLiveMembers,
  sanitiseName,
  spendBudget,
} from "@worker/room-models";
import {
  computeCredentialExpiry,
  computeDisconnectTicket,
  computeNextAlarmDeadline,
  evaluateAdmission,
  evaluateJoinPromotion,
  evaluateSignalRelay,
  evaluateUpgradeOrigin,
  resolveResumeAttachment,
  selectHostPromotionCandidate,
  type AdmissionInput,
  type AlarmDeadlineInput,
} from "@worker/room-policy";

function baseAdmission(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    claimed: true,
    storedRoomCode: "ABCD2345",
    expectedPasswordHash: "a".repeat(64),
    roomPassword: "PASS1234",
    hostHash: "h".repeat(64),
    creatorHostHash: "c".repeat(64),
    locked: false,
    memberTicket: undefined,
    denied: false,
    msgRoom: "ABCD2345",
    pathRoomCode: "ABCD2345",
    offeredPasswordHash: "a".repeat(64),
    offeredHostHash: null,
    hasActiveSocketMatch: false,
    checkPasswordFailureRate: () => true,
    ...overrides,
  };
}

describe("worker/room-models helpers", () => {
  it("sanitiseName normalises NFKC, strips control chars, collapses whitespace, and caps 32 code points/units", () => {
    expect(sanitiseName("  Alice\u0000\u200B   Smith  ")).toBe("Alice Smith");
    expect(sanitiseName("   ")).toBe("Anonymous");
    expect(sanitiseName("A".repeat(60))).toHaveLength(32);
    // Astral characters (2 UTF-16 code units each) stop at <= 32 UTF-16 code units.
    const emoji = sanitiseName("😀".repeat(25));
    expect(emoji.length).toBeLessThanOrEqual(32);
    expect(emoji.length).toBe(32);
  });

  it("capByExpiry keeps newest entries and never evicts protected keys", () => {
    const map = { a: 100, b: 200, c: 300, d: 400 };
    expect(capByExpiry(map, (v) => v, 4)).toBe(map);
    expect(capByExpiry(map, (v) => v, 2)).toEqual({ c: 300, d: 400 });
    expect(capByExpiry(map, (v) => v, 2, new Set(["a"]))).toEqual({ a: 100, d: 400 });
  });

  it("filterLiveMembers and filterLiveDenyList prune expired/malformed entries while keeping protected hashes", () => {
    const rawMembers: Record<string, unknown> = {
      live: { until: 2000, id: "p1", sharing: true, ip: "1.2.3.4", joinedAt: 10, rotationGrace: true, creatorHost: true },
      expired: { until: 500, id: "p2" },
      activeExpired: { until: 500, id: "p3" },
      extraProtected: { until: 500, id: "p4" },
      bad: { notUntil: true },
    };
    const filtered = filterLiveMembers(rawMembers, 1000, new Set(["activeExpired"]), new Set(["extraProtected"]));
    expect(Object.keys(filtered).sort()).toEqual(["activeExpired", "extraProtected", "live"]);
    expect(filtered["live"]).toEqual({
      until: 2000,
      id: "p1",
      sharing: true,
      ip: "1.2.3.4",
      joinedAt: 10,
      rotationGrace: true,
      creatorHost: true,
    });
    expect(MemberEntrySchema.safeParse({ until: 1000, rotationGrace: false, creatorHost: false }).success).toBe(true);
    expect(PromotedHostSchema.safeParse({ id: "p1", token: "tok" }).success).toBe(true);
    expect(PromotedHostSchema.safeParse({ id: "", token: "tok" }).success).toBe(false);
    expect(
      PeerAttachmentSchema.parse({
        id: "p1", name: "Alice", sharing: false, joined: true, ip: "1.2.3.4",
        roomCode: "ABCD2345", openedAt: 1, joinedAt: 2, host: true, creatorHost: true, rejoinHash: "r",
      }),
    ).toMatchObject({ id: "p1", host: true, creatorHost: true, rejoinHash: "r" });

    expect(filterLiveDenyList({ active: 2000, exact: 1000, expired: 999 }, 1000)).toEqual({ active: 2000 });
  });

  it("spendBudget refills over time, clamps to burst, and rejects when empty", () => {
    const first = spendBudget(undefined, 1000, MESSAGE_BURST, MESSAGE_REFILL_PER_SEC);
    expect(first.allowed).toBe(true);
    expect(first.budget.tokens).toBe(MESSAGE_BURST - 1);

    const empty = spendBudget({ tokens: 0.5, updatedAt: 1000 }, 1000, 10, 10);
    expect(empty.allowed).toBe(false);
    expect(empty.budget.tokens).toBe(0.5);

    const refilled = spendBudget({ tokens: 0, updatedAt: 1000 }, 1500, 10, 10);
    expect(refilled.allowed).toBe(true);
    expect(refilled.budget.tokens).toBe(4);
  });
});

describe("worker/room-policy", () => {
  it("computeCredentialExpiry enforces 12h legacy, 12h unused, and 90d creator-anchored TTLs", () => {
    const t0 = 1_000_000;
    // Pre-deploy legacy room without creatorHost
    expect(computeCredentialExpiry(t0, true, undefined, false)).toBe(t0 + UNUSED_ROOM_TTL_MS);
    expect(computeCredentialExpiry(t0, true, t0 - 10_000, false)).toBe(t0 - 10_000 + UNUSED_ROOM_TTL_MS);
    // Unused room with creatorHost
    expect(computeCredentialExpiry(t0, false, t0, true)).toBe(t0 + UNUSED_ROOM_TTL_MS);
    // Used room with creatorHost: min(emptySince + 90d, lastHostActiveAt + 90d)
    expect(computeCredentialExpiry(t0, true, undefined, true)).toBe(t0 + EMPTY_ROOM_TTL_MS);
    expect(computeCredentialExpiry(t0, true, t0 - 5000, true)).toBe(t0 - 5000 + EMPTY_ROOM_TTL_MS);
    expect(computeCredentialExpiry(t0, true, t0 + 5000, true)).toBe(t0 + EMPTY_ROOM_TTL_MS);
  });

  it("evaluateAdmission enforces unclaimed, room-code, auth, rate-limit, lock, and deny order", () => {
    const checkRate = vi.fn(() => true);
    expect(evaluateAdmission(baseAdmission({ claimed: false, checkPasswordFailureRate: checkRate }))).toEqual({
      ok: false,
      code: "bad-password",
      message: "Invalid or expired room invite.",
    });
    expect(checkRate).toHaveBeenCalledTimes(1);

    expect(evaluateAdmission(baseAdmission({ claimed: false, checkPasswordFailureRate: () => false }))).toEqual({
      ok: false,
      code: "rate-limited",
      message: "Too many wrong invite codes. Wait a minute before trying again.",
    });

    // Over-budget IP is refused even with a matching password
    expect(evaluateAdmission(baseAdmission({ passwordFailureRateLimited: true }))).toEqual({
      ok: false,
      code: "rate-limited",
      message: "Too many wrong invite codes. Wait a minute before trying again.",
    });

    expect(evaluateAdmission(baseAdmission({ msgRoom: "OTHER123" }))).toEqual({
      ok: false,
      code: "bad-room-code",
      message: "Wrong room code for this connection",
    });
    expect(evaluateAdmission(baseAdmission({ pathRoomCode: "OTHER123" }))).toEqual({
      ok: false,
      code: "bad-room-code",
      message: "Wrong room code for this connection",
    });

    // Wrong password charges rate limit BEFORE revealing lock/deny
    expect(
      evaluateAdmission(baseAdmission({ offeredPasswordHash: "x".repeat(64), locked: true, denied: true })),
    ).toMatchObject({ ok: false, code: "bad-password" });
    expect(
      evaluateAdmission(
        baseAdmission({ offeredPasswordHash: null, locked: true, checkPasswordFailureRate: () => false }),
      ),
    ).toMatchObject({ ok: false, code: "rate-limited" });

    // Host and returning members bypass lock and deny
    expect(
      evaluateAdmission(
        baseAdmission({
          offeredPasswordHash: null,
          offeredHostHash: "h".repeat(64),
          creatorHostHash: "h".repeat(64),
          locked: true,
          denied: true,
        }),
      ),
    ).toMatchObject({ ok: true, isHost: true, isCreatorHost: true, locked: true });

    expect(
      evaluateAdmission(
        baseAdmission({
          offeredPasswordHash: null,
          memberTicket: { until: 9999, id: "p1" },
          locked: true,
          denied: true,
        }),
      ),
    ).toMatchObject({ ok: true, isHost: false, returning: true, locked: true });

    expect(
      evaluateAdmission(baseAdmission({ offeredPasswordHash: null, hasActiveSocketMatch: true, locked: true })),
    ).toMatchObject({ ok: true, returning: true });

    // Valid password on locked or denied room
    expect(evaluateAdmission(baseAdmission({ locked: true }))).toMatchObject({ ok: false, code: "room-locked" });
    expect(evaluateAdmission(baseAdmission({ denied: true }))).toMatchObject({ ok: false, code: "kicked" });
    expect(evaluateAdmission(baseAdmission())).toMatchObject({ ok: true, isHost: false, returning: false });
  });

  it("selectHostPromotionCandidate picks earliest joinedAt, falling back to openedAt then lexical id", () => {
    expect(selectHostPromotionCandidate([])).toBeNull();
    const peers = [
      { att: { id: "p3", joinedAt: 200, openedAt: 100 } },
      { att: { id: "p2", joinedAt: 100, openedAt: 100 } },
      { att: { id: "p1", joinedAt: 100, openedAt: 100 } },
      { att: { id: "p4", openedAt: 500 } },
    ];
    expect(selectHostPromotionCandidate(peers)?.att.id).toBe("p1");
    expect(selectHostPromotionCandidate([{ att: { id: "b" } }, { att: { id: "a", openedAt: 10 } }])?.att.id).toBe("a");
  });

  it("evaluateJoinPromotion handles host, promoted-returning claim, and non-host superseded host", () => {
    expect(
      evaluateJoinPromotion({
        admissionIsHost: true,
        admissionReturning: false,
        supersededWasHost: false,
        replacesId: undefined,
        hasRawPromoted: true,
        promoted: { id: "p1", token: "t" },
      }),
    ).toEqual({ effectiveIsHost: true, clearPromotedHost: true, markHostPromoted: true });

    expect(
      evaluateJoinPromotion({
        admissionIsHost: false,
        admissionReturning: true,
        supersededWasHost: false,
        replacesId: "p1",
        hasRawPromoted: true,
        promoted: { id: "p1", token: "reissued" },
      }),
    ).toEqual({ effectiveIsHost: true, reissuedHostToken: "reissued", clearPromotedHost: true, markHostPromoted: true });

    expect(
      evaluateJoinPromotion({
        admissionIsHost: false,
        admissionReturning: true,
        supersededWasHost: true,
        replacesId: "other",
        hasRawPromoted: true,
        promoted: { id: "p1", token: "reissued" },
      }),
    ).toEqual({ effectiveIsHost: true, clearPromotedHost: false, markHostPromoted: false });
  });

  it("resolveResumeAttachment preserves id unless taken and resolves sharing priority", () => {
    expect(
      resolveResumeAttachment({
        currentId: "temp",
        clientSharing: undefined,
        superseded: { id: "old", sharing: true },
        memberTicket: { id: "tkt", sharing: false },
        activePeerIds: new Set(),
      }),
    ).toEqual({ id: "old", sharing: true });

    expect(
      resolveResumeAttachment({
        currentId: "temp",
        clientSharing: false,
        superseded: undefined,
        memberTicket: { id: "tkt", sharing: true },
        activePeerIds: new Set(["tkt"]),
      }),
    ).toEqual({ id: "temp", sharing: false });

    expect(
      resolveResumeAttachment({
        currentId: "temp",
        clientSharing: undefined,
        superseded: undefined,
        memberTicket: undefined,
        activePeerIds: new Set(),
      }),
    ).toEqual({ id: "temp", sharing: false });
  });

  it("evaluateSignalRelay blocks offers from non-sharing senders even when target is sharing, and allows sharer/non-offer signals", () => {
    expect(evaluateSignalRelay({ sharing: false }, { sharing: false }, "offer")).toEqual({
      allowed: false,
      code: "not-sharing",
      message: "Only an active sharer can send an offer",
    });
    expect(evaluateSignalRelay({ sharing: false }, { sharing: true }, "offer")).toEqual({
      allowed: false,
      code: "not-sharing",
      message: "Only an active sharer can send an offer",
    });
    expect(evaluateSignalRelay({ sharing: true }, { sharing: false }, "offer")).toEqual({ allowed: true });
    expect(evaluateSignalRelay({ sharing: true }, { sharing: true }, "offer")).toEqual({ allowed: true });
    expect(evaluateSignalRelay({ sharing: false }, { sharing: false }, "ice")).toEqual({ allowed: true });
    expect(evaluateSignalRelay({ sharing: false }, { sharing: true }, "answer")).toEqual({ allowed: true });
  });

  it("evaluateUpgradeOrigin enforces wss/https and same-origin Origin on production while keeping local HTTP dev safe", () => {
    // Production HTTPS / WSS with matching Origin -> allowed
    expect(evaluateUpgradeOrigin(new URL("https://example.com/ws/ABCD2345"), "https://example.com")).toEqual({
      allowed: true,
    });
    expect(evaluateUpgradeOrigin(new URL("wss://example.com/ws/ABCD2345"), "https://example.com")).toEqual({
      allowed: true,
    });

    // Production HTTPS / WSS with missing Origin -> rejected
    expect(evaluateUpgradeOrigin(new URL("https://example.com/ws/ABCD2345"), null)).toMatchObject({
      allowed: false,
      code: "forbidden-origin",
    });
    expect(evaluateUpgradeOrigin(new URL("wss://example.com/ws/ABCD2345"), null)).toMatchObject({
      allowed: false,
      code: "forbidden-origin",
    });

    // Production insecure HTTP / WS -> rejected even with matching Origin
    expect(evaluateUpgradeOrigin(new URL("http://example.com/ws/ABCD2345"), "http://example.com")).toMatchObject({
      allowed: false,
      code: "forbidden-origin",
    });
    expect(evaluateUpgradeOrigin(new URL("ws://example.com/ws/ABCD2345"), "http://example.com")).toMatchObject({
      allowed: false,
      code: "forbidden-origin",
    });

    // Cross-origin or scheme-downgraded or malformed Origin -> rejected
    expect(evaluateUpgradeOrigin(new URL("https://example.com/ws/ABCD2345"), "https://evil.example")).toMatchObject({
      allowed: false,
      code: "forbidden-origin",
    });
    expect(evaluateUpgradeOrigin(new URL("https://example.com/ws/ABCD2345"), "http://example.com")).toMatchObject({
      allowed: false,
      code: "forbidden-origin",
    });
    expect(evaluateUpgradeOrigin(new URL("https://example.com/ws/ABCD2345"), "null")).toMatchObject({
      allowed: false,
      code: "forbidden-origin",
    });

    // Local HTTP dev/test allows missing or matching Origin, rejects cross-origin
    expect(evaluateUpgradeOrigin(new URL("http://localhost:8787/ws/ABCD2345"), null)).toEqual({ allowed: true });
    expect(evaluateUpgradeOrigin(new URL("http://127.0.0.1:8787/ws/ABCD2345"), null)).toEqual({ allowed: true });
    expect(evaluateUpgradeOrigin(new URL("ws://[::1]:8787/ws/ABCD2345"), "http://[::1]:8787")).toEqual({
      allowed: true,
    });
    expect(evaluateUpgradeOrigin(new URL("http://localhost:8787/ws/ABCD2345"), "https://evil.example")).toMatchObject({
      allowed: false,
      code: "forbidden-origin",
    });
    // Even on localhost, HTTPS/WSS requires Origin
    expect(evaluateUpgradeOrigin(new URL("https://localhost:8787/ws/ABCD2345"), null)).toMatchObject({
      allowed: false,
      code: "forbidden-origin",
    });
  });

  it("computeDisconnectTicket preserves active rotation grace and shrinks normal tickets to 5m", () => {
    const now = 10_000;
    expect(
      computeDisconnectTicket({
        now,
        attachment: { id: "p1", sharing: true, ip: "1.2.3.4", joinedAt: 500, creatorHost: true },
        existing: undefined,
      }),
    ).toEqual({
      until: now + DISCONNECTED_REJOIN_TTL_MS,
      id: "p1",
      sharing: true,
      ip: "1.2.3.4",
      joinedAt: 500,
      creatorHost: true,
    });

    expect(
      computeDisconnectTicket({
        now,
        attachment: { id: "p1", sharing: false, openedAt: 100 },
        existing: { until: now + 5000, rotationGrace: true, ip: "9.9.9.9", joinedAt: 200 },
      }),
    ).toEqual({
      until: now + 5000,
      id: "p1",
      ip: "9.9.9.9",
      joinedAt: 200,
      rotationGrace: true,
    });
  });

  it("computeNextAlarmDeadline multiplexes occupied, host-grace, empty-cleanup, creatorCap, and unjoined deadlines", () => {
    const now = 100_000;
    const base: AlarmDeadlineInput = {
      now,
      occupied: true,
      hasHost: true,
      hostGoneAt: undefined,
      emptySince: now,
      sessionCleaned: false,
      everJoined: true,
      lastHostActiveAt: now,
      hasCreatorHost: true,
      creatorCap: null,
      earliestUnjoinedDeadline: null,
    };
    expect(computeNextAlarmDeadline(base)).toBe(now + OCCUPIED_FALLBACK_ALARM_MS);
    expect(computeNextAlarmDeadline({ ...base, hasHost: false, hostGoneAt: now - 1000 })).toBe(
      now - 1000 + HOST_GRACE_MS,
    );
    expect(computeNextAlarmDeadline({ ...base, creatorCap: now + 5000 })).toBe(now + 5000);
    expect(computeNextAlarmDeadline({ ...base, earliestUnjoinedDeadline: now + 2000 })).toBe(now + 2000);
    expect(computeNextAlarmDeadline({ ...base, earliestUnjoinedDeadline: now - 5000 })).toBe(now + 1000);

    // Empty room: 15m cleanup before credential expiry, then 90d after cleanup
    expect(computeNextAlarmDeadline({ ...base, occupied: false, sessionCleaned: false })).toBe(
      now + EMPTY_SESSION_CLEANUP_MS,
    );
    expect(computeNextAlarmDeadline({ ...base, occupied: false, sessionCleaned: true })).toBe(
      now + EMPTY_ROOM_TTL_MS,
    );
  });

  it("adversarial: unclaimed rooms never leak lock/deny/room-code or admit with host/rejoin tokens", () => {
    const checkRate = vi.fn(() => true);
    const decision = evaluateAdmission(
      baseAdmission({
        claimed: false,
        storedRoomCode: "OTHER999",
        offeredHostHash: "h".repeat(64),
        memberTicket: { until: Number.MAX_SAFE_INTEGER, id: "p1" },
        hasActiveSocketMatch: true,
        locked: true,
        denied: true,
        checkPasswordFailureRate: checkRate,
      }),
    );
    expect(decision).toEqual({
      ok: false,
      code: "bad-password",
      message: "Invalid or expired room invite.",
    });
    expect(checkRate).toHaveBeenCalledTimes(1);
  });

  it("adversarial: claimed room with missing expectedPasswordHash never admits DUMMY_HASH_HEX", () => {
    const decision = evaluateAdmission(
      baseAdmission({
        claimed: true,
        expectedPasswordHash: undefined,
        offeredPasswordHash: "0".repeat(64),
      }),
    );
    expect(decision).toMatchObject({ ok: false, code: "bad-password" });
  });

  it("adversarial: creator host returning after promotion slides creatorHost but does not bypass lock without active hostHash", () => {
    // Unlocked room with valid password + creatorHostHash != hostHash -> admitted as creatorHost (not active host)
    expect(
      evaluateAdmission(
        baseAdmission({
          hostHash: "p".repeat(64),
          creatorHostHash: "c".repeat(64),
          offeredHostHash: "c".repeat(64),
          locked: false,
        }),
      ),
    ).toMatchObject({ ok: true, isHost: false, isCreatorHost: true });

    // Locked room without password + creatorHostHash != hostHash -> rejected as bad-password
    expect(
      evaluateAdmission(
        baseAdmission({
          hostHash: "p".repeat(64),
          creatorHostHash: "c".repeat(64),
          offeredHostHash: "c".repeat(64),
          offeredPasswordHash: null,
          locked: true,
        }),
      ),
    ).toMatchObject({ ok: false, code: "bad-password" });

    // Locked room with valid password + creatorHostHash != hostHash -> rejected as room-locked
    expect(
      evaluateAdmission(
        baseAdmission({
          hostHash: "p".repeat(64),
          creatorHostHash: "c".repeat(64),
          offeredHostHash: "c".repeat(64),
          locked: true,
        }),
      ),
    ).toMatchObject({ ok: false, code: "room-locked" });
  });

  it("adversarial: non-returning join cannot claim promoted host token even if replacesId matches", () => {
    expect(
      evaluateJoinPromotion({
        admissionIsHost: false,
        admissionReturning: false,
        supersededWasHost: false,
        replacesId: "p1",
        hasRawPromoted: true,
        promoted: { id: "p1", token: "secret-promoted-token" },
      }),
    ).toEqual({ effectiveIsHost: false, clearPromotedHost: false, markHostPromoted: false });
  });

  it("adversarial: computeDisconnectTicket drops expired rotationGrace and preserves existing creatorHost", () => {
    const now = 50_000;
    const ticket = computeDisconnectTicket({
      now,
      attachment: { id: "p1", sharing: false },
      existing: { until: now, rotationGrace: true, creatorHost: true },
    });
    expect(ticket).toEqual({
      until: now + DISCONNECTED_REJOIN_TTL_MS,
      id: "p1",
      creatorHost: true,
    });
    expect(ticket.rotationGrace).toBeUndefined();
  });

  it("adversarial: computeNextAlarmDeadline clamps to creatorCap and credentialExpiry before 15m cleanup", () => {
    const now = 100_000;
    // Occupied without host: creatorCap earlier than hostGoneAt + 5m
    expect(
      computeNextAlarmDeadline({
        now,
        occupied: true,
        hasHost: false,
        hostGoneAt: now,
        emptySince: now,
        sessionCleaned: false,
        everJoined: true,
        lastHostActiveAt: now,
        hasCreatorHost: true,
        creatorCap: now + 30_000,
        earliestUnjoinedDeadline: null,
      }),
    ).toBe(now + 30_000);

    // Empty uncleaned room where creator 90d cap is 2m away (earlier than 15m cleanup)
    const almostExpiredHost = now - EMPTY_ROOM_TTL_MS + 120_000;
    expect(
      computeNextAlarmDeadline({
        now,
        occupied: false,
        hasHost: false,
        hostGoneAt: undefined,
        emptySince: now,
        sessionCleaned: false,
        everJoined: true,
        lastHostActiveAt: almostExpiredHost,
        hasCreatorHost: true,
        creatorCap: null,
        earliestUnjoinedDeadline: null,
      }),
    ).toBe(now + 120_000);

    // Pre-deploy legacy room stays on 12h TTL after cleanup
    expect(
      computeNextAlarmDeadline({
        now,
        occupied: false,
        hasHost: false,
        hostGoneAt: undefined,
        emptySince: now,
        sessionCleaned: true,
        everJoined: true,
        lastHostActiveAt: now,
        hasCreatorHost: false,
        creatorCap: null,
        earliestUnjoinedDeadline: null,
      }),
    ).toBe(now + UNUSED_ROOM_TTL_MS);
  });

  it("adversarial: capByExpiry enforces exact 128-entry cap while protecting active keys with oldest timestamps", () => {
    const map: Record<string, number> = {};
    for (let i = 0; i < 129; i++) {
      map[`k${i}`] = i === 0 ? 0 : 1000 + i;
    }
    const capped = capByExpiry(map, (v) => v, 128, new Set(["k0"]));
    expect(Object.keys(capped)).toHaveLength(128);
    expect(capped["k0"]).toBe(0);
    expect(capped["k1"]).toBeUndefined();
    expect(capped["k128"]).toBe(1128);
  });

  it("room-models: decodes optional MemberEntrySchema and PeerAttachmentSchema fields faithfully", () => {
    const minMember = MemberEntrySchema.parse({ until: 5000 });
    expect(minMember).toEqual({ until: 5000 });
    expect("id" in minMember).toBe(false);
    expect("sharing" in minMember).toBe(false);
    expect("ip" in minMember).toBe(false);
    expect("joinedAt" in minMember).toBe(false);

    const fullMember = MemberEntrySchema.parse({
      until: 5000,
      id: "p1",
      sharing: true,
      ip: "ip-1",
      joinedAt: 123,
      rotationGrace: true,
      creatorHost: true,
    });
    expect(fullMember).toEqual({
      until: 5000,
      id: "p1",
      sharing: true,
      ip: "ip-1",
      joinedAt: 123,
      rotationGrace: true,
      creatorHost: true,
    });

    const minAtt = PeerAttachmentSchema.parse({
      id: "p1",
      name: "Alice",
      joined: false,
      sharing: false,
      msgTokens: 10,
      msgLastRefill: 100,
      badMessages: 0,
    });
    expect("ip" in minAtt).toBe(false);
    expect("roomCode" in minAtt).toBe(false);
    expect("openedAt" in minAtt).toBe(false);
    expect("joinedAt" in minAtt).toBe(false);
    expect("host" in minAtt).toBe(false);
    expect("creatorHost" in minAtt).toBe(false);
    expect("rejoinHash" in minAtt).toBe(false);

    const fullAtt = PeerAttachmentSchema.parse({
      id: "p1",
      name: "Alice",
      joined: true,
      sharing: true,
      msgTokens: 10,
      msgLastRefill: 100,
      badMessages: 1,
      ip: "ip-1",
      roomCode: "ABCD2345",
      openedAt: 10,
      joinedAt: 20,
      host: true,
      creatorHost: true,
      rejoinHash: "r".repeat(64),
    });
    expect(fullAtt).toMatchObject({
      ip: "ip-1",
      roomCode: "ABCD2345",
      openedAt: 10,
      joinedAt: 20,
      host: true,
      creatorHost: true,
      rejoinHash: "r".repeat(64),
    });
  });

  it("room-models: sanitiseName normalizes NFKC, enforces 32 UTF-16 code unit cap with astral emojis, and trims", () => {
    // NFKC normalizes fullwidth Latin to ASCII
    expect(sanitiseName("\uFF21\uFF22\uFF23")).toBe("ABC");
    // 16 astral emojis = 32 UTF-16 code units; 17th emoji must be dropped (length <= 32)
    const seventeenEmojis = "\u{1F600}".repeat(17);
    const cleaned = sanitiseName(seventeenEmojis);
    expect(cleaned.length).toBe(32);
    expect(cleaned).toBe("\u{1F600}".repeat(16));
    // Trailing whitespace after truncation is trimmed
    expect(sanitiseName(`${"a".repeat(31)}  b`)).toBe("a".repeat(31));
    // Whitespace-only falls back to Anonymous
    expect(sanitiseName("   \u200B  ")).toBe("Anonymous");
  });

  it("room-models: filterLiveMembers respects extraProtectedHashes and spendBudget boundary at exactly 1 token", () => {
    const live = filterLiveMembers(
      {
        h1: { until: 500 },
        h2: { until: 500 },
      },
      1000,
      new Set(),
      new Set(["h2"]),
    );
    expect(Object.keys(live)).toEqual(["h2"]);

    // Exactly 1 token remaining -> allowed, drops to 0
    const b1 = spendBudget({ tokens: 1, updatedAt: 1000 }, 1000);
    expect(b1.allowed).toBe(true);
    expect(b1.budget.tokens).toBe(0);
    // 0.99 tokens -> rejected
    const b2 = spendBudget({ tokens: 0.99, updatedAt: 1000 }, 1000);
    expect(b2.allowed).toBe(false);
  });
});

