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
  isRecentRoomsDisabled,
  isRecentRoomsKeyAbsent,
  loadRecentRooms,
  mergeSynthesizedHostRooms,
  pruneExpiredRecentRooms,
  removePersistedRecentRoom,
  removeRecentRoom,
  renameRecentRoom,
  runWithRecentRoomsLock,
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  setRecentRoomsDisabled,
  sortAndBoundEntries,
  tryLoadRecentRooms,
  upsertRecentRoom,
  type LockManagerLike,
  type StorageLike,
} from "@src/recent-rooms";
import { applyPatchToEntry, type RecentRoomEntry } from "@src/recent-rooms-model";

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
  it("upserts, normalizes, and retains password/label/peerNames when omitted", () => {
    const storage = makeMemoryStorage();
    const t0 = 1_700_000_000_000;

    expect(loadRecentRooms(null, t0)).toEqual([]);
    expect(loadRecentRooms(storage, t0)).toEqual([]);

    const afterFirst = upsertRecentRoom(
      storage,
      {
        code: "  abcdefgh ",
        role: "guest",
        password: "PASS1234WORD5678",
        peerNames: ["Alice", "  Bob  ", "", "Carol", "Dave", "Eve"],
        label: "  Design Sync  ",
      },
      t0,
    );

    expect(afterFirst).toEqual([
      {
        code: "ABCDEFGH",
        role: "guest",
        lastJoinedAt: t0,
        password: "PASS1234WORD5678",
        label: "Design Sync",
        peerNames: ["Alice", "Bob", "Carol", "Dave"],
      },
    ]);

    const afterSecond = upsertRecentRoom(
      storage,
      {
        code: "ABCDEFGH",
        role: "guest",
        peerNames: [],
      },
      t0 + 5_000,
    );
    expect(afterSecond[0]).toEqual({
      code: "ABCDEFGH",
      role: "guest",
      lastJoinedAt: t0 + 5_000,
      password: "PASS1234WORD5678",
      label: "Design Sync",
      peerNames: ["Alice", "Bob", "Carol", "Dave"],
    });
  });

  it("ignores invalid room codes, null storage, and out-of-window timestamps", () => {
    const storage = makeMemoryStorage();
    const t0 = 1_700_000_000_000;

    expect(upsertRecentRoom(null, { code: "ABCDEFGH", role: "host" }, t0)).toEqual([]);
    expect(upsertRecentRoom(storage, { code: "BAD", role: "host" }, t0)).toEqual([]);
    expect(
      upsertRecentRoom(storage, { code: "ABCDEFGH", role: "host", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS }, t0),
    ).toEqual([]);
    expect(
      upsertRecentRoom(storage, { code: "ABCDEFGH", role: "host", lastJoinedAt: t0 + MAX_CLOCK_SKEW_MS + 1 }, t0),
    ).toEqual([]);
    expect(storage.store.size).toBe(0);
  });

  it("enforces 90-day TTL and 5-minute clock-skew boundaries", () => {
    const storage = makeMemoryStorage();
    const t0 = 1_700_000_000_000;

    upsertRecentRoom(storage, { code: "ABCDEFGH", role: "host", lastJoinedAt: t0 }, t0);
    upsertRecentRoom(
      storage,
      { code: "JKMNPQRS", role: "guest", lastJoinedAt: t0 + MAX_CLOCK_SKEW_MS },
      t0,
    );

    expect(loadRecentRooms(storage, t0 + RECENT_ROOM_TTL_MS - 1).map((r) => r.code)).toEqual([
      "JKMNPQRS",
      "ABCDEFGH",
    ]);
    expect(loadRecentRooms(storage, t0 + RECENT_ROOM_TTL_MS).map((r) => r.code)).toEqual(["JKMNPQRS"]);
    expect(loadRecentRooms(storage, t0 - 1).map((r) => r.code)).toEqual(["ABCDEFGH"]);
  });

  it("evicts oldest entries beyond MAX_STORED_RECENT_ROOMS (20) and promotes rejoined rooms", () => {
    const storage = makeMemoryStorage();
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const makeCode = (idx: number): string => `${alphabet[idx] ?? "A"}BCDEFG2`;
    const base = 1_700_000_000_000;

    for (let i = 0; i < MAX_STORED_RECENT_ROOMS; i++) {
      upsertRecentRoom(storage, { code: makeCode(i), role: "guest", lastJoinedAt: base + i * 100 }, base + 5000);
    }
    // Refresh room 0 so room 1 becomes oldest.
    upsertRecentRoom(storage, { code: makeCode(0), role: "guest", lastJoinedAt: base + 6000 }, base + 6000);
    // Adding 21st room evicts room 1 while retaining room 0.
    upsertRecentRoom(
      storage,
      { code: makeCode(MAX_STORED_RECENT_ROOMS), role: "host", lastJoinedAt: base + 7000 },
      base + 7000,
    );

    const loaded = loadRecentRooms(storage, base + 7000);
    expect(loaded).toHaveLength(MAX_STORED_RECENT_ROOMS);
    expect(loaded.some((r) => r.code === makeCode(1))).toBe(false);
    expect(loaded[0]?.code).toBe(makeCode(MAX_STORED_RECENT_ROOMS));
    expect(loaded[1]?.code).toBe(makeCode(0));
  });

  it("retains the 21st room when 21 rooms are upserted within the same millisecond", () => {
    const storage = makeMemoryStorage();
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const codes = Array.from({ length: MAX_STORED_RECENT_ROOMS + 1 }, (_, i) => `${alphabet[i] ?? "A"}SAME234`);
    const now = 1_700_000_000_000;

    for (const code of codes) {
      upsertRecentRoom(storage, { code, role: "guest", lastJoinedAt: now }, now);
    }

    const loaded = loadRecentRooms(storage, now);
    expect(loaded).toHaveLength(MAX_STORED_RECENT_ROOMS);
    expect(loaded[0]?.code).toBe(codes[MAX_STORED_RECENT_ROOMS]);
    expect(loaded.some((r) => r.code === codes[0])).toBe(false);
    expect(loaded.map((r) => r.code)).toEqual(codes.slice(1).reverse());
  });

  it("preserves array index among equal-lastJoinedAt entries when preserveOrder is true", () => {
    const storage = makeMemoryStorage();
    const now = 1_700_000_000_000;

    upsertRecentRoom(storage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
    upsertRecentRoom(storage, { code: "BBBB2345", role: "guest", lastJoinedAt: now }, now);
    upsertRecentRoom(storage, { code: "CCCC2345", role: "host", lastJoinedAt: now }, now);
    expect(loadRecentRooms(storage, now).map((r) => r.code)).toEqual(["CCCC2345", "BBBB2345", "AAAA2345"]);

    // In-place update with preserveOrder: true keeps AAAA2345 at index 2 and BBBB2345 at index 1.
    const afterPreserveA = upsertRecentRoom(
      storage,
      { code: "AAAA2345", role: "guest", lastJoinedAt: now, label: "Oldest Room", preserveOrder: true },
      now,
    );
    expect(afterPreserveA.map((r) => r.code)).toEqual(["CCCC2345", "BBBB2345", "AAAA2345"]);
    expect(afterPreserveA[2]?.label).toBe("Oldest Room");

    const afterPreserveB = upsertRecentRoom(
      storage,
      { code: "BBBB2345", role: "guest", lastJoinedAt: now, password: "UPDATED_PASSWORD", preserveOrder: true },
      now,
    );
    expect(afterPreserveB.map((r) => r.code)).toEqual(["CCCC2345", "BBBB2345", "AAAA2345"]);
    expect(afterPreserveB[1]?.password).toBe("UPDATED_PASSWORD");

    // Absent entry or changed lastJoinedAt or omitted preserveOrder still moves to index 0.
    const afterAbsent = upsertRecentRoom(
      storage,
      { code: "DDDD2345", role: "guest", lastJoinedAt: now, preserveOrder: true },
      now,
    );
    expect(afterAbsent.map((r) => r.code)).toEqual(["DDDD2345", "CCCC2345", "BBBB2345", "AAAA2345"]);

    const afterRejoin = upsertRecentRoom(
      storage,
      { code: "AAAA2345", role: "guest", lastJoinedAt: now },
      now,
    );
    expect(afterRejoin.map((r) => r.code)).toEqual(["AAAA2345", "DDDD2345", "CCCC2345", "BBBB2345"]);
  });

  it("renames, clamps labels to 40 code units safely, clears blank labels, and removes entries", () => {
    const storage = makeMemoryStorage();
    const t0 = 1_700_000_000_000;

    expect(sanitizeRecentRoomLabel("   ")).toBeUndefined();
    expect(sanitizeRecentRoomLabel("a".repeat(50))).toHaveLength(MAX_RECENT_ROOM_LABEL_LEN);
    // Avoid splitting trailing surrogate pair at index 40.
    const surrogateBoundary = `${"a".repeat(39)}\uD83D\uDE00`;
    expect(sanitizeRecentRoomLabel(surrogateBoundary)).toBe("a".repeat(39));
    expect(sanitizePeerNames(["  A ", "B", "C", "D", "E"])).toHaveLength(MAX_RECENT_ROOM_PEERS);

    upsertRecentRoom(storage, { code: "ABCDEFGH", role: "host", password: "SECRET1234567890" }, t0);
    upsertRecentRoom(storage, { code: "JKMNPQRS", role: "guest" }, t0 + 10);

    // Invalid or unknown code rename returns current list unchanged
    expect(renameRecentRoom(null, "ABCDEFGH", "Test", t0)).toEqual([]);
    expect(renameRecentRoom(storage, "BAD", "Test", t0)).toHaveLength(2);
    expect(renameRecentRoom(storage, "MNPQRSTU", "Test", t0)).toHaveLength(2);

    const renamed = renameRecentRoom(storage, "abcdefgh", `  ${"x".repeat(45)}  `, t0 + 20);
    const first = renamed.find((r) => r.code === "ABCDEFGH");
    expect(first?.label).toBe("x".repeat(40));

    const clearedLabel = renameRecentRoom(storage, "ABCDEFGH", "   ", t0 + 30);
    const updatedFirst = clearedLabel.find((r) => r.code === "ABCDEFGH");
    expect(updatedFirst).toBeDefined();
    expect(updatedFirst?.label).toBeUndefined();
    expect("label" in (updatedFirst ?? {})).toBe(false);

    expect(removeRecentRoom(null, "ABCDEFGH", t0)).toEqual([]);
    expect(removeRecentRoom(storage, "BAD", t0)).toHaveLength(2);

    const afterRemoveOne = removeRecentRoom(storage, "abcdefgh", t0 + 40);
    expect(afterRemoveOne.map((r) => r.code)).toEqual(["JKMNPQRS"]);
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(true);

    const afterRemoveLast = removeRecentRoom(storage, "JKMNPQRS", t0 + 50);
    expect(afterRemoveLast).toEqual([]);
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

    upsertRecentRoom(storage, { code: "ABCDEFGH", role: "guest" }, t0 + 60);
    clearAllPersistedRecentRooms(null);
    clearAllPersistedRecentRooms(storage);
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
  });

  it("reads and writes shared-device opt-out flag safely", () => {
    const storage = makeMemoryStorage();
    expect(isRecentRoomsDisabled(null)).toBe(false);
    expect(isRecentRoomsDisabled(storage)).toBe(false);

    setRecentRoomsDisabled(null, true);
    setRecentRoomsDisabled(storage, true);
    expect(storage.store.get(RECENT_ROOMS_OPT_OUT_KEY)).toBe("1");
    expect(isRecentRoomsDisabled(storage)).toBe(true);

    storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "true");
    expect(isRecentRoomsDisabled(storage)).toBe(true);

    setRecentRoomsDisabled(storage, false);
    expect(storage.store.has(RECENT_ROOMS_OPT_OUT_KEY)).toBe(false);
    expect(isRecentRoomsDisabled(storage)).toBe(false);
  });

  it("serializes concurrent storage updates via Web Locks and falls back safely", async () => {
    const storage = makeMemoryStorage();
    let tail: Promise<void> = Promise.resolve();
    const requestedNames: string[] = [];
    const serializedLocks: LockManagerLike = {
      request: async (name, cb) => {
        requestedNames.push(name);
        const prev = tail;
        let release: () => void = () => {};
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prev;
        try {
          await cb();
        } finally {
          release();
        }
      },
    };

    await Promise.all([
      runWithRecentRoomsLock(serializedLocks, () => {
        upsertRecentRoom(storage, { code: "ABCDEFGH", role: "host" }, 1000);
      }),
      runWithRecentRoomsLock(serializedLocks, () => {
        upsertRecentRoom(storage, { code: "JKMNPQRS", role: "guest" }, 1001);
      }),
    ]);

    expect(requestedNames).toEqual([RECENT_ROOMS_LOCK_NAME, RECENT_ROOMS_LOCK_NAME]);
    expect(loadRecentRooms(storage, 1002).map((r) => r.code)).toEqual(["JKMNPQRS", "ABCDEFGH"]);

    await runWithRecentRoomsLock(null, () => {
      upsertRecentRoom(storage, { code: "MNPQRSTU", role: "guest" }, 1003);
    });
    expect(loadRecentRooms(storage, 1004).some((r) => r.code === "MNPQRSTU")).toBe(true);

    let calls = 0;
    const throwsAfterCallback: LockManagerLike = {
      request: async (_name, cb) => {
        await cb();
        throw new Error("release error");
      },
    };
    await runWithRecentRoomsLock(throwsAfterCallback, () => {
      calls++;
    });
    expect(calls).toBe(1);

    const rejectsBeforeCallback: LockManagerLike = {
      request: () => Promise.reject(new Error("locks disabled")),
    };
    await runWithRecentRoomsLock(rejectsBeforeCallback, () => {
      calls++;
    });
    expect(calls).toBe(2);
  });

  it("handles corrupted JSON, mixed entries, duplicate codes, and throwing storage", () => {
    const badJson = makeMemoryStorage({ [RECENT_ROOMS_STORAGE_KEY]: "{bad" });
    expect(loadRecentRooms(badJson, 2000)).toEqual([]);

    const nonArray = makeMemoryStorage({ [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify({ code: "ABCDEFGH" }) });
    expect(loadRecentRooms(nonArray, 2000)).toEqual([]);

    const mixed = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        null,
        { code: "BAD", role: "guest", lastJoinedAt: 1000 },
        { code: "ABCDEFGH", role: "invalid", lastJoinedAt: 1000 },
        { code: " abcdefgh ", role: "guest", lastJoinedAt: 1500, label: "Older" },
        { code: "ABCDEFGH", role: "host", lastJoinedAt: 2000, label: "Newer", peerNames: ["A", "B"] },
        { code: "ABCDEFGH", role: "guest", lastJoinedAt: 1000, label: "Stale" },
      ]),
    });
    expect(loadRecentRooms(mixed, 3000)).toEqual([
      {
        code: "ABCDEFGH",
        role: "host",
        lastJoinedAt: 2000,
        label: "Newer",
        peerNames: ["A", "B"],
      },
    ]);

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadRecentRooms(throwing)).toEqual([]);
    expect(isRecentRoomsDisabled(throwing)).toBe(false);
    expect(() => setRecentRoomsDisabled(throwing, true)).not.toThrow();
    expect(() => clearAllPersistedRecentRooms(throwing)).not.toThrow();
    expect(() => upsertRecentRoom(throwing, { code: "ABCDEFGH", role: "guest" })).not.toThrow();
  });

  it("aligns password max length to 128 chars and rejects non-finite timestamps", () => {
    const storage = makeMemoryStorage();
    const t0 = 1_700_000_000_000;

    expect(MAX_RECENT_ROOM_PASSWORD_LEN).toBe(128);
    expect(sanitizePassword(undefined)).toBeUndefined();
    expect(sanitizePassword("   ")).toBeUndefined();
    expect(sanitizePassword(`  ${"A".repeat(128)}  `)).toBe("A".repeat(128));
    expect(sanitizePassword("A".repeat(129))).toBeUndefined();

    upsertRecentRoom(storage, { code: "ABCDEFGH", role: "guest", password: "P".repeat(80) }, t0);
    expect(loadRecentRooms(storage, t0)[0]?.password).toBe("P".repeat(80));

    upsertRecentRoom(storage, { code: "JKMNPQRS", role: "guest", password: "X".repeat(129) }, t0);
    const second = loadRecentRooms(storage, t0).find((r) => r.code === "JKMNPQRS");
    expect(second).toBeDefined();
    expect(second?.password).toBeUndefined();

    // Non-finite timestamp is rejected cleanly
    expect(
      upsertRecentRoom(storage, { code: "MNPQRSTU", role: "guest", lastJoinedAt: Number.NaN }, t0).some(
        (r) => r.code === "MNPQRSTU",
      ),
    ).toBe(false);

    // Raw localStorage schema trims password before enforcing 128-char max, rejects post-trim >128 or non-strings
    const paddedStorage = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "PADD2345", role: "guest", lastJoinedAt: t0, password: `  ${"Z".repeat(128)}  ` },
        { code: "BNKK2345", role: "guest", lastJoinedAt: t0, password: "   " },
        { code: "XVER2345", role: "guest", lastJoinedAt: t0, password: `  ${"Z".repeat(129)}  ` },
        { code: "NUMP2345", role: "guest", lastJoinedAt: t0, password: 12345 },
      ]),
    });
    const loadedPadded = loadRecentRooms(paddedStorage, t0);
    expect(loadedPadded.find((r) => r.code === "PADD2345")?.password).toBe("Z".repeat(128));
    const blankEntry = loadedPadded.find((r) => r.code === "BNKK2345");
    expect(blankEntry).toBeDefined();
    expect(blankEntry?.password).toBeUndefined();
    expect(loadedPadded.some((r) => r.code === "XVER2345")).toBe(false);
    expect(loadedPadded.some((r) => r.code === "NUMP2345")).toBe(false);
  });

  it("supports clearLabel and insertAfterCodes in upsertRecentRoom", () => {
    const storage = makeMemoryStorage();
    const t0 = 1_700_000_000_000;

    upsertRecentRoom(storage, { code: "AAAA2345", role: "guest", lastJoinedAt: t0, label: "Alpha" }, t0);
    // Omitting clearLabel or passing clearLabel: false retains existing label
    const retained = upsertRecentRoom(storage, { code: "AAAA2345", role: "guest", lastJoinedAt: t0, clearLabel: false }, t0);
    expect(retained[0]?.label).toBe("Alpha");

    // clearLabel: true with label: undefined clears existing label atomically
    const cleared = upsertRecentRoom(storage, { code: "AAAA2345", role: "guest", lastJoinedAt: t0, clearLabel: true }, t0);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toBeDefined();
    expect(cleared[0]?.label).toBeUndefined();
    expect("label" in (cleared[0] ?? {})).toBe(false);

    // Explicit label overrides clearLabel: true and sanitizes
    const overridden = upsertRecentRoom(
      storage,
      { code: "AAAA2345", role: "guest", lastJoinedAt: t0, label: "  Beta  ", clearLabel: true },
      t0,
    );
    expect(overridden[0]?.label).toBe("Beta");

    // insertAfterCodes places same-ms entry immediately after the last matching code
    upsertRecentRoom(storage, { code: "BBBB2345", role: "guest", lastJoinedAt: t0 }, t0);
    upsertRecentRoom(storage, { code: "CCCC2345", role: "guest", lastJoinedAt: t0 }, t0);
    // Current order: [CCCC2345, BBBB2345, AAAA2345]
    const placedMiddle = upsertRecentRoom(
      storage,
      { code: "DDDD2345", role: "guest", lastJoinedAt: t0, insertAfterCodes: ["CCCC2345", "BBBB2345"] },
      t0,
    );
    expect(placedMiddle.map((r) => r.code)).toEqual(["CCCC2345", "BBBB2345", "DDDD2345", "AAAA2345"]);

    // Cross-ms stability: newer lastJoinedAt still precedes older entries even when insertAfterCodes names an older code
    const crossMs = upsertRecentRoom(
      storage,
      { code: "EEEE2345", role: "host", lastJoinedAt: t0 + 100, insertAfterCodes: ["AAAA2345"] },
      t0 + 100,
    );
    expect(crossMs[0]?.code).toBe("EEEE2345");

    // 21-room eviction when inserted after all 20 same-ms entries
    const evictStorage = makeMemoryStorage();
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const codes = Array.from({ length: MAX_STORED_RECENT_ROOMS + 1 }, (_, i) => `${alphabet[i] ?? "A"}XNS2345`);
    for (let i = 1; i < codes.length; i++) {
      upsertRecentRoom(evictStorage, { code: codes[i] ?? "", role: "guest", lastJoinedAt: t0 }, t0);
    }
    const afterEvict = upsertRecentRoom(
      evictStorage,
      { code: codes[0] ?? "", role: "guest", lastJoinedAt: t0, insertAfterCodes: codes.slice(1) },
      t0,
    );
    expect(afterEvict).toHaveLength(MAX_STORED_RECENT_ROOMS);
    expect(afterEvict.some((r) => r.code === codes[0])).toBe(false);
  });

  it("filters, sorts, formats relative times, and merges synthesized host rooms", () => {
    const t0 = 1_700_000_000_000;
    const entries = sortAndBoundEntries([
      { code: "AAAA2345", role: "guest", lastJoinedAt: t0 - 1000, peerNames: ["Alice"], label: "Standup" },
      { code: "BBBB2345", role: "host", lastJoinedAt: t0, peerNames: ["Bob"] },
    ]);
    expect(entries.map((e) => e.code)).toEqual(["BBBB2345", "AAAA2345"]);
    expect(filterRecentRooms(entries, "  ")).toHaveLength(2);
    expect(filterRecentRooms(entries, "stand").map((e) => e.code)).toEqual(["AAAA2345"]);
    expect(filterRecentRooms(entries, "bob").map((e) => e.code)).toEqual(["BBBB2345"]);
    expect(formatRelativeTime(t0 - 120_000, t0)).toBe("2m ago");

    const synthesized: string[] = [];
    const merged = mergeSynthesizedHostRooms(
      entries,
      [
        { code: "BBBB2345", updatedAt: t0 + 500 }, // already in base -> skipped
        { code: "CCCC2345", updatedAt: t0 - 500 }, // included
        { code: "DDDD2345", updatedAt: t0 + 500 }, // excluded by predicate
      ],
      (code) => code !== "DDDD2345",
      (code) => synthesized.push(code),
    );
    expect(synthesized).toEqual(["CCCC2345"]);
    expect(merged.map((e) => e.code)).toEqual(["BBBB2345", "CCCC2345", "AAAA2345"]);
  });

  it("detects and prunes expired, corrupt, duplicate, and empty-array records while reporting storage write outcomes", () => {
    const t0 = 1_700_000_000_000;
    const empty = makeMemoryStorage();
    expect(hasStaleRecentRooms(null, t0)).toBe(false);
    expect(hasStaleRecentRooms(empty, t0)).toBe(false);
    expect(pruneExpiredRecentRooms(empty, t0)).toBe(false);
    expect(tryLoadRecentRooms(null, t0)).toEqual({ entries: [], ok: false });
    expect(tryLoadRecentRooms(empty, t0)).toEqual({ entries: [], ok: true });

    // Clean fresh entries are not stale -> prune is a no-op
    upsertRecentRoom(empty, { code: "AAAA2345", role: "guest", lastJoinedAt: t0 }, t0);
    expect(hasStaleRecentRooms(empty, t0)).toBe(false);
    expect(pruneExpiredRecentRooms(empty, t0)).toBe(false);

    // Mixed expired + valid preserves only valid
    const mixed = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "EXPD2345", role: "guest", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS },
        { code: "KEEP2345", role: "host", lastJoinedAt: t0 - 1000, label: "Valid" },
      ]),
    });
    expect(hasStaleRecentRooms(mixed, t0)).toBe(true);
    expect(pruneExpiredRecentRooms(mixed, t0)).toBe(true);
    expect(hasStaleRecentRooms(mixed, t0)).toBe(false);
    expect(loadRecentRooms(mixed, t0).map((r) => r.code)).toEqual(["KEEP2345"]);

    // All expired removes the key completely
    const allExpired = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "EXPD2345", role: "guest", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS },
      ]),
    });
    expect(pruneExpiredRecentRooms(allExpired, t0)).toBe(true);
    expect(allExpired.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

    // Corrupt JSON, non-array, empty-array leftovers are cleaned up
    for (const raw of ["{bad", JSON.stringify({ a: 1 }), "[]"]) {
      const s = makeMemoryStorage({ [RECENT_ROOMS_STORAGE_KEY]: raw });
      expect(hasStaleRecentRooms(s, t0)).toBe(true);
      expect(pruneExpiredRecentRooms(s, t0)).toBe(true);
      expect(s.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
    }

    // Boolean status helpers report success vs failure without throwing
    expect(setRecentRoomsDisabled(null, true)).toBe(false);
    expect(isRecentRoomsKeyAbsent(null)).toBe(false);
    expect(isRecentRoomsKeyAbsent(makeMemoryStorage())).toBe(true);
    expect(isRecentRoomsKeyAbsent(empty)).toBe(false);
    expect(isRecentRoomsKeyAbsent(makeMemoryStorage({ [RECENT_ROOMS_STORAGE_KEY]: "" }))).toBe(true);
    expect(isRecentRoomsKeyAbsent(makeMemoryStorage({ [RECENT_ROOMS_STORAGE_KEY]: "[]" }))).toBe(false);
    expect(clearAllPersistedRecentRooms(null)).toBe(false);
    expect(removePersistedRecentRoom(null, "AAAA2345", t0)).toBe(false);
    expect(removePersistedRecentRoom(empty, "BAD", t0)).toBe(false);
    expect(removePersistedRecentRoom(empty, "ZZZZ2345", t0)).toBe(true); // already absent -> true
    expect(removePersistedRecentRoom(empty, "AAAA2345", t0)).toBe(true);
    expect(empty.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(tryLoadRecentRooms(throwing, t0)).toEqual({ entries: [], ok: false });
    expect(hasStaleRecentRooms(throwing, t0)).toBe(false);
    expect(pruneExpiredRecentRooms(throwing, t0)).toBe(false);
    expect(setRecentRoomsDisabled(throwing, true)).toBe(false);
    expect(isRecentRoomsKeyAbsent(throwing)).toBe(false);
    expect(clearAllPersistedRecentRooms(throwing)).toBe(false);
    expect(removePersistedRecentRoom(throwing, "AAAA2345", t0)).toBe(false);
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
      clearLabel: true,
    });
    const afterRole = applyPatchToEntry(base, {
      kind: "patch",
      code: "AAAA2345",
      field: "role",
      role: "guest",
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
    expect(afterRole.peerNames).not.toBe(base.peerNames);
    expect(afterPeers.peerNames).not.toBe(incomingPeers);
    afterPw.peerNames.push("Mutated");
    expect(base.peerNames).toEqual(["Alice"]);
  });

  it("rewrites storage in removePersistedRecentRoom when expired or stale records were dropped (CR #10)", () => {
    const t0 = 1_700_000_000_000;

    // 1. Target expired before lock ran alongside a valid room -> expired entry & its secret are purged from raw JSON
    const mixed = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "EXPD2345", role: "guest", password: "EXPIRED_SECRET_12", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS },
        { code: "KEEP2345", role: "host", lastJoinedAt: t0 - 1000 },
      ]),
    });
    expect(removePersistedRecentRoom(mixed, "EXPD2345", t0)).toBe(true);
    const mixedRaw = JSON.parse(mixed.store.get(RECENT_ROOMS_STORAGE_KEY) ?? "[]") as Array<{ code: string }>;
    expect(mixedRaw.map((r) => r.code)).toEqual(["KEEP2345"]);

    // 2. Only expired target existed -> key is completely deleted from storage
    const onlyExpired = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "EXPD2345", role: "guest", password: "EXPIRED_SECRET_12", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS },
      ]),
    });
    expect(removePersistedRecentRoom(onlyExpired, "EXPD2345", t0)).toBe(true);
    expect(onlyExpired.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

    // 3. Removing an absent code when stale entries exist still rewrites storage to purge stale secrets
    const staleOther = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "EXPD2345", role: "guest", password: "EXPIRED_SECRET_12", lastJoinedAt: t0 - RECENT_ROOM_TTL_MS },
      ]),
    });
    expect(removePersistedRecentRoom(staleOther, "ZZZZ2345", t0)).toBe(true);
    expect(staleOther.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
  });
});
