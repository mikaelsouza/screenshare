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
  patchEntryInList,
  removeEntryFromList,
  upsertJoinEntry,
  type RecentRoomEntry,
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
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
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

    const syncEvents: string[] = [];
    await runWithRecentRoomsLock(null, () => syncEvents.push("no-lock"));
    expect(syncEvents).toEqual(["no-lock"]);

    const failingLocks: LockManagerLike = {
      request: async () => { throw new Error("locks unavailable"); },
    };
    const fallbackEvents: string[] = [];
    await runWithRecentRoomsLock(failingLocks, () => fallbackEvents.push("fallback"));
    expect(fallbackEvents).toEqual(["fallback"]);

    const throwingAfterRun: LockManagerLike = {
      request: async (_name, cb) => {
        await cb();
        throw new Error("post-cb error");
      },
    };
    let count = 0;
    await runWithRecentRoomsLock(throwingAfterRun, () => { count++; });
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
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    expect(tryLoadRecentRooms(throwing, t0)).toEqual({ entries: [], ok: false });
    expect(writePersistedRecentRooms(throwing, [{ code: "AAAA2345", role: "guest", lastJoinedAt: t0, peerNames: [] }])).toBe(
      false,
    );
  });

  it("detects and prunes expired, corrupt, duplicate, and empty-array records", () => {
    const t0 = 1_700_000_000_000;
    const empty = makeMemoryStorage();
    expect(hasStaleRecentRooms(empty, t0)).toBe(false);
    expect(pruneExpiredRecentRooms(empty, t0)).toBe(false);

    const emptyArray = makeMemoryStorage({ [RECENT_ROOMS_STORAGE_KEY]: "[]" });
    expect(hasStaleRecentRooms(emptyArray, t0)).toBe(true);
    expect(pruneExpiredRecentRooms(emptyArray, t0)).toBe(true);
    expect(emptyArray.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

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
    expect(mixed.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
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

    expect(formatRelativeTime(t0 + 10_000, t0)).toBe("Just now");
    expect(formatRelativeTime(t0 - 59_999, t0)).toBe("Just now");
    expect(formatRelativeTime(t0 - 60_000, t0)).toBe("1m ago");
    expect(formatRelativeTime(t0 - 59 * 60_000, t0)).toBe("59m ago");
    expect(formatRelativeTime(t0 - 60 * 60_000, t0)).toBe("1h ago");
    expect(formatRelativeTime(t0 - 23 * 3_600_000, t0)).toBe("23h ago");
    expect(formatRelativeTime(t0 - 24 * 3_600_000, t0)).toBe("1d ago");

    const filterEntries: RecentRoomEntry[] = [
      { code: "AAAA2345", role: "guest", lastJoinedAt: t0 - 10, peerNames: ["Alice", "Bob"], label: "Standup" },
      { code: "BBBB2345", role: "host", lastJoinedAt: t0, peerNames: ["Carol"] },
    ];
    expect(sortAndBoundEntries(filterEntries).map((e) => e.code)).toEqual(["BBBB2345", "AAAA2345"]);
    expect(filterRecentRooms(filterEntries, "")).toEqual(filterEntries);
    expect(filterRecentRooms(filterEntries, "bob").map((e) => e.code)).toEqual(["AAAA2345"]);
    expect(filterRecentRooms(filterEntries, "stand").map((e) => e.code)).toEqual(["AAAA2345"]);
    expect(filterRecentRooms(filterEntries, "bbbb").map((e) => e.code)).toEqual(["BBBB2345"]);

    const dedupMerged = mergeSynthesizedHostRooms(
      [],
      [
        { code: "CCCC2345", updatedAt: t0 },
        { code: "CCCC2345", updatedAt: t0 + 10 },
      ],
      () => true,
    );
    expect(dedupMerged).toHaveLength(1);
    expect(dedupMerged[0]?.lastJoinedAt).toBe(t0);
  });

  it("evaluates pure list helpers (upsertJoinEntry, patchEntryInList, removeEntryFromList)", () => {
    const t0 = 1_700_000_000_000;
    const noHost = () => false;

    expect(upsertJoinEntry([], { code: "AAAA2345", role: "guest", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS }, t0)).toBeNull();
    const joined = upsertJoinEntry([], { code: "AAAA2345", role: "host", lastJoinedAt: t0, password: "PW1" }, t0)!;
    expect(joined).toHaveLength(1);

    // Omitting password/peers preserves existing values, label, and clamps older lastJoinedAt
    const withLabel = patchEntryInList(
      joined,
      { kind: "patch", code: "AAAA2345", field: "label", label: "Team" },
      t0,
      [],
      noHost,
    )!;
    const updatedJoin = upsertJoinEntry(withLabel, { code: "AAAA2345", role: "host", lastJoinedAt: t0 - 500 }, t0)!;
    expect(updatedJoin[0]?.password).toBe("PW1");
    expect(updatedJoin[0]?.label).toBe("Team");
    expect(updatedJoin[0]?.lastJoinedAt).toBe(t0);

    // Patch no-op vs update vs synthesis
    expect(
      patchEntryInList(joined, { kind: "patch", code: "AAAA2345", field: "password", password: "PW1" }, t0, [], noHost),
    ).toBeNull();
    const patched = patchEntryInList(
      joined,
      { kind: "patch", code: "AAAA2345", field: "password", password: "PW2" },
      t0,
      [],
      noHost,
    )!;
    expect(patched[0]?.password).toBe("PW2");
    expect(
      patchEntryInList([], { kind: "patch", code: "HOST2345", field: "label", label: "Named" }, t0, [], noHost),
    ).toBeNull();
    const synthesized = patchEntryInList(
      [],
      { kind: "patch", code: "HOST2345", field: "label", label: "Named" },
      t0,
      [{ code: "HOST2345", updatedAt: t0 - 500 }],
      (c) => c === "HOST2345",
    )!;
    expect(synthesized).toEqual([
      { code: "HOST2345", role: "host", lastJoinedAt: t0 - 500, peerNames: [], label: "Named" },
    ]);

    // Remove & demoteIfPassworded
    expect(removeEntryFromList([], "AAAA2345", false)).toBeNull();
    const demoted = removeEntryFromList(patched, "AAAA2345", true)!;
    expect(demoted[0]?.role).toBe("guest");
    expect(removeEntryFromList(demoted, "AAAA2345", true)).toBeNull();
    expect(removeEntryFromList(demoted, "AAAA2345", false)).toEqual([]);
  });
});
