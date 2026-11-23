import { describe, expect, it } from "vitest";
import {
  MAX_CLOCK_SKEW_MS,
  MAX_RECENT_ROOM_LABEL_LEN,
  MAX_RECENT_ROOM_PASSWORD_LEN,
  MAX_RECENT_ROOM_PEERS,
  MAX_STORED_RECENT_ROOMS,
  RECENT_ROOMS_LOCK_NAME,
  RECENT_ROOMS_OPT_OUT_KEY,
  RECENT_ROOMS_STORAGE_KEY,
  RECENT_ROOM_TTL_MS,
  clearAllPersistedRecentRooms,
  filterRecentRooms,
  formatRelativeTime,
  hasStaleRecentRooms,
  isRecentRoomsKeyAbsent,
  mergeSynthesizedHostRooms,
  pruneExpiredRecentRooms,
  runWithRecentRoomsLock,
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  setRecentRoomsDisabled,
  sortAndBoundEntries,
  tryIsRecentRoomsDisabled,
  tryLoadRecentRooms,
  writePersistedRecentRooms,
  type LockManagerLike,
  type StorageLike,
} from "@src/recent-rooms";
import {
  applyPatchToEntry,
  applyRecentRoomOp,
  computeRecentRoomsView,
  type RecentRoomEntry,
  type RecentRoomsSnapshot,
} from "@src/recent-rooms-model";

function makeMemoryStorage(initial: Record<string, string> = {}): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

describe("recent-rooms localStorage persistence", () => {
  it("loads, normalizes, enforces TTL/skew/cap, and writes persisted recent rooms", () => {
    const storage = makeMemoryStorage();
    const t0 = 1_700_000_000_000;

    expect(tryLoadRecentRooms(null, t0)).toEqual({ entries: [], ok: false });
    expect(tryLoadRecentRooms(storage, t0)).toEqual({ entries: [], ok: true });
    expect(writePersistedRecentRooms(null, [])).toBe(false);

    expect(
      writePersistedRecentRooms(storage, [
        {
          code: "ABCDEFGH",
          role: "guest",
          lastJoinedAt: t0,
          password: "PASS1234WORD5678",
          label: "Design Sync",
          peerNames: ["Alice", "Bob", "Carol", "Dave"],
        },
      ]),
    ).toBe(true);
    expect(tryLoadRecentRooms(storage, t0)).toEqual({
      ok: true,
      entries: [
        {
          code: "ABCDEFGH",
          role: "guest",
          lastJoinedAt: t0,
          password: "PASS1234WORD5678",
          label: "Design Sync",
          peerNames: ["Alice", "Bob", "Carol", "Dave"],
        },
      ],
    });

    // TTL boundary (90d) and forward clock-skew boundary (5m)
    const boundary = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "VAKD2345", role: "guest", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS + 1 },
        { code: "EXPD2345", role: "guest", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS },
        { code: "SKEW2345", role: "guest", lastJoinedAt: t0 + MAX_CLOCK_SKEW_MS },
        { code: "SKEW9876", role: "guest", lastJoinedAt: t0 + MAX_CLOCK_SKEW_MS + 1 },
        { code: "BAD", role: "guest", lastJoinedAt: t0 },
        { code: "NAN23456", role: "guest", lastJoinedAt: Number.NaN },
      ]),
    });
    expect(tryLoadRecentRooms(boundary, t0).entries.map((e) => e.code)).toEqual(["SKEW2345", "VAKD2345"]);

    // Cap at MAX_STORED_RECENT_ROOMS (20), newest first
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const many: RecentRoomEntry[] = Array.from({ length: MAX_STORED_RECENT_ROOMS + 5 }, (_, i) => ({
      code: `RM2222${alphabet[Math.floor(i / alphabet.length)] ?? "A"}${alphabet[i % alphabet.length] ?? "A"}`,
      role: "guest",
      lastJoinedAt: t0 + i * 1000,
      peerNames: [],
    }));
    expect(writePersistedRecentRooms(storage, many)).toBe(true);
    const loadedMany = tryLoadRecentRooms(storage, t0 + 30_000).entries;
    expect(loadedMany).toHaveLength(MAX_STORED_RECENT_ROOMS);
    expect(loadedMany[0]?.code).toBe(many[MAX_STORED_RECENT_ROOMS + 4]?.code);
    expect(loadedMany[MAX_STORED_RECENT_ROOMS - 1]?.code).toBe(many[5]?.code);

    // Writing empty array removes storage key
    expect(writePersistedRecentRooms(storage, [])).toBe(true);
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
  });

  it("reads and writes shared-device opt-out flag safely", () => {
    const storage = makeMemoryStorage();
    expect(tryIsRecentRoomsDisabled(null)).toEqual({ ok: false, disabled: false });
    expect(tryIsRecentRoomsDisabled(storage)).toEqual({ ok: true, disabled: false });

    expect(setRecentRoomsDisabled(storage, true)).toBe(true);
    expect(storage.store.get(RECENT_ROOMS_OPT_OUT_KEY)).toBe("1");
    expect(tryIsRecentRoomsDisabled(storage)).toEqual({ ok: true, disabled: true });

    storage.store.set(RECENT_ROOMS_OPT_OUT_KEY, "true");
    expect(tryIsRecentRoomsDisabled(storage)).toEqual({ ok: true, disabled: true });

    expect(setRecentRoomsDisabled(storage, false)).toBe(true);
    expect(storage.store.has(RECENT_ROOMS_OPT_OUT_KEY)).toBe(false);
    expect(tryIsRecentRoomsDisabled(storage)).toEqual({ ok: true, disabled: false });

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(tryIsRecentRoomsDisabled(throwing)).toEqual({ ok: false, disabled: false });
    expect(setRecentRoomsDisabled(null, true)).toBe(false);
    expect(setRecentRoomsDisabled(throwing, true)).toBe(false);
    expect(clearAllPersistedRecentRooms(null)).toBe(false);
    expect(clearAllPersistedRecentRooms(throwing)).toBe(false);
  });

  it("serializes concurrent storage updates via Web Locks and falls back safely", async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const locks: LockManagerLike = {
      request: async (name, cb) => {
        expect(name).toBe(RECENT_ROOMS_LOCK_NAME);
        if (!releaseFirst) {
          await new Promise<void>((resolve) => {
            releaseFirst = () => {
              void Promise.resolve(cb()).finally(resolve);
            };
          });
          return;
        }
        await cb();
      },
    };

    const p1 = runWithRecentRoomsLock(locks, () => events.push("first"));
    const p2 = runWithRecentRoomsLock(locks, () => events.push("second"));
    expect(events).toEqual(["second"]);
    (releaseFirst as (() => void) | null)?.();
    await Promise.all([p1, p2]);
    expect(events).toEqual(["second", "first"]);

    // Fallback when locks is null
    const syncEvents: string[] = [];
    await runWithRecentRoomsLock(null, () => syncEvents.push("no-lock"));
    expect(syncEvents).toEqual(["no-lock"]);

    // Fallback when locks.request throws before running cb
    const failingLocks: LockManagerLike = {
      request: async () => {
        throw new Error("locks unavailable");
      },
    };
    const fallbackEvents: string[] = [];
    await runWithRecentRoomsLock(failingLocks, () => fallbackEvents.push("fallback"));
    expect(fallbackEvents).toEqual(["fallback"]);

    // Does NOT run cb twice if cb ran and then threw inside locks.request
    const throwingAfterRun: LockManagerLike = {
      request: async (_name, cb) => {
        await cb();
        throw new Error("post-cb error");
      },
    };
    let count = 0;
    await runWithRecentRoomsLock(throwingAfterRun, () => {
      count++;
    });
    expect(count).toBe(1);
  });

  it("handles corrupted JSON, mixed entries, duplicate codes, password bounds, and throwing storage", () => {
    const t0 = 1_700_000_000_000;
    const badJson = makeMemoryStorage({ [RECENT_ROOMS_STORAGE_KEY]: "{not-json" });
    expect(tryLoadRecentRooms(badJson, t0)).toEqual({ entries: [], ok: true });
    expect(hasStaleRecentRooms(badJson, t0)).toBe(true);

    const nonArray = makeMemoryStorage({ [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify({ code: "AAAA2345" }) });
    expect(tryLoadRecentRooms(nonArray, t0)).toEqual({ entries: [], ok: true });
    expect(hasStaleRecentRooms(nonArray, t0)).toBe(true);

    const dupes = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "aaaa2345", role: "guest", lastJoinedAt: t0 - 1000, password: "OLD" },
        { code: "AAAA2345", role: "host", lastJoinedAt: t0, password: "NEW", peerNames: ["  Bob  ", ""] },
        { code: "BBBB2345", role: "guest", lastJoinedAt: t0, password: "  " + "P".repeat(MAX_RECENT_ROOM_PASSWORD_LEN) + "  " },
        { code: "CCCC2345", role: "guest", lastJoinedAt: t0, password: "X".repeat(MAX_RECENT_ROOM_PASSWORD_LEN + 1) },
      ]),
    });
    const loaded = tryLoadRecentRooms(dupes, t0).entries;
    expect(loaded.find((e) => e.code === "AAAA2345")).toEqual({
      code: "AAAA2345",
      role: "host",
      lastJoinedAt: t0,
      password: "NEW",
      peerNames: ["Bob"],
    });
    expect(loaded.find((e) => e.code === "BBBB2345")?.password).toBe("P".repeat(MAX_RECENT_ROOM_PASSWORD_LEN));
    expect(loaded.find((e) => e.code === "CCCC2345")).toBeUndefined();
    expect(hasStaleRecentRooms(dupes, t0)).toBe(true);

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(tryLoadRecentRooms(throwing, t0)).toEqual({ entries: [], ok: false });
    expect(isRecentRoomsKeyAbsent(null)).toBe(false);
    expect(isRecentRoomsKeyAbsent(throwing)).toBe(false);
    expect(writePersistedRecentRooms(throwing, [{ code: "AAAA2345", role: "guest", lastJoinedAt: t0, peerNames: [] }])).toBe(
      false,
    );
  });

  it("detects and prunes expired, corrupt, duplicate, and empty-array records", () => {
    const t0 = 1_700_000_000_000;
    const empty = makeMemoryStorage();
    expect(isRecentRoomsKeyAbsent(empty)).toBe(true);
    expect(hasStaleRecentRooms(empty, t0)).toBe(false);
    expect(pruneExpiredRecentRooms(empty, t0)).toBe(false);

    const emptyArray = makeMemoryStorage({ [RECENT_ROOMS_STORAGE_KEY]: "[]" });
    expect(isRecentRoomsKeyAbsent(emptyArray)).toBe(false);
    expect(hasStaleRecentRooms(emptyArray, t0)).toBe(true);
    expect(pruneExpiredRecentRooms(emptyArray, t0)).toBe(true);
    expect(isRecentRoomsKeyAbsent(emptyArray)).toBe(true);

    const mixed = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "EXPD2345", role: "guest", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS },
        { code: "KEEP2345", role: "host", lastJoinedAt: t0 - 1000 },
      ]),
    });
    expect(hasStaleRecentRooms(mixed, t0)).toBe(true);
    expect(pruneExpiredRecentRooms(mixed, t0)).toBe(true);
    expect(hasStaleRecentRooms(mixed, t0)).toBe(false);
    expect(tryLoadRecentRooms(mixed, t0).entries.map((r) => r.code)).toEqual(["KEEP2345"]);

    expect(clearAllPersistedRecentRooms(mixed)).toBe(true);
    expect(isRecentRoomsKeyAbsent(mixed)).toBe(true);
  });

  it("clones peerNames on applyPatchToEntry so base entries never share mutable array references", () => {
    const base: RecentRoomEntry = {
      code: "AAAA2345",
      role: "host",
      lastJoinedAt: 1_700_000_000_000,
      peerNames: ["Alice"],
      label: "Team",
    };
    const afterPw = applyPatchToEntry(base, {
      kind: "patch",
      code: "AAAA2345",
      field: "password",
      password: "PASS_123456789012",
    });
    const afterLabel = applyPatchToEntry(base, {
      kind: "patch",
      code: "AAAA2345",
      field: "label",
      label: "Updated",
    });
    const afterClearLabel = applyPatchToEntry(base, {
      kind: "patch",
      code: "AAAA2345",
      field: "label",
    });
    const incomingPeers = ["Bob"];
    const afterPeers = applyPatchToEntry(base, {
      kind: "patch",
      code: "AAAA2345",
      field: "peerNames",
      peerNames: incomingPeers,
    });

    expect(afterPw.peerNames).not.toBe(base.peerNames);
    expect(afterLabel.peerNames).not.toBe(base.peerNames);
    expect(afterClearLabel.peerNames).not.toBe(base.peerNames);
    expect("label" in afterClearLabel).toBe(false);
    expect(afterPeers.peerNames).not.toBe(incomingPeers);
    afterPw.peerNames.push("Mutated");
    expect(base.peerNames).toEqual(["Alice"]);
  });

  it("enforces exact boundary rules for sanitizers, formatRelativeTime, filterRecentRooms, sortAndBoundEntries, and mergeSynthesizedHostRooms", () => {
    const t0 = 1_700_000_000_000;

    // Sanitizers
    expect(sanitizePassword(undefined)).toBeUndefined();
    expect(sanitizePassword("   ")).toBeUndefined();
    expect(sanitizePassword("X".repeat(MAX_RECENT_ROOM_PASSWORD_LEN + 1))).toBeUndefined();
    expect(sanitizePassword("  ok  ")).toBe("ok");
    expect(sanitizePeerNames(undefined)).toEqual([]);
    expect(sanitizePeerNames(["  A  ", "", "B", "C", "D", "E"])).toHaveLength(MAX_RECENT_ROOM_PEERS);
    expect(sanitizeRecentRoomLabel(undefined)).toBeUndefined();
    expect(sanitizeRecentRoomLabel("   ")).toBeUndefined();
    expect(sanitizeRecentRoomLabel("a".repeat(MAX_RECENT_ROOM_LABEL_LEN))).toBe("a".repeat(MAX_RECENT_ROOM_LABEL_LEN));
    expect(sanitizeRecentRoomLabel(`${"a".repeat(39)} bc`)).toBe("a".repeat(39));
    expect(sanitizeRecentRoomLabel(`${"a".repeat(39)}\uD800\uDC00`)).toBe("a".repeat(39));
    expect(sanitizeRecentRoomLabel(`${"a".repeat(39)}\uDBFF\uDFFF`)).toBe("a".repeat(39));
    expect(sanitizeRecentRoomLabel(`${"a".repeat(39)}\uD7FFz`)).toBe(`${"a".repeat(39)}\uD7FF`);
    expect(sanitizeRecentRoomLabel(`${"a".repeat(39)}\uDC00z`)).toBe(`${"a".repeat(39)}\uDC00`);

    // Exact unit rollover boundaries for formatRelativeTime
    expect(formatRelativeTime(t0 + 10_000, t0)).toBe("Just now");
    expect(formatRelativeTime(t0 - 59_999, t0)).toBe("Just now");
    expect(formatRelativeTime(t0 - 60_000, t0)).toBe("1m ago");
    expect(formatRelativeTime(t0 - 59 * 60_000, t0)).toBe("59m ago");
    expect(formatRelativeTime(t0 - 60 * 60_000, t0)).toBe("1h ago");
    expect(formatRelativeTime(t0 - 23 * 3_600_000, t0)).toBe("23h ago");
    expect(formatRelativeTime(t0 - 24 * 3_600_000, t0)).toBe("1d ago");

    // filterRecentRooms & sortAndBoundEntries
    const filterEntries: RecentRoomEntry[] = [
      { code: "AAAA2345", role: "guest", lastJoinedAt: t0 - 10, peerNames: ["Alice", "Bob"], label: "Standup" },
      { code: "BBBB2345", role: "host", lastJoinedAt: t0, peerNames: ["Carol"] },
    ];
    expect(sortAndBoundEntries(filterEntries).map((e) => e.code)).toEqual(["BBBB2345", "AAAA2345"]);
    expect(filterRecentRooms(filterEntries, "")).toEqual(filterEntries);
    expect(filterRecentRooms(filterEntries, "bob").map((e) => e.code)).toEqual(["AAAA2345"]);
    expect(filterRecentRooms(filterEntries, "stand").map((e) => e.code)).toEqual(["AAAA2345"]);
    expect(filterRecentRooms(filterEntries, "bbbb").map((e) => e.code)).toEqual(["BBBB2345"]);

    // mergeSynthesizedHostRooms deduplicates repeated codes in hostRooms
    const synthesized: string[] = [];
    const dedupMerged = mergeSynthesizedHostRooms(
      [],
      [
        { code: "CCCC2345", updatedAt: t0 },
        { code: "CCCC2345", updatedAt: t0 + 10 },
      ],
      () => true,
      (code) => synthesized.push(code),
    );
    expect(synthesized).toEqual(["CCCC2345"]);
    expect(dedupMerged).toHaveLength(1);
    expect(dedupMerged[0]?.lastJoinedAt).toBe(t0);
  });

  it("evaluates applyRecentRoomOp and computeRecentRoomsView outcomes accurately", () => {
    const t0 = 1_700_000_000_000;
    const emptySnap: RecentRoomsSnapshot = { entries: [], disabled: false };
    const noHost = () => false;

    // Invalid timestamp or disabled snapshot makes join a no-op
    expect(
      applyRecentRoomOp(
        { entries: [], disabled: true },
        { kind: "join", code: "AAAA2345", role: "guest", lastJoinedAt: t0 },
        t0,
        [],
        noHost,
      ),
    ).toEqual({ snapshot: { entries: [], disabled: true }, changed: false, missing: false });
    expect(
      applyRecentRoomOp(
        emptySnap,
        { kind: "join", code: "AAAA2345", role: "guest", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS },
        t0,
        [],
        noHost,
      ),
    ).toEqual({ snapshot: emptySnap, changed: false, missing: false });

    // Join adds entry with exact outcome flags
    const joined = applyRecentRoomOp(
      emptySnap,
      { kind: "join", code: "AAAA2345", role: "host", lastJoinedAt: t0, password: "PW1" },
      t0,
      [],
      noHost,
    );
    expect(joined.changed).toBe(true);
    expect(joined.missing).toBe(false);
    expect(joined.snapshot.entries).toHaveLength(1);

    // Patch no-op when identical vs changed
    const samePwPatch = applyRecentRoomOp(
      joined.snapshot,
      { kind: "patch", code: "AAAA2345", field: "password", password: "PW1" },
      t0,
      [],
      noHost,
    );
    expect(samePwPatch).toEqual({ snapshot: joined.snapshot, changed: false, missing: false });

    const diffPwPatch = applyRecentRoomOp(
      joined.snapshot,
      { kind: "patch", code: "AAAA2345", field: "password", password: "PW2" },
      t0,
      [],
      noHost,
    );
    expect(diffPwPatch.changed).toBe(true);
    expect(diffPwPatch.missing).toBe(false);
    expect(diffPwPatch.snapshot.entries[0]?.password).toBe("PW2");

    // Patch on missing entry with unowned/expired hostRoom returns missing: true, changed: false
    const missingPatch = applyRecentRoomOp(
      emptySnap,
      { kind: "patch", code: "HOST2345", field: "label", label: "Named" },
      t0,
      [{ code: "OTHR2345", updatedAt: t0 }],
      noHost,
    );
    expect(missingPatch).toEqual({ snapshot: emptySnap, changed: false, missing: true });

    // Patch on missing entry with valid creator hostRoom synthesizes with empty peerNames
    const synthPatch = applyRecentRoomOp(
      emptySnap,
      { kind: "patch", code: "HOST2345", field: "label", label: "Named" },
      t0,
      [
        { code: "OTHR2345", updatedAt: t0 },
        { code: "HOST2345", updatedAt: t0 - 500 },
      ],
      (c) => c === "HOST2345",
    );
    expect(synthPatch.changed).toBe(true);
    expect(synthPatch.missing).toBe(false);
    expect(synthPatch.snapshot.entries).toEqual([
      { code: "HOST2345", role: "host", lastJoinedAt: t0 - 500, peerNames: [], label: "Named" },
    ]);

    // Remove outcomes: missing, demoteIfPassworded on guest (no-op), demoteIfPassworded on host, full remove
    expect(applyRecentRoomOp(emptySnap, { kind: "remove", code: "AAAA2345" }, t0, [], noHost)).toEqual({
      snapshot: emptySnap,
      changed: false,
      missing: false,
    });
    const twoHosts: RecentRoomsSnapshot = {
      entries: [
        { code: "AAAA2345", role: "host", lastJoinedAt: t0, peerNames: [], password: "PW1" },
        { code: "BBBB2345", role: "host", lastJoinedAt: t0 - 10, peerNames: [], password: "PW2" },
      ],
      disabled: false,
    };
    const demoted = applyRecentRoomOp(
      twoHosts,
      { kind: "remove", code: "AAAA2345", demoteIfPassworded: true },
      t0,
      [],
      noHost,
    );
    expect(demoted.changed).toBe(true);
    expect(demoted.missing).toBe(false);
    expect(demoted.snapshot.entries.map((e) => ({ code: e.code, role: e.role }))).toEqual([
      { code: "AAAA2345", role: "guest" },
      { code: "BBBB2345", role: "host" },
    ]);
    const demoteGuestNoop = applyRecentRoomOp(
      demoted.snapshot,
      { kind: "remove", code: "AAAA2345", demoteIfPassworded: true },
      t0,
      [],
      noHost,
    );
    expect(demoteGuestNoop.changed).toBe(false);
    expect(demoteGuestNoop.missing).toBe(false);

    const removed = applyRecentRoomOp(twoHosts, { kind: "remove", code: "AAAA2345" }, t0, [], noHost);
    expect(removed.changed).toBe(true);
    expect(removed.missing).toBe(false);
    expect(removed.snapshot.entries.map((e) => e.code)).toEqual(["BBBB2345"]);

    // clear-all and set-disabled outcomes
    expect(applyRecentRoomOp(emptySnap, { kind: "clear-all" }, t0, [], noHost)).toEqual({
      snapshot: emptySnap,
      changed: false,
      missing: false,
    });
    expect(applyRecentRoomOp(twoHosts, { kind: "clear-all" }, t0, [], noHost)).toEqual({
      snapshot: emptySnap,
      changed: true,
      missing: false,
    });
    expect(
      applyRecentRoomOp({ entries: [], disabled: true }, { kind: "set-disabled", disabled: true }, t0, [], noHost),
    ).toEqual({ snapshot: { entries: [], disabled: true }, changed: false, missing: false });
    expect(
      applyRecentRoomOp(twoHosts, { kind: "set-disabled", disabled: true }, t0, [], noHost),
    ).toEqual({ snapshot: { entries: [], disabled: true }, changed: true, missing: false });

    // computeRecentRoomsView: demoteIfPassworded on passworded entry does NOT suppress host synthesis,
    // while removing passwordless entry suppresses synthesis until clear-all / set-disabled(true) / join
    const hostRooms = [{ code: "HOST2345", updatedAt: t0 - 100 }];
    const hasHost = (c: string) => c === "HOST2345";
    const passwordedHostSnap: RecentRoomsSnapshot = {
      entries: [{ code: "HOST2345", role: "host", lastJoinedAt: t0, peerNames: [], password: "PW1" }],
      disabled: false,
    };
    const afterDemoteView = computeRecentRoomsView(
      passwordedHostSnap,
      [{ kind: "remove", code: "HOST2345", demoteIfPassworded: true }],
      t0,
      hostRooms,
      hasHost,
    );
    expect(afterDemoteView.entries[0]?.role).toBe("guest");

    const plainHostSnap: RecentRoomsSnapshot = {
      entries: [{ code: "HOST2345", role: "host", lastJoinedAt: t0, peerNames: [] }],
      disabled: false,
    };
    const suppressedAfterRemove = computeRecentRoomsView(
      plainHostSnap,
      [
        { kind: "remove", code: "HOST2345", demoteIfPassworded: true },
        { kind: "patch", code: "HOST2345", field: "label", label: "Ghost" },
      ],
      t0,
      hostRooms,
      hasHost,
    );
    expect(suppressedAfterRemove.entries).toEqual([]);

    const clearedThenSynthesized = computeRecentRoomsView(
      plainHostSnap,
      [
        { kind: "remove", code: "HOST2345" },
        { kind: "clear-all" },
      ],
      t0,
      hostRooms,
      hasHost,
    );
    expect(clearedThenSynthesized.entries.map((e) => e.code)).toEqual(["HOST2345"]);

    const disabledThenReenabledView = computeRecentRoomsView(
      plainHostSnap,
      [
        { kind: "remove", code: "HOST2345" },
        { kind: "set-disabled", disabled: true },
        { kind: "set-disabled", disabled: false },
      ],
      t0,
      hostRooms,
      hasHost,
    );
    expect(disabledThenReenabledView.entries.map((e) => e.code)).toEqual(["HOST2345"]);

    const rejoinedAfterRemoveView = computeRecentRoomsView(
      plainHostSnap,
      [
        { kind: "remove", code: "HOST2345" },
        { kind: "join", code: "HOST2345", role: "host", lastJoinedAt: t0 + 10 },
      ],
      t0 + 10,
      hostRooms,
      hasHost,
    );
    expect(rejoinedAfterRemoveView.entries.map((e) => e.code)).toEqual(["HOST2345"]);
  });
});
