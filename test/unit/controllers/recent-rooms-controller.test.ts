import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { RecentRoomsController } from "@src/controllers/recent-rooms-controller";
import { SessionController } from "@src/controllers/session-controller";
import {
  HOST_ROOMS_LOCK_NAME,
  HOST_ROOMS_STORAGE_KEY,
  listPersistedHostRooms,
  readPersistedHostToken,
  writePersistedHostToken,
} from "@src/host-tokens";
import {
  MAX_CLOCK_SKEW_MS,
  MAX_STORED_RECENT_ROOMS,
  RECENT_ROOMS_LOCK_NAME,
  RECENT_ROOMS_OPT_OUT_KEY,
  RECENT_ROOMS_STORAGE_KEY,
  RECENT_ROOM_TTL_MS,
  formatRelativeTime,
  isRecentRoomsDisabled,
  loadRecentRooms,
  mergeSynthesizedHostRooms,
  upsertRecentRoom,
  type LockManagerLike,
  type StorageLike,
} from "@src/recent-rooms";

function createFullMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.get(key) ?? null;
    },
    key(i) {
      return [...store.keys()][i] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

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

function makeHarness(options?: {
  initialStorage?: Record<string, string>;
  creatorCodes?: Set<string>;
  now?: () => number;
  deferredLocks?: boolean;
}) {
  const storage = makeMemoryStorage(options?.initialStorage);
  const creatorCodes = options?.creatorCodes ?? new Set<string>();
  const tasks: Promise<unknown>[] = [];
  const pendingLockReleases: Array<() => void> = [];
  const nowFn = options?.now ?? (() => 1_700_000_000_000);
  const onRemoveHostToken = vi.fn((code: string) => {
    creatorCodes.delete(code);
  });
  const onForgetAllHostTokens = vi.fn(() => {
    creatorCodes.clear();
  });
  const onChange = vi.fn();

  const locks: LockManagerLike | null = options?.deferredLocks
    ? {
        request: async (_name, cb) => {
          await new Promise<void>((resolve) => {
            pendingLockReleases.push(() => {
              void Promise.resolve(cb()).finally(resolve);
            });
          });
        },
      }
    : null;

  const ctrl = new RecentRoomsController({
    getLocalStorage: () => storage,
    getLocks: () => locks,
    runBackground: (t) => {
      tasks.push(t);
    },
    hasSavedCreatorHostFor: (code) => creatorCodes.has(code),
    onRemoveHostToken,
    onForgetAllHostTokens,
    onChange,
    now: nowFn,
  });

  const flush = async (): Promise<void> => {
    while (pendingLockReleases.length > 0) {
      const next = pendingLockReleases.shift();
      next?.();
      await Promise.resolve();
    }
    await Promise.all(tasks);
  };

  return {
    ctrl,
    storage,
    creatorCodes,
    tasks,
    pendingLockReleases,
    onRemoveHostToken,
    onForgetAllHostTokens,
    onChange,
    flush,
  };
}

describe("RecentRoomsController", () => {
  it("records joins with creator host provenance only, retains omitted password/peers, and updates password/peers", async () => {
    let now = 1_700_000_000_000;
    const h = makeHarness({
      creatorCodes: new Set(["K7M9P2QR"]),
      now: () => now,
    });

    // Invalid code is ignored
    h.ctrl.recordJoin({ code: "BAD", password: "SECRET1234567890" });
    expect(h.ctrl.getRooms()).toEqual([]);

    // Creator room gets "host" role
    h.ctrl.recordJoin({
      code: "k7m9p2qr",
      password: "PASS1234HOST5678",
      peerNames: ["Alice", "Bob", "Carol", "Dave", "Eve"],
    });
    expect(h.ctrl.getRooms()).toEqual([
      {
        code: "K7M9P2QR",
        role: "host",
        lastJoinedAt: now,
        password: "PASS1234HOST5678",
        peerNames: ["Alice", "Bob", "Carol", "Dave"],
      },
    ]);

    // Guest room (even if promoted in-memory elsewhere, creatorCodes does not have it) gets "guest"
    now += 1000;
    h.ctrl.recordJoin({
      code: "GUES2345",
      password: "PASS1234GUES5678",
      peerNames: ["HostPeer"],
    });
    expect(h.ctrl.getRooms()[0]?.role).toBe("guest");

    // Rejoining locked room without password or with empty peerNames retains existing password and peerNames
    now += 1000;
    h.ctrl.recordJoin({ code: "GUES2345", peerNames: [] });
    const guestEntry = h.ctrl.getRooms().find((r) => r.code === "GUES2345");
    expect(guestEntry?.password).toBe("PASS1234GUES5678");
    expect(guestEntry?.peerNames).toEqual(["HostPeer"]);

    // updatePassword retains last password when locked=true, updates when locked=false
    h.ctrl.updatePassword("GUES2345", "SHOULDNOTOVERWRITE", true);
    expect(h.ctrl.getRooms().find((r) => r.code === "GUES2345")?.password).toBe("PASS1234GUES5678");

    h.ctrl.updatePassword("GUES2345", "ROTATED123456789", false);
    expect(h.ctrl.getRooms().find((r) => r.code === "GUES2345")?.password).toBe("ROTATED123456789");

    // Same password or empty password or unknown room are no-ops
    const changeCount = h.onChange.mock.calls.length;
    h.ctrl.updatePassword("GUES2345", "ROTATED123456789", false);
    h.ctrl.updatePassword("GUES2345", "   ", false);
    h.ctrl.updatePassword("UNKN2345", "ABCD1234EFGH5678", false);
    expect(h.onChange).toHaveBeenCalledTimes(changeCount);

    // updatePeers ignores empty arrays (e.g. peer left) and updates up to 4 non-empty names
    h.ctrl.updatePeers("GUES2345", []);
    expect(h.ctrl.getRooms().find((r) => r.code === "GUES2345")?.peerNames).toEqual(["HostPeer"]);
    h.ctrl.updatePeers("GUES2345", ["P1", "P2", "P3", "P4", "P5"]);
    expect(h.ctrl.getRooms().find((r) => r.code === "GUES2345")?.peerNames).toEqual(["P1", "P2", "P3", "P4"]);
    const afterPeers = h.onChange.mock.calls.length;
    h.ctrl.updatePeers("GUES2345", ["P1", "P2", "P3", "P4"]);
    expect(h.onChange).toHaveBeenCalledTimes(afterPeers);

    await h.flush();
    const persisted = loadRecentRooms(h.storage, now);
    expect(persisted.find((r) => r.code === "GUES2345")?.password).toBe("ROTATED123456789");
    expect(persisted.find((r) => r.code === "GUES2345")?.peerNames).toEqual(["P1", "P2", "P3", "P4"]);
  });

  it("removes rooms immediately on kicked and bad-password, and retains on temporary errors", async () => {
    const now = 1_700_000_000_000;
    const h = makeHarness({ now: () => now });
    h.ctrl.recordJoin({ code: "ABCD2345", password: "PASS1112WORD1112" });
    h.ctrl.recordJoin({ code: "EFGH2345", password: "PASS2223WORD2223" });
    h.ctrl.recordJoin({ code: "JKMN2345", password: "PASS3334WORD3334" });

    for (const tempErr of [
      "room-locked",
      "room-full",
      "rate-limited",
      "join-timeout",
      "connection-failed",
      "session-replaced",
    ]) {
      expect(h.ctrl.handleFatalError("ABCD2345", tempErr)).toBe(false);
    }
    expect(h.ctrl.getRooms().find((r) => r.code === "ABCD2345")?.password).toBe("PASS1112WORD1112");

    expect(h.ctrl.handleFatalError("ABCD2345", "kicked")).toBe(true);
    expect(h.ctrl.handleFatalError("EFGH2345", "bad-password")).toBe(true);
    expect(h.ctrl.handleFatalError("UNKN9999", "kicked")).toBe(false);
    expect(h.ctrl.handleFatalError("BAD", "kicked")).toBe(false);

    expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["JKMN2345"]);
    await h.flush();
    expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["JKMN2345"]);
  });

  it("synthesizes legacy host-rooms entries without duplicating recent-rooms and supports renaming them", async () => {
    const now = 1_700_000_000_000;
    const h = makeHarness({
      creatorCodes: new Set(["ABCD2345", "EFGH2345"]),
      now: () => now,
    });
    writePersistedHostToken(h.storage, "ABCD2345", "tok-legacy", now - 5_000);
    writePersistedHostToken(h.storage, "EFGH2345", "tok-both", now - 2_000);
    upsertRecentRoom(
      h.storage,
      {
        code: "EFGH2345",
        role: "host",
        password: "PASSBOTH12345678",
        label: "Existing Label",
        peerNames: ["PeerA"],
        lastJoinedAt: now - 1_000,
      },
      now,
    );

    h.ctrl.syncFromStorage();
    const rooms = h.ctrl.getRooms();
    expect(rooms.map((r) => r.code)).toEqual(["EFGH2345", "ABCD2345"]);
    expect(rooms[0]?.label).toBe("Existing Label");
    expect(rooms[1]).toEqual({
      code: "ABCD2345",
      role: "host",
      lastJoinedAt: now - 5_000,
      peerNames: [],
    });

    // Renaming a synthesized host room persists it to recent-rooms
    h.ctrl.setEditingCode("abcd2345");
    expect(h.ctrl.getEditingCode()).toBe("ABCD2345");
    h.ctrl.rename("ABCD2345", "  Legacy Host Room  ");
    expect(h.ctrl.getEditingCode()).toBeNull();
    expect(h.ctrl.getRooms().find((r) => r.code === "ABCD2345")?.label).toBe("Legacy Host Room");

    // Rename on unknown or invalid code is handled safely
    h.ctrl.rename("BAD", "Nope");
    h.ctrl.rename("UNKN2345", "Nope");

    await h.flush();
    expect(loadRecentRooms(h.storage, now).find((r) => r.code === "ABCD2345")?.label).toBe("Legacy Host Room");
  });

  it("demotes or removes on handleCreatorHostForgotten depending on password presence", async () => {
    const now = 1_700_000_000_000;
    const h = makeHarness({ creatorCodes: new Set(["PQRS2345", "TUVW2345"]), now: () => now });
    h.ctrl.recordJoin({ code: "PQRS2345", password: "SECRET1234567890" });
    h.ctrl.recordJoin({ code: "TUVW2345" });

    h.ctrl.handleCreatorHostForgotten("PQRS2345");
    expect(h.ctrl.getRooms().find((r) => r.code === "PQRS2345")?.role).toBe("guest");

    h.ctrl.handleCreatorHostForgotten("TUVW2345");
    expect(h.ctrl.getRooms().some((r) => r.code === "TUVW2345")).toBe(false);

    h.ctrl.handleCreatorHostForgotten("BAD");
    h.ctrl.handleCreatorHostForgotten("UNKN2345");

    await h.flush();
    const stored = loadRecentRooms(h.storage, now);
    expect(stored.find((r) => r.code === "PQRS2345")?.role).toBe("guest");
    expect(stored.some((r) => r.code === "TUVW2345")).toBe(false);
  });

  it("supports search filtering across code, label, and peerNames and resets search when dropping below 3 rooms", () => {
    const h = makeHarness();
    h.ctrl.recordJoin({ code: "AAAA2345", peerNames: ["Zelda"] });
    h.ctrl.recordJoin({ code: "BBBB2345", peerNames: ["Mario"] });
    h.ctrl.recordJoin({ code: "CCCC2345", peerNames: ["Luigi"] });
    h.ctrl.rename("AAAA2345", "Design Critique");

    h.ctrl.setSearchQuery("design");
    expect(h.ctrl.getFilteredRooms().map((r) => r.code)).toEqual(["AAAA2345"]);

    h.ctrl.setSearchQuery("bbbb");
    expect(h.ctrl.getFilteredRooms().map((r) => r.code)).toEqual(["BBBB2345"]);

    h.ctrl.setSearchQuery("luigi");
    expect(h.ctrl.getFilteredRooms().map((r) => r.code)).toEqual(["CCCC2345"]);

    // Deleting a room drops count from 3 to 2 and resets searchQuery
    h.ctrl.remove("CCCC2345");
    expect(h.onRemoveHostToken).toHaveBeenCalledWith("CCCC2345");
    expect(h.ctrl.getSearchQuery()).toBe("");
    expect(h.ctrl.getFilteredRooms().map((r) => r.code)).toEqual(["BBBB2345", "AAAA2345"]);
  });

  it("handles setDisabled, clearAll, cross-tab syncFromStorage, and deferred Web Lock race guards", async () => {
    const now = 1_700_000_000_000;
    const h = makeHarness({
      creatorCodes: new Set(["K7M9P2QR"]),
      now: () => now,
      deferredLocks: true,
    });
    writePersistedHostToken(h.storage, "K7M9P2QR", "tok-1", now);
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms()).toHaveLength(1);

    // Record join and immediately remove before Web Lock runs; remove must win and syncFromStorage must not resurrect
    h.ctrl.recordJoin({ code: "RACE2345", password: "RACEPASS12345678" });
    h.ctrl.remove("RACE2345");
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms().some((r) => r.code === "RACE2345")).toBe(false);
    await h.flush();
    expect(loadRecentRooms(h.storage, now).some((r) => r.code === "RACE2345")).toBe(false);

    // Demoting via handleCreatorHostForgotten while Web Lock is pending must not be clobbered by syncFromStorage
    h.creatorCodes.add("DEMT2345");
    h.ctrl.recordJoin({ code: "DEMT2345", password: "DEMTPASS12345678" });
    await h.flush();
    h.creatorCodes.delete("DEMT2345");
    h.ctrl.handleCreatorHostForgotten("DEMT2345");
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms().find((r) => r.code === "DEMT2345")?.role).toBe("guest");
    await h.flush();
    expect(loadRecentRooms(h.storage, now).find((r) => r.code === "DEMT2345")?.role).toBe("guest");

    // Clear all wipes both recent-rooms and host-rooms even while lock is pending
    h.ctrl.recordJoin({ code: "KEEP2345", password: "KEEPPASS12345678" });
    h.ctrl.clearAll();
    expect(h.onForgetAllHostTokens).toHaveBeenCalledTimes(1);
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms()).toEqual([]);
    await h.flush();
    expect(h.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

    // Disable prevents saving and wipes existing rooms; syncFromStorage while lock pending preserves disabled=true
    h.ctrl.recordJoin({ code: "TEMP2345", password: "TEMPPASS12345678" });
    h.ctrl.setDisabled(true);
    expect(h.ctrl.isDisabled()).toBe(true);
    h.ctrl.syncFromStorage();
    expect(h.ctrl.isDisabled()).toBe(true);
    expect(h.ctrl.getRooms()).toEqual([]);
    h.ctrl.recordJoin({ code: "BVCX2345", password: "BLCKPASS12345678" });
    expect(h.ctrl.getRooms()).toEqual([]);
    await h.flush();
    expect(h.storage.store.get(RECENT_ROOMS_OPT_OUT_KEY)).toBe("1");

    // Re-enable restores ability to save and picks up cross-tab storage updates
    h.ctrl.setDisabled(false);
    await h.flush();
    expect(h.ctrl.isDisabled()).toBe(false);
    expect(h.storage.store.has(RECENT_ROOMS_OPT_OUT_KEY)).toBe(false);

    upsertRecentRoom(h.storage, { code: "XTAB2345", role: "guest", password: "XTABPASS12345678" }, now);
    h.storage.store.set(HOST_ROOMS_STORAGE_KEY, JSON.stringify([]));
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["XTAB2345"]);
  });

  it("formats relative timestamps and clamps future clock skew to Just now", () => {
    const now = 1_700_000_000_000;
    expect(formatRelativeTime(now + 60_000, now)).toBe("Just now");
    expect(formatRelativeTime(now - 59_000, now)).toBe("Just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 4 * 86_400_000, now)).toBe("4d ago");
  });

  it("preserves post-clearAll and post-re-enable recordJoin across syncFromStorage and SessionController cross-lock ordering", async () => {
    const now = 1_700_000_000_000;

    // 1A: Standalone clearAll() -> recordJoin() -> syncFromStorage() before lock flushes
    const h = makeHarness({ deferredLocks: true, now: () => now });
    h.ctrl.recordJoin({ code: "AAAA2345", password: "OLDPASS123456789" });
    await h.flush();
    h.ctrl.clearAll();
    h.ctrl.recordJoin({ code: "BBBB2345", password: "NEWPASS123456789" });
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345"]);
    await h.flush();
    expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345"]);
    expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["BBBB2345"]);

    // 1C: setDisabled(true) -> setDisabled(false) -> recordJoin() -> syncFromStorage() before lock #1 flushes
    h.ctrl.setDisabled(true);
    h.ctrl.setDisabled(false);
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms()).toEqual([]); // pre-disable BBBB2345 must not resurrect
    h.ctrl.recordJoin({ code: "CCCC2345", password: "REENPASS12345678" });
    h.ctrl.syncFromStorage();
    expect(h.ctrl.isDisabled()).toBe(false);
    expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["CCCC2345"]);
    await h.flush();
    expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["CCCC2345"]);
    expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["CCCC2345"]);

    // 1B: Real SessionController cross-lock ordering where screenshare:host-rooms resolves before screenshare:recent-rooms
    const fullStorage = createFullMemoryStorage();
    const sessStorage = createFullMemoryStorage();
    const queues = new Map<string, Array<() => Promise<void>>>();
    const tasks: Promise<unknown>[] = [];
    const keyedLocks = {
      request: (name: string, cb: () => unknown) =>
        new Promise<void>((resolve, reject) => {
          const list = queues.get(name) ?? [];
          list.push(async () => {
            try {
              await cb();
              resolve();
            } catch (err: unknown) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
          queues.set(name, list);
        }),
    } as unknown as LockManager;
    const flushQueue = async (name: string): Promise<void> => {
      const list = queues.get(name);
      while (list && list.length > 0) {
        const next = list.shift();
        await next?.();
      }
    };

    let recentCtrl: RecentRoomsController | null = null;
    const session = new SessionController({
      getLocalStorage: () => fullStorage,
      getSessionStorage: () => sessStorage,
      getLocks: () => keyedLocks,
      runBackground: (t) => {
        tasks.push(t);
      },
      onForgetHostUiChange: () => {
        recentCtrl?.syncFromStorage();
      },
    });
    recentCtrl = new RecentRoomsController({
      getLocalStorage: () => fullStorage,
      getLocks: () => keyedLocks,
      runBackground: (t) => {
        tasks.push(t);
      },
      hasSavedCreatorHostFor: (code) => session.hasSavedCreatorHostFor(code),
      onRemoveHostToken: (code, onlyIfMatching) => session.forgetCreatorHostToken(code, onlyIfMatching),
      onForgetAllHostTokens: () => session.forgetAllHostTokens(),
      onChange: vi.fn(),
      now: () => now,
    });

    session.saveCreatorHostToken("AAAA2345", "tok-old");
    recentCtrl.recordJoin({ code: "AAAA2345", password: "OLDPASS123456789" });
    await flushQueue(HOST_ROOMS_LOCK_NAME);
    await flushQueue(RECENT_ROOMS_LOCK_NAME);

    recentCtrl.clearAll();
    recentCtrl.recordJoin({ code: "BBBB2345", password: "NEWPASS123456789" });
    await flushQueue(HOST_ROOMS_LOCK_NAME); // triggers onForgetHostUiChange -> syncFromStorage() while pendingClearAll > 0
    expect(recentCtrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345"]);

    await flushQueue(RECENT_ROOMS_LOCK_NAME);
    await Promise.all(tasks);
    expect(recentCtrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345"]);
    expect(loadRecentRooms(fullStorage, now).map((r) => r.code)).toEqual(["BBBB2345"]);
  });

  it("guards removeFromRecentsOnly against rejected out-of-order lock fallback after a newer recordJoin", async () => {
    const now = 1_700_000_000_000;
    const storage = makeMemoryStorage();
    const tasks: Promise<unknown>[] = [];
    const rejectHolder: { fn?: (err: Error) => void } = {};
    let lockCall = 0;

    const locks: LockManagerLike = {
      request: (_name, cb) => {
        lockCall += 1;
        if (lockCall === 1) {
          return new Promise<void>((_resolve, reject) => {
            rejectHolder.fn = reject;
          });
        }
        return Promise.resolve(cb());
      },
    };

    const ctrl = new RecentRoomsController({
      getLocalStorage: () => storage,
      getLocks: () => locks,
      runBackground: (t) => {
        tasks.push(t);
      },
      hasSavedCreatorHostFor: () => false,
      onRemoveHostToken: vi.fn(),
      onForgetAllHostTokens: vi.fn(),
      onChange: vi.fn(),
      now: () => now,
    });

    ctrl.remove("AAAA2345");
    ctrl.recordJoin({ code: "AAAA2345", password: "NEWPASS123456789" });
    await Promise.resolve();
    expect(loadRecentRooms(storage, now).map((r) => r.code)).toEqual(["AAAA2345"]);

    rejectHolder.fn?.(new Error("AbortError"));
    await Promise.all(tasks);

    expect(ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345"]);
    expect(loadRecentRooms(storage, now).map((r) => r.code)).toEqual(["AAAA2345"]);
  });

  it("clears host-rooms via onRemoveHostToken on handleFatalError(kicked | bad-password) so rooms do not resurrect", async () => {
    const now = 1_700_000_000_000;
    const creatorCodes = new Set(["KYCK2345", "BADP2345"]);
    const h = makeHarness({
      creatorCodes,
      now: () => now,
    });
    writePersistedHostToken(h.storage, "KYCK2345", "tok-kick", now);
    writePersistedHostToken(h.storage, "BADP2345", "tok-badp", now);
    h.ctrl.recordJoin({ code: "KYCK2345", password: "PASS123456789012" });
    h.ctrl.recordJoin({ code: "BADP2345", password: "PASS223456789012" });
    await h.flush();

    expect(h.ctrl.handleFatalError("KYCK2345", "kicked", "tok-kick")).toBe(true);
    expect(h.ctrl.handleFatalError("BADP2345", "bad-password", "tok-badp")).toBe(true);
    expect(h.onRemoveHostToken).toHaveBeenCalledWith("KYCK2345", "tok-kick");
    expect(h.onRemoveHostToken).toHaveBeenCalledWith("BADP2345", "tok-badp");

    // Even if host-rooms still had entries until its own lock completes, hasSavedCreatorHostFor + pendingRemovals prevent resurrection
    await h.flush();
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms()).toEqual([]);
    expect(readPersistedHostToken(h.storage, "KYCK2345", now)).toBe("tok-kick"); // mock onRemoveHostToken only updates creatorCodes

    // Without expectedHostToken (unauthenticated guest fatal error), creator token is NOT wiped
    h.onRemoveHostToken.mockClear();
    creatorCodes.add("GUST2345");
    writePersistedHostToken(h.storage, "GUST2345", "tok-other-tab", now);
    h.ctrl.recordJoin({ code: "GUST2345", password: "GUEST_PASS_12345" });
    await h.flush();
    expect(h.ctrl.handleFatalError("GUST2345", "kicked")).toBe(true);
    expect(h.onRemoveHostToken).not.toHaveBeenCalled();
    expect(readPersistedHostToken(h.storage, "GUST2345", now)).toBe("tok-other-tab");
  });

  it("aligns password max length (128) across memory and storage, handles overlapping writes, and clears editingCode on external removal", async () => {
    const now = 1_700_000_000_000;
    const h = makeHarness({ deferredLocks: true, now: () => now });

    // 80-char and 128-char passwords match between memory and storage; 129-char is rejected in both
    h.ctrl.recordJoin({ code: "PASS8234", password: "A".repeat(80) });
    h.ctrl.recordJoin({ code: "PASS28AA", password: "B".repeat(128) });
    h.ctrl.recordJoin({ code: "PASS29AA", password: "C".repeat(129) });
    expect(h.ctrl.getRooms().find((r) => r.code === "PASS8234")?.password).toBe("A".repeat(80));
    expect(h.ctrl.getRooms().find((r) => r.code === "PASS28AA")?.password).toBe("B".repeat(128));
    const memPass29 = h.ctrl.getRooms().find((r) => r.code === "PASS29AA");
    expect(memPass29).toBeDefined();
    expect(memPass29?.password).toBeUndefined();

    // updatePassword ignores >128 char passwords without changing existing valid password
    h.ctrl.updatePassword("PASS8234", "D".repeat(129), false);
    expect(h.ctrl.getRooms().find((r) => r.code === "PASS8234")?.password).toBe("A".repeat(80));

    // Overlapping writes (pendingWrites > 1) for PASS8234: syncFromStorage between locks preserves in-memory entry
    h.ctrl.updatePeers("PASS8234", ["PeerOne"]);
    const firstLock = h.pendingLockReleases.shift();
    firstLock?.();
    await Promise.resolve();
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms().find((r) => r.code === "PASS8234")?.peerNames).toEqual(["PeerOne"]);

    await h.flush();
    expect(loadRecentRooms(h.storage, now).find((r) => r.code === "PASS8234")?.password).toBe("A".repeat(80));
    expect(loadRecentRooms(h.storage, now).find((r) => r.code === "PASS28AA")?.password).toBe("B".repeat(128));
    const diskPass29 = loadRecentRooms(h.storage, now).find((r) => r.code === "PASS29AA");
    expect(diskPass29).toBeDefined();
    expect(diskPass29?.password).toBeUndefined();

    // External storage removal clears active editingCode
    h.ctrl.setEditingCode("PASS8234");
    expect(h.ctrl.getEditingCode()).toBe("PASS8234");
    h.storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getEditingCode()).toBeNull();
  });

  it("guards clearAll, setDisabled, and superseded enqueueWrite against rejected out-of-order lock fallbacks and preserves fields across rename", async () => {
    const now = 1_700_000_000_000;

    const createControllableHarness = () => {
      const storage = makeMemoryStorage();
      const tasks: Promise<unknown>[] = [];
      const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve, reject) => {
            pending.push({
              resolve: () => {
                void Promise.resolve(cb()).finally(resolve);
              },
              reject,
            });
          }),
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });
      return { ctrl, storage, tasks, pending };
    };

    // 1. clearAll() whose locks.request rejects after a subsequent recordJoin("BBBB2345") succeeded
    {
      const h = createControllableHarness();
      h.ctrl.recordJoin({ code: "AAAA2345", password: "OLD_PASSWORD_1111" });
      h.pending.shift()?.resolve();
      await Promise.all(h.tasks.splice(0));

      h.ctrl.clearAll();
      const clearLock = h.pending.shift();
      h.ctrl.recordJoin({ code: "BBBB2345", password: "NEWPASS123456789" });
      const joinLock = h.pending.shift();
      joinLock?.resolve();
      await Promise.resolve();
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["BBBB2345"]);

      clearLock?.reject(new Error("AbortError"));
      await Promise.all(h.tasks.splice(0));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345"]);
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["BBBB2345"]);
    }

    // 2A. setDisabled(true) whose locks.request rejects after setDisabled(false) + recordJoin("CCCC2345") succeeded
    {
      const h = createControllableHarness();
      h.ctrl.recordJoin({ code: "AAAA2345", password: "OLD_PASSWORD_1111" });
      h.pending.shift()?.resolve();
      await Promise.all(h.tasks.splice(0));

      h.ctrl.setDisabled(true);
      const disableLock = h.pending.shift();
      h.ctrl.setDisabled(false);
      const enableLock = h.pending.shift();
      h.ctrl.recordJoin({ code: "CCCC2345", password: "NEWPASS123456789" });
      const joinLock = h.pending.shift();

      enableLock?.resolve();
      joinLock?.resolve();
      await Promise.resolve();
      expect(isRecentRoomsDisabled(h.storage)).toBe(false);
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["CCCC2345"]);

      disableLock?.reject(new Error("AbortError"));
      await Promise.all(h.tasks.splice(0));
      expect(h.ctrl.isDisabled()).toBe(false);
      expect(isRecentRoomsDisabled(h.storage)).toBe(false);
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["CCCC2345"]);
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["CCCC2345"]);
    }

    // 2B. setDisabled(false) whose locks.request rejects after setDisabled(true) succeeded
    {
      const h = createControllableHarness();
      h.ctrl.setDisabled(true);
      h.pending.shift()?.resolve();
      await Promise.all(h.tasks.splice(0));

      h.ctrl.setDisabled(false);
      const enableLock = h.pending.shift();
      h.ctrl.setDisabled(true);
      const disableLock = h.pending.shift();

      disableLock?.resolve();
      await Promise.resolve();
      expect(isRecentRoomsDisabled(h.storage)).toBe(true);

      enableLock?.reject(new Error("AbortError"));
      await Promise.all(h.tasks.splice(0));
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(isRecentRoomsDisabled(h.storage)).toBe(true);
    }

    // 3. Superseded recordJoin whose locks.request rejects after updatePassword/updatePeers/rename succeeded
    {
      const h = createControllableHarness();
      h.ctrl.recordJoin({ code: "AAAA2345", password: "OLD_PASSWORD_1111" });
      const joinLock = h.pending.shift();
      h.ctrl.updatePassword("AAAA2345", "NEW_PASSWORD_2222", false);
      const pwLock = h.pending.shift();
      h.ctrl.updatePeers("AAAA2345", ["NewPeer"]);
      const peersLock = h.pending.shift();
      h.ctrl.rename("AAAA2345", "");
      const renameLock = h.pending.shift();

      pwLock?.resolve();
      peersLock?.resolve();
      renameLock?.resolve();
      await Promise.resolve();

      joinLock?.reject(new Error("AbortError"));
      await Promise.all(h.tasks.splice(0));

      const mem = h.ctrl.getRooms().find((r) => r.code === "AAAA2345");
      const persisted = loadRecentRooms(h.storage, now).find((r) => r.code === "AAAA2345");
      expect(mem?.password).toBe("NEW_PASSWORD_2222");
      expect(mem?.peerNames).toEqual(["NewPeer"]);
      expect(mem?.label).toBeUndefined();
      expect(persisted?.password).toBe("NEW_PASSWORD_2222");
      expect(persisted?.peerNames).toEqual(["NewPeer"]);
      expect(persisted?.label).toBeUndefined();
    }

    // 4. Normal FIFO recordJoin -> rename (both non-empty and empty-clear) retains password and peerNames in storage
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({
        code: "FFFF2345",
        password: "FIFOPASS12345678",
        peerNames: ["Alice", "Bob"],
      });
      h.ctrl.rename("FFFF2345", "Design Review");
      await h.flush();

      const named = loadRecentRooms(h.storage, now).find((r) => r.code === "FFFF2345");
      expect(named).toMatchObject({
        code: "FFFF2345",
        password: "FIFOPASS12345678",
        peerNames: ["Alice", "Bob"],
        label: "Design Review",
      });

      h.ctrl.recordJoin({
        code: "EMPT2345",
        password: "EMPTPASS12345678",
        peerNames: ["Carol"],
      });
      h.ctrl.rename("EMPT2345", "");
      await h.flush();

      const cleared = loadRecentRooms(h.storage, now).find((r) => r.code === "EMPT2345");
      expect(cleared).toMatchObject({
        code: "EMPT2345",
        password: "EMPTPASS12345678",
        peerNames: ["Carol"],
      });
      expect(cleared?.label).toBeUndefined();

      // Clearing an existing persisted label followed immediately by updatePassword before lock flushes keeps label cleared
      h.ctrl.rename("FFFF2345", "");
      h.ctrl.updatePassword("FFFF2345", "FIFONEWP12345678", false);
      await h.flush();
      const afterClearThenPw = loadRecentRooms(h.storage, now).find((r) => r.code === "FFFF2345");
      expect(afterClearThenPw?.password).toBe("FIFONEWP12345678");
      expect(afterClearThenPw?.peerNames).toEqual(["Alice", "Bob"]);
      expect(afterClearThenPw?.label).toBeUndefined();
    }
  });

  it("does not resurrect deleted/kicked credentials or cleared labels on subsequent recordJoin (FIFO and rejected lock fallbacks)", async () => {
    const now = 1_700_000_000_000;

    // 1. Normal FIFO: remove -> recordJoin({ code }) does not resurrect password, label, or peerNames
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345", password: "OLD_PASSWORD_123", peerNames: ["Alice"] });
      h.ctrl.rename("AAAA2345", "Old Label");
      await h.flush();

      h.ctrl.remove("AAAA2345");
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flush();

      const mem = h.ctrl.getRooms().find((r) => r.code === "AAAA2345");
      const persisted = loadRecentRooms(h.storage, now).find((r) => r.code === "AAAA2345");
      expect(mem?.password).toBeUndefined();
      expect(mem?.label).toBeUndefined();
      expect(mem?.peerNames).toEqual([]);
      expect(persisted?.password).toBeUndefined();
      expect(persisted?.label).toBeUndefined();
      expect(persisted?.peerNames).toEqual([]);
    }

    // 2. Normal FIFO: handleFatalError("kicked"), handleCreatorHostForgotten (passwordless), and rename("") -> remove -> recordJoin({ password })
    {
      const creatorCodes = new Set(["HCST2345"]);
      const h = makeHarness({ deferredLocks: true, creatorCodes, now: () => now });
      h.ctrl.recordJoin({ code: "KCCK2345", password: "BANNED_PASSWORD1", peerNames: ["Host"] });
      h.ctrl.rename("KCCK2345", "Kicked Room");
      h.ctrl.recordJoin({ code: "HCST2345", peerNames: ["GuestOne"] });
      h.ctrl.rename("HCST2345", "Host Room");
      h.ctrl.recordJoin({ code: "AABB2345", password: "OLD_PASSWORD_123" });
      h.ctrl.rename("AABB2345", "Secret Project");
      await h.flush();

      h.ctrl.handleFatalError("KCCK2345", "kicked");
      h.ctrl.recordJoin({ code: "KCCK2345" });

      creatorCodes.delete("HCST2345");
      h.ctrl.handleCreatorHostForgotten("HCST2345");
      h.ctrl.recordJoin({ code: "HCST2345" });

      h.ctrl.rename("AABB2345", "");
      h.ctrl.remove("AABB2345");
      h.ctrl.recordJoin({ code: "AABB2345", password: "NEW_PASS_9999999" });
      await h.flush();

      for (const code of ["KCCK2345", "HCST2345"]) {
        const mem = h.ctrl.getRooms().find((r) => r.code === code);
        const persisted = loadRecentRooms(h.storage, now).find((r) => r.code === code);
        expect(mem?.password).toBeUndefined();
        expect(mem?.label).toBeUndefined();
        expect(mem?.peerNames).toEqual([]);
        expect(persisted?.password).toBeUndefined();
        expect(persisted?.label).toBeUndefined();
        expect(persisted?.peerNames).toEqual([]);
      }

      const memRejoined = h.ctrl.getRooms().find((r) => r.code === "AABB2345");
      const persistedRejoined = loadRecentRooms(h.storage, now).find((r) => r.code === "AABB2345");
      expect(memRejoined?.label).toBeUndefined();
      expect(memRejoined?.password).toBe("NEW_PASS_9999999");
      expect(persistedRejoined?.label).toBeUndefined();
      expect(persistedRejoined?.password).toBe("NEW_PASS_9999999");
    }

    // 3. Rejected out-of-order locks.request fallbacks for remove, handleFatalError("kicked"), and rename("") -> remove -> recordJoin
    {
      const storage = makeMemoryStorage();
      const tasks: Promise<unknown>[] = [];
      const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve, reject) => {
            pending.push({
              resolve: () => {
                void Promise.resolve(cb()).finally(resolve);
              },
              reject,
            });
          }),
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      ctrl.recordJoin({ code: "XANE2345", password: "OLD_SECRET_12345", peerNames: ["Alice"] });
      ctrl.rename("XANE2345", "Old Label");
      ctrl.recordJoin({ code: "KCCK2345", password: "BANNED_PASSWORD1", peerNames: ["Host"] });
      ctrl.rename("KCCK2345", "Kicked Room");
      ctrl.recordJoin({ code: "XTHR2345", password: "OLD_SECRET_99999" });
      ctrl.rename("XTHR2345", "Secret Project");
      while (pending.length > 0) {
        pending.shift()?.resolve();
        await Promise.resolve();
      }
      await Promise.all(tasks.splice(0));

      ctrl.remove("XANE2345");
      const removeLock = pending.shift();
      ctrl.recordJoin({ code: "XANE2345" });
      const joinX1Lock = pending.shift();

      ctrl.handleFatalError("KCCK2345", "kicked");
      const kickedLock = pending.shift();
      ctrl.recordJoin({ code: "KCCK2345" });
      const joinX2Lock = pending.shift();

      ctrl.rename("XTHR2345", "");
      const renameClearLock = pending.shift();
      ctrl.remove("XTHR2345");
      const removeX3Lock = pending.shift();
      ctrl.recordJoin({ code: "XTHR2345", password: "NEW_PASS_9999999" });
      const joinX3Lock = pending.shift();

      // New joins resolve BEFORE older removal/rename locks reject
      joinX1Lock?.resolve();
      joinX2Lock?.resolve();
      joinX3Lock?.resolve();
      await Promise.resolve();

      removeLock?.reject(new Error("AbortError"));
      kickedLock?.reject(new Error("AbortError"));
      renameClearLock?.reject(new Error("AbortError"));
      removeX3Lock?.reject(new Error("AbortError"));
      await Promise.all(tasks.splice(0));

      for (const code of ["XANE2345", "KCCK2345"]) {
        const mem = ctrl.getRooms().find((r) => r.code === code);
        const persisted = loadRecentRooms(storage, now).find((r) => r.code === code);
        expect(mem?.password).toBeUndefined();
        expect(mem?.label).toBeUndefined();
        expect(mem?.peerNames).toEqual([]);
        expect(persisted?.password).toBeUndefined();
        expect(persisted?.label).toBeUndefined();
        expect(persisted?.peerNames).toEqual([]);
      }

      const memX3 = ctrl.getRooms().find((r) => r.code === "XTHR2345");
      const persistedX3 = loadRecentRooms(storage, now).find((r) => r.code === "XTHR2345");
      expect(memX3?.label).toBeUndefined();
      expect(memX3?.password).toBe("NEW_PASS_9999999");
      expect(persistedX3?.label).toBeUndefined();
      expect(persistedX3?.password).toBe("NEW_PASS_9999999");
    }
  });

  it("matches memory and localStorage LRU eviction order when 21 rooms are joined in the same millisecond", async () => {
    const now = 1_700_000_000_000;
    const h = makeHarness({ now: () => now });
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const codes = Array.from({ length: MAX_STORED_RECENT_ROOMS + 1 }, (_, i) => `${alphabet[i] ?? "A"}RUC2345`);

    for (const code of codes) {
      h.ctrl.recordJoin({ code });
    }
    await h.flush();

    const memCodes = h.ctrl.getRooms().map((r) => r.code);
    const persistedCodes = loadRecentRooms(h.storage, now).map((r) => r.code);
    expect(memCodes).toHaveLength(MAX_STORED_RECENT_ROOMS);
    expect(memCodes[0]).toBe(codes[MAX_STORED_RECENT_ROOMS]);
    expect(memCodes).not.toContain(codes[0]);
    expect(persistedCodes).toEqual(memCodes);
  });

  it("keeps memory and localStorage order identical across same-ms in-place updates and 21-room eviction", async () => {
    const now = 1_700_000_000_000;

    // 1. Two+ rooms joined in the same millisecond: rename, updatePassword, updatePeers, handleCreatorHostForgotten on older room
    {
      const creatorCodes = new Set(["CCCC2345"]);
      const h = makeHarness({ creatorCodes, now: () => now });
      h.ctrl.recordJoin({ code: "CCCC2345", password: "HOST_PASSWORD_12" });
      h.ctrl.recordJoin({ code: "AAAA2345", password: "GUEST_PASS_12345" });
      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flush();

      h.ctrl.rename("CCCC2345", "Alpha");
      await h.flush();
      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));

      h.ctrl.updatePassword("CCCC2345", "HOST_PASSWORD_99", false);
      await h.flush();
      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));

      h.ctrl.updatePeers("CCCC2345", ["Alice", "Bob"]);
      await h.flush();
      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));

      creatorCodes.delete("CCCC2345");
      h.ctrl.handleCreatorHostForgotten("CCCC2345");
      await h.flush();
      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345", "AAAA2345", "CCCC2345"]);
    }

    // 2. 20 rooms joined in the same millisecond -> mutate codes[0] via each in-place method -> join 21st room evicts codes[0] in both
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const codes = Array.from({ length: MAX_STORED_RECENT_ROOMS + 1 }, (_, i) => `${alphabet[i] ?? "A"}PWT2345`);
    const mutations: Array<{
      name: string;
      mutate: (h: ReturnType<typeof makeHarness>, targetCode: string) => void;
    }> = [
      { name: "rename", mutate: (h, code) => h.ctrl.rename(code, "Keep This Room") },
      { name: "updatePassword", mutate: (h, code) => h.ctrl.updatePassword(code, "UPDATED_PASS_123", false) },
      { name: "updatePeers", mutate: (h, code) => h.ctrl.updatePeers(code, ["Bob"]) },
      {
        name: "handleCreatorHostForgotten",
        mutate: (h, code) => {
          h.creatorCodes.delete(code);
          h.ctrl.handleCreatorHostForgotten(code);
        },
      },
    ];

    for (const { mutate } of mutations) {
      const targetCode = codes[0] ?? "";
      const h = makeHarness({ creatorCodes: new Set([targetCode]), now: () => now });
      for (let i = 0; i < MAX_STORED_RECENT_ROOMS; i++) {
        const code = codes[i] ?? "";
        h.ctrl.recordJoin({ code, password: `INIT_PASS_${i}_1234` });
      }
      await h.flush();

      mutate(h, targetCode);
      h.ctrl.recordJoin({ code: codes[MAX_STORED_RECENT_ROOMS] ?? "" });
      await h.flush();

      const memCodes = h.ctrl.getRooms().map((r) => r.code);
      const persistedCodes = loadRecentRooms(h.storage, now).map((r) => r.code);
      expect(memCodes).toHaveLength(MAX_STORED_RECENT_ROOMS);
      expect(memCodes).not.toContain(targetCode);
      expect(persistedCodes).toEqual(memCodes);
    }

    // 3. Deferred-lock interleavings: recordJoin followed immediately by in-place mutation before lock flushes
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345" });
      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flush();

      // Rejoin older room and immediately rename before lock resolves
      h.ctrl.recordJoin({ code: "AAAA2345" });
      h.ctrl.rename("AAAA2345", "Promoted");
      // Brand new room joined and immediately renamed before lock resolves
      h.ctrl.recordJoin({ code: "CCCC2345" });
      h.ctrl.rename("CCCC2345", "Brand New");
      await h.flush();
      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["CCCC2345", "AAAA2345", "BBBB2345"]);

      // Rejoin AAAA2345, then BBBB2345, then rename AAAA2345 before locks resolve -> BBBB2345 stays first
      h.ctrl.recordJoin({ code: "AAAA2345" });
      h.ctrl.recordJoin({ code: "BBBB2345" });
      h.ctrl.rename("AAAA2345", "Still Second");
      await h.flush();
      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345", "AAAA2345", "CCCC2345"]);
    }
  });

  it("does not resurrect cleared labels under 4-step and 5-step normal FIFO sequences", async () => {
    for (const dt of [0, 100]) {
      let now = 1_700_000_000_000;
      const h = makeHarness({ deferredLocks: true, now: () => now });

      // 4-step: recordJoin -> rename("Beta") -> recordJoin -> rename("")
      h.ctrl.recordJoin({ code: "AFZZ2345" });
      now += dt;
      h.ctrl.rename("AFZZ2345", "Beta");
      now += dt;
      h.ctrl.recordJoin({ code: "AFZZ2345" });
      now += dt;
      h.ctrl.rename("AFZZ2345", "");
      await h.flush();

      const afzzMem = h.ctrl.getRooms().find((r) => r.code === "AFZZ2345");
      const afzzDisk = loadRecentRooms(h.storage, now).find((r) => r.code === "AFZZ2345");
      expect(afzzMem).toBeDefined();
      expect(afzzMem?.label).toBeUndefined();
      expect(afzzDisk).toBeDefined();
      expect(afzzDisk?.label).toBeUndefined();
      h.ctrl.syncFromStorage();
      const afzzSynced = h.ctrl.getRooms().find((r) => r.code === "AFZZ2345");
      expect(afzzSynced).toBeDefined();
      expect(afzzSynced?.label).toBeUndefined();

      // 5-step -> recordJoin
      h.ctrl.recordJoin({ code: "FYVE2345" });
      now += dt;
      h.ctrl.rename("FYVE2345", "My Room");
      now += dt;
      h.ctrl.recordJoin({ code: "FYVE2345" });
      now += dt;
      h.ctrl.rename("FYVE2345", "");
      now += dt;
      h.ctrl.recordJoin({ code: "FYVE2345" });
      await h.flush();
      const fiveMem = h.ctrl.getRooms().find((r) => r.code === "FYVE2345");
      const fiveDisk = loadRecentRooms(h.storage, now).find((r) => r.code === "FYVE2345");
      expect(fiveMem).toBeDefined();
      expect(fiveMem?.label).toBeUndefined();
      expect(fiveDisk).toBeDefined();
      expect(fiveDisk?.label).toBeUndefined();

      // 5-step -> updatePeers
      h.ctrl.recordJoin({ code: "PEER2345" });
      now += dt;
      h.ctrl.rename("PEER2345", "Temp Label");
      now += dt;
      h.ctrl.recordJoin({ code: "PEER2345" });
      now += dt;
      h.ctrl.rename("PEER2345", "");
      now += dt;
      h.ctrl.updatePeers("PEER2345", ["Bob"]);
      await h.flush();
      const peerMem = h.ctrl.getRooms().find((r) => r.code === "PEER2345");
      const peerPersisted = loadRecentRooms(h.storage, now).find((r) => r.code === "PEER2345");
      expect(peerMem?.label).toBeUndefined();
      expect(peerMem?.peerNames).toEqual(["Bob"]);
      expect(peerPersisted?.label).toBeUndefined();
      expect(peerPersisted?.peerNames).toEqual(["Bob"]);

      // rename("") -> rename("NewLabel") does not lose the new label
      h.ctrl.rename("PEER2345", "");
      h.ctrl.rename("PEER2345", "NewLabel");
      await h.flush();
      expect(h.ctrl.getRooms().find((r) => r.code === "PEER2345")?.label).toBe("NewLabel");
      expect(loadRecentRooms(h.storage, now).find((r) => r.code === "PEER2345")?.label).toBe("NewLabel");

      // rename("") -> remove() -> recordJoin() cleanly creates fresh unlabeled entry
      h.ctrl.rename("PEER2345", "");
      h.ctrl.remove("PEER2345");
      h.ctrl.recordJoin({ code: "PEER2345", password: "FRESH_PASS_12345" });
      await h.flush();
      const peerFreshMem = h.ctrl.getRooms().find((r) => r.code === "PEER2345");
      const peerFreshDisk = loadRecentRooms(h.storage, now).find((r) => r.code === "PEER2345");
      expect(peerFreshMem).toBeDefined();
      expect(peerFreshMem?.label).toBeUndefined();
      expect(peerFreshDisk).toBeDefined();
      expect(peerFreshDisk?.label).toBeUndefined();
    }
  });

  it("keeps synthesized legacy host-rooms parity across same-ms rename, 21-room eviction, and multi-synth", async () => {
    const now = 1_700_000_000_000;

    // Edge 8a: persisted AAAA2345 at now + synthesized BBBB2345 at now -> rename(BBBB2345)
    {
      const h = makeHarness({ creatorCodes: new Set(["BBBB2345"]), deferredLocks: true, now: () => now });
      upsertRecentRoom(h.storage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
      writePersistedHostToken(h.storage, "BBBB2345", "tok-b", now);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345"]);

      h.ctrl.rename("BBBB2345", "Legacy Host Room");
      await h.flush();
      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345", "AAAA2345"]);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345", "AAAA2345"]);
    }

    // Edge 8b: 19 persisted + 1 synthesized at now -> rename(synth) -> join 21st evicts same room
    {
      const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      const codes = Array.from({ length: MAX_STORED_RECENT_ROOMS + 1 }, (_, i) => `${alphabet[i] ?? "A"}HGC2345`);
      const synthCode = codes[19] ?? "";
      const newCode = codes[20] ?? "";
      const h = makeHarness({ creatorCodes: new Set([synthCode]), deferredLocks: true, now: () => now });
      for (let i = 18; i >= 0; i--) {
        upsertRecentRoom(h.storage, { code: codes[i] ?? "", role: "guest", lastJoinedAt: now }, now);
      }
      writePersistedHostToken(h.storage, synthCode, "tok-synth", now);
      h.ctrl.syncFromStorage();

      h.ctrl.rename(synthCode, "Important Host");
      h.ctrl.recordJoin({ code: newCode });
      await h.flush();

      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().some((r) => r.code === synthCode)).toBe(true);
      expect(h.ctrl.getRooms().some((r) => r.code === codes[18])).toBe(false);
    }

    // Multi-synth [PERS, SYNA, SYNB] -> rename(SYNB) -> syncFromStorage() keeps exact order
    {
      const h = makeHarness({
        creatorCodes: new Set(["SYNA2345", "SYNB2345"]),
        deferredLocks: true,
        now: () => now,
      });
      upsertRecentRoom(h.storage, { code: "PERS2345", role: "guest", lastJoinedAt: now }, now);
      writePersistedHostToken(h.storage, "SYNA2345", "tok-s1", now);
      writePersistedHostToken(h.storage, "SYNB2345", "tok-s2", now);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["PERS2345", "SYNA2345", "SYNB2345"]);

      h.ctrl.rename("SYNB2345", "Named Second");
      // Before flush, syncFromStorage preserves promoted order
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["SYNB2345", "PERS2345", "SYNA2345"]);

      await h.flush();
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["SYNB2345", "PERS2345"]);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["SYNB2345", "PERS2345", "SYNA2345"]);
    }
  });

  it("maintains same-ms order under out-of-order rejected locks, 21-room eviction, and cross-tab sync", async () => {
    const now = 1_700_000_000_000;
    const makeLockHarness = () => {
      const storage = makeMemoryStorage();
      const tasks: Promise<unknown>[] = [];
      const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve, reject) => {
            pending.push({
              resolve: () => {
                void Promise.resolve(cb()).finally(resolve);
              },
              reject,
            });
          }),
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });
      return { ctrl, storage, tasks, pending };
    };

    // 1. join(B, dt=0) -> join(A, dt=0) where Lock 1 rejects before Lock 0 grants
    {
      const h = makeLockHarness();
      h.ctrl.recordJoin({ code: "BBBB2345" });
      const lockB = h.pending.shift();
      h.ctrl.recordJoin({ code: "AAAA2345" });
      const lockA = h.pending.shift();
      lockA?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockB?.resolve();
      await Promise.all(h.tasks.splice(0));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345"]);
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345"]);
    }

    // 2. Edge 2: [C, A] seeded; join(A) -> rename(A) -> join(B) with reverse lock rejection
    {
      const h = makeLockHarness();
      upsertRecentRoom(h.storage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
      upsertRecentRoom(h.storage, { code: "CCCC2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();

      h.ctrl.recordJoin({ code: "AAAA2345" });
      const lockJoinA = h.pending.shift();
      h.ctrl.rename("AAAA2345", "RenamedA");
      const lockRenameA = h.pending.shift();
      h.ctrl.recordJoin({ code: "BBBB2345" });
      const lockJoinB = h.pending.shift();

      lockJoinB?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockRenameA?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockJoinA?.resolve();
      await Promise.all(h.tasks.splice(0));

      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345", "AAAA2345", "CCCC2345"]);
    }

    // 3. Edge 3: [C, A] seeded; join(A) -> join(B) -> rename(A) with out-of-order lock rejections
    {
      const h = makeLockHarness();
      upsertRecentRoom(h.storage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
      upsertRecentRoom(h.storage, { code: "CCCC2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();

      h.ctrl.recordJoin({ code: "AAAA2345" });
      const lockJoinA = h.pending.shift();
      h.ctrl.recordJoin({ code: "BBBB2345" });
      const lockJoinB = h.pending.shift();
      h.ctrl.rename("AAAA2345", "RenamedA");
      const lockRenameA = h.pending.shift();

      lockJoinB?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockRenameA?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockJoinA?.resolve();
      await Promise.all(h.tasks.splice(0));

      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345", "AAAA2345", "CCCC2345"]);
    }

    // 4. Edge 10: [C, A] seeded; join(A) -> join(B) -> remove(B) -> rename(A)
    {
      const h = makeLockHarness();
      upsertRecentRoom(h.storage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
      upsertRecentRoom(h.storage, { code: "CCCC2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();

      h.ctrl.recordJoin({ code: "AAAA2345" });
      const lockJoinA = h.pending.shift();
      h.ctrl.recordJoin({ code: "BBBB2345" });
      const lockJoinB = h.pending.shift();
      h.ctrl.remove("BBBB2345");
      const lockRemoveB = h.pending.shift();
      h.ctrl.rename("AAAA2345", "RenamedA");
      const lockRenameA = h.pending.shift();

      lockJoinB?.reject(new Error("AbortError"));
      lockRemoveB?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockRenameA?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockJoinA?.resolve();
      await Promise.all(h.tasks.splice(0));

      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345", "CCCC2345"]);
    }

    // 5. join(A) -> join(B) -> updatePassword(A) with out-of-order lock rejections
    {
      const h = makeLockHarness();
      h.ctrl.recordJoin({ code: "AAAA2345", password: "OLD_PASSWORD_1111" });
      const lockJoinA = h.pending.shift();
      h.ctrl.recordJoin({ code: "BBBB2345", password: "BBB_PASSWORD_2222" });
      const lockJoinB = h.pending.shift();
      h.ctrl.updatePassword("AAAA2345", "NEW_PASSWORD_3333", false);
      const lockPwA = h.pending.shift();

      lockJoinB?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockPwA?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockJoinA?.resolve();
      await Promise.all(h.tasks.splice(0));

      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345", "AAAA2345"]);
      expect(h.ctrl.getRooms()[1]?.password).toBe("NEW_PASSWORD_3333");
    }

    // 6. 21-room same-ms join when C1's lock rejects last -> C1 stays evicted
    {
      const h = makeLockHarness();
      const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      const codes = Array.from({ length: MAX_STORED_RECENT_ROOMS + 1 }, (_, i) => `${alphabet[i] ?? "A"}REJ2345`);
      for (const code of codes) {
        h.ctrl.recordJoin({ code });
      }
      const lockC1 = h.pending.shift();
      while (h.pending.length > 0) {
        h.pending.shift()?.resolve();
        await Promise.resolve();
      }
      lockC1?.reject(new Error("AbortError"));
      await Promise.all(h.tasks.splice(0));

      const memCodes = h.ctrl.getRooms().map((r) => r.code);
      const persistedCodes = loadRecentRooms(h.storage, now).map((r) => r.code);
      expect(memCodes).toHaveLength(MAX_STORED_RECENT_ROOMS);
      expect(memCodes).not.toContain(codes[0]);
      expect(persistedCodes).toEqual(memCodes);
    }

    // 7. Cross-tab storage preservation + syncFromStorage while in-place rename & unpersisted older join are pending
    {
      const h = makeLockHarness();
      upsertRecentRoom(h.storage, { code: "XTAB2345", role: "guest", lastJoinedAt: now }, now);
      upsertRecentRoom(h.storage, { code: "PERS2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();

      // In-place rename on XTAB2345 (index 1) stays at index 1 across syncFromStorage before lock flushes
      h.ctrl.rename("XTAB2345", "CrossTab");
      const lockRename = h.pending.shift();
      // Tab 2 adds XTB22345 directly to storage
      upsertRecentRoom(h.storage, { code: "XTB22345", role: "host", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["XTB22345", "PERS2345", "XTAB2345"]);
      expect(h.ctrl.getRooms()[2]?.label).toBe("CrossTab");

      lockRename?.resolve();
      await Promise.all(h.tasks.splice(0));
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["XTB22345", "PERS2345", "XTAB2345"]);

      // Unpersisted older join(AAAA) behind already-persisted newer join(BBBB) preserves [BBBB, AAAA] on syncFromStorage
      h.ctrl.recordJoin({ code: "AAAA2345" });
      const lockJoinA = h.pending.shift();
      h.ctrl.recordJoin({ code: "BBBB2345" });
      const lockJoinB = h.pending.shift();
      lockJoinB?.resolve();
      await Promise.resolve();
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code).slice(0, 2)).toEqual(["BBBB2345", "AAAA2345"]);
      lockJoinA?.resolve();
      await Promise.all(h.tasks.splice(0));
      expect(loadRecentRooms(h.storage, now).map((r) => r.code).slice(0, 2)).toEqual(["BBBB2345", "AAAA2345"]);
    }
  });

  it("does not re-promote synthesized host rooms on subsequent metadata edits straddling recordJoin", async () => {
    const now = 1_700_000_000_000;

    // 1. Breaker Probe 4: sync vs deferred locks parity on rename -> recordJoin -> rename
    for (const deferredLocks of [false, true]) {
      const h = makeHarness({
        creatorCodes: new Set(["SYNA2345"]),
        deferredLocks,
        now: () => now,
      });
      writePersistedHostToken(h.storage, "SYNA2345", "tok-syna", now);
      upsertRecentRoom(h.storage, { code: "PERS2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();

      h.ctrl.rename("SYNA2345", "First");
      h.ctrl.recordJoin({ code: "NEWC2345" });
      h.ctrl.rename("SYNA2345", "Second");

      if (deferredLocks) {
        expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);
        h.ctrl.syncFromStorage();
        expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);
      }

      await h.flush();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);
      expect(loadRecentRooms(h.storage, now).find((r) => r.code === "SYNA2345")?.label).toBe("Second");
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);
    }

    // 2. updatePassword -> recordJoin -> updatePeers -> rename("") on synthesized room + mid-flight syncFromStorage after NEWC flush
    {
      const h = makeHarness({
        creatorCodes: new Set(["SYNA2345"]),
        deferredLocks: true,
        now: () => now,
      });
      writePersistedHostToken(h.storage, "SYNA2345", "tok-syna", now);
      upsertRecentRoom(h.storage, { code: "PERS2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();

      h.ctrl.updatePassword("SYNA2345", "SYNA_PASS_123456", false);
      h.ctrl.recordJoin({ code: "NEWC2345" });
      h.ctrl.updatePeers("SYNA2345", ["PeerOne"]);
      h.ctrl.rename("SYNA2345", "");

      // Flush lock 1 (skipped updatePassword) and lock 2 (NEWC2345) while SYNA2345 updates remain pending
      h.pendingLockReleases.shift()?.();
      await Promise.resolve();
      h.pendingLockReleases.shift()?.();
      await Promise.resolve();

      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);

      await h.flush();
      const synaMem = h.ctrl.getRooms().find((r) => r.code === "SYNA2345");
      const synaDisk = loadRecentRooms(h.storage, now).find((r) => r.code === "SYNA2345");
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);
      expect(synaMem?.password).toBe("SYNA_PASS_123456");
      expect(synaMem?.peerNames).toEqual(["PeerOne"]);
      expect(synaMem?.label).toBeUndefined();
      expect(synaDisk).toEqual(synaMem);
    }

    // 3. Out-of-order and rejected Web Locks (AbortError) on synthesized double-rename straddling recordJoin
    {
      const storage = makeMemoryStorage();
      const tasks: Promise<unknown>[] = [];
      const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve, reject) => {
            pending.push({
              resolve: () => {
                void Promise.resolve(cb()).finally(resolve);
              },
              reject,
            });
          }),
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: (code) => code === "SYNA2345",
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });
      writePersistedHostToken(storage, "SYNA2345", "tok-syna", now);
      upsertRecentRoom(storage, { code: "PERS2345", role: "guest", lastJoinedAt: now }, now);
      ctrl.syncFromStorage();

      ctrl.rename("SYNA2345", "First");
      const lockFirst = pending.shift();
      ctrl.recordJoin({ code: "NEWC2345" });
      const lockJoin = pending.shift();
      ctrl.rename("SYNA2345", "Second");
      const lockSecond = pending.shift();

      // Second rename resolves first, then First rejects (AbortError), then recordJoin resolves last
      lockSecond?.resolve();
      await Promise.resolve();
      lockFirst?.reject(new Error("AbortError"));
      await Promise.resolve();
      lockJoin?.resolve();
      await Promise.all(tasks.splice(0));

      expect(ctrl.getRooms().map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);
      expect(loadRecentRooms(storage, now).map((r) => r.code)).toEqual(["NEWC2345", "SYNA2345", "PERS2345"]);
      expect(loadRecentRooms(storage, now).find((r) => r.code === "SYNA2345")?.label).toBe("Second");
    }

    // 4. 21-room eviction with double-rename on synthesized room straddling recordJoin
    {
      const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      const codes = Array.from({ length: MAX_STORED_RECENT_ROOMS + 1 }, (_, i) => `${alphabet[i] ?? "A"}PR42345`);
      const synthCode = codes[19] ?? "";
      const newCode = codes[20] ?? "";
      const h = makeHarness({ creatorCodes: new Set([synthCode]), deferredLocks: true, now: () => now });
      for (let i = 18; i >= 0; i--) {
        upsertRecentRoom(h.storage, { code: codes[i] ?? "", role: "guest", lastJoinedAt: now }, now);
      }
      writePersistedHostToken(h.storage, synthCode, "tok-synth", now);
      h.ctrl.syncFromStorage();

      h.ctrl.rename(synthCode, "First");
      h.ctrl.recordJoin({ code: newCode });
      h.ctrl.rename(synthCode, "Second");
      await h.flush();

      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.storage, now));
      expect(h.ctrl.getRooms().slice(0, 2).map((r) => r.code)).toEqual([newCode, synthCode]);
      expect(h.ctrl.getRooms().some((r) => r.code === codes[18])).toBe(false);
    }
  });

  it("clears stale lastJoinGen on remove/clearAll and preserves pendingClearAll order across out-of-order syncFromStorage", async () => {
    const now = 1_700_000_000_000;

    // H1a: cancelled recordJoin via remove() followed by cross-tab re-addition at same ms and rename()
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345" });
      h.ctrl.remove("AAAA2345");
      await h.flush();

      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flush();

      upsertRecentRoom(h.storage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345"]);

      h.ctrl.rename("AAAA2345", "FromTab2");
      await h.flush();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345"]);
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345"]);
      expect(loadRecentRooms(h.storage, now)[0]?.label).toBe("FromTab2");
    }

    // H1b: cancelled recordJoin via clearAll() followed by cross-tab re-addition at same ms and rename()
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345" });
      h.ctrl.clearAll();
      await h.flush();

      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flush();

      upsertRecentRoom(h.storage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345"]);

      h.ctrl.rename("AAAA2345", "FromTab2");
      await h.flush();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345"]);
      expect(loadRecentRooms(h.storage, now).map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345"]);
      expect(loadRecentRooms(h.storage, now)[0]?.label).toBe("FromTab2");
    }

    // H2: clearAll() -> recordJoin(B) -> recordJoin(C) where lockC rejects or resolves before lockB + syncFromStorage()
    for (const rejectLockC of [true, false]) {
      const storage = makeMemoryStorage();
      const tasks: Promise<unknown>[] = [];
      const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve, reject) => {
            pending.push({
              resolve: () => {
                void Promise.resolve(cb()).finally(resolve);
              },
              reject,
            });
          }),
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      ctrl.clearAll();
      const clearLock = pending.shift();
      ctrl.recordJoin({ code: "BBBB2345" });
      const lockB = pending.shift();
      ctrl.recordJoin({ code: "CCCC2345" });
      const lockC = pending.shift();

      if (rejectLockC) lockC?.reject(new Error("AbortError"));
      else lockC?.resolve();
      await Promise.resolve();

      ctrl.syncFromStorage();
      expect(ctrl.getRooms().map((r) => r.code)).toEqual(["CCCC2345", "BBBB2345"]);

      lockB?.resolve();
      clearLock?.resolve();
      await Promise.all(tasks.splice(0));

      expect(ctrl.getRooms().map((r) => r.code)).toEqual(["CCCC2345", "BBBB2345"]);
      expect(loadRecentRooms(storage, now).map((r) => r.code)).toEqual(["CCCC2345", "BBBB2345"]);
    }
  });

  it("preserves unrelated cross-tab fields on queued metadata patches and passwordless joins (Finding #2)", async () => {
    let now = 1_700_000_000_000;
    const h = makeHarness({ creatorCodes: new Set(["AAAA2345"]), deferredLocks: true, now: () => now });
    h.ctrl.recordJoin({ code: "AAAA2345", password: "OLD_PASSWORD_1111", peerNames: ["OldPeer"] });
    await h.flush();

    // Tab B rotates password, updates peers, and sets a label after Tab A loaded snapshot
    now += 500;
    upsertRecentRoom(
      h.storage,
      {
        code: "AAAA2345",
        role: "host",
        lastJoinedAt: now,
        password: "TAB_B_PASSWORD_22",
        peerNames: ["TabBPeer"],
        label: "TabBLabel",
      },
      now,
    );

    // Tab A queues rename while holding stale snapshot -> must NOT overwrite Tab B's password, peerNames, or lastJoinedAt
    h.ctrl.rename("AAAA2345", "TabALabel");
    h.ctrl.syncFromStorage(); // mid-flight overlay keeps Tab B's password & peerNames with Tab A's pending label
    const mid = h.ctrl.getRooms().find((r) => r.code === "AAAA2345");
    expect(mid).toEqual({
      code: "AAAA2345",
      role: "host",
      lastJoinedAt: now,
      password: "TAB_B_PASSWORD_22",
      peerNames: ["TabBPeer"],
      label: "TabALabel",
    });

    await h.flush();
    expect(loadRecentRooms(h.storage, now)[0]).toEqual(mid);

    // Tab B updates label and peers -> Tab A queues updatePassword -> preserves Tab B's label & peers
    upsertRecentRoom(
      h.storage,
      { code: "AAAA2345", role: "host", lastJoinedAt: now, label: "TabBLatest", peerNames: ["Zoe"] },
      now,
    );
    h.ctrl.updatePassword("AAAA2345", "TAB_A_PASSWORD_33", false);
    await h.flush();
    expect(loadRecentRooms(h.storage, now)[0]).toMatchObject({
      label: "TabBLatest",
      peerNames: ["Zoe"],
      password: "TAB_A_PASSWORD_33",
    });

    // Tab B updates password & label -> Tab A queues updatePeers -> preserves Tab B's password & label
    upsertRecentRoom(
      h.storage,
      { code: "AAAA2345", role: "host", lastJoinedAt: now, password: "TAB_B_PW_LATEST44", label: "TabBPin" },
      now,
    );
    h.ctrl.updatePeers("AAAA2345", ["Alice", "Bob"]);
    await h.flush();
    expect(loadRecentRooms(h.storage, now)[0]).toMatchObject({
      password: "TAB_B_PW_LATEST44",
      label: "TabBPin",
      peerNames: ["Alice", "Bob"],
    });

    // Tab B updates password & peers -> Tab A forgets creator host -> role becomes guest without clobbering Tab B fields
    upsertRecentRoom(
      h.storage,
      { code: "AAAA2345", role: "host", lastJoinedAt: now, password: "TAB_B_PW_FINAL555", peerNames: ["Cara"] },
      now,
    );
    h.creatorCodes.delete("AAAA2345");
    h.ctrl.handleCreatorHostForgotten("AAAA2345");
    await h.flush();
    expect(loadRecentRooms(h.storage, now)[0]).toMatchObject({
      role: "guest",
      password: "TAB_B_PW_FINAL555",
      peerNames: ["Cara"],
      label: "TabBPin",
    });

    // Tab B updates password & label -> Tab A executes passwordless recordJoin({ code }) -> keeps Tab B's password & label
    now += 500;
    upsertRecentRoom(
      h.storage,
      { code: "AAAA2345", role: "guest", lastJoinedAt: now - 100, password: "TAB_B_PW_REJOIN66", label: "KeepLabel" },
      now,
    );
    h.ctrl.recordJoin({ code: "AAAA2345" });
    await h.flush();
    expect(loadRecentRooms(h.storage, now)[0]).toMatchObject({
      code: "AAAA2345",
      role: "guest",
      lastJoinedAt: now,
      password: "TAB_B_PW_REJOIN66",
      label: "KeepLabel",
    });
  });

  it("enforces persisted opt-out inside Web Lock and coordinates setDisabled(false) before recordJoin (Finding #3)", async () => {
    const now = 1_700_000_000_000;

    // 1. Tab B enables opt-out while Tab A has queued recordJoin + rename -> lock skips both and syncs Tab A to disabled
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345", password: "ROOM_PASS_123456" });
      await h.flush();

      h.ctrl.recordJoin({ code: "BBBB2345", password: "ROOM_PASS_223456" });
      h.ctrl.rename("AAAA2345", "ShouldSkip");
      h.storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      h.storage.removeItem(RECENT_ROOMS_STORAGE_KEY);

      await h.flush();
      expect(h.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(h.ctrl.getRooms()).toEqual([]);
    }

    // 2. Tab A starts disabled, calls setDisabled(false) -> recordJoin(...) -> works in both FIFO and out-of-order lock execution
    {
      const storage = makeMemoryStorage({ [RECENT_ROOMS_OPT_OUT_KEY]: "1" });
      const tasks: Promise<unknown>[] = [];
      const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve, reject) => {
            pending.push({
              resolve: () => {
                void Promise.resolve(cb()).finally(resolve);
              },
              reject,
            });
          }),
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });
      expect(ctrl.isDisabled()).toBe(true);

      ctrl.setDisabled(false);
      const enableLock = pending.shift();
      ctrl.recordJoin({ code: "CCCC2345", password: "NEW_PASS_1234567" });
      const joinLock = pending.shift();

      // Out-of-order: joinLock runs first and flushes opt-out removal before saving
      joinLock?.resolve();
      await Promise.resolve();
      expect(isRecentRoomsDisabled(storage)).toBe(false);
      expect(loadRecentRooms(storage, now).map((r) => r.code)).toEqual(["CCCC2345"]);

      // Tab B sets opt-out after Tab A's enable already flushed; stale enableLock must NOT clobber Tab B's opt-out
      storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      enableLock?.resolve();
      await Promise.all(tasks.splice(0));
      expect(isRecentRoomsDisabled(storage)).toBe(true);
    }

    // 3. Tab A calls setDisabled(false), flushes; Tab B sets opt-out; Tab A calls recordJoin before storage event -> blocked
    {
      const h = makeHarness({ initialStorage: { [RECENT_ROOMS_OPT_OUT_KEY]: "1" }, deferredLocks: true, now: () => now });
      h.ctrl.setDisabled(false);
      await h.flush();
      h.storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      h.ctrl.recordJoin({ code: "DDDD2345", password: "BLCK_PASS_123456" });
      await h.flush();
      expect(h.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(h.ctrl.getRooms()).toEqual([]);
    }
  });

  it("does not resurrect externally deleted rooms on queued metadata edits (Finding #4)", async () => {
    const now = 1_700_000_000_000;

    // 1. Tab B deletes AAAA2345 while Tab A queues rename, updatePeers, updatePassword, handleCreatorHostForgotten
    {
      const h = makeHarness({ creatorCodes: new Set(["AAAA2345"]), deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345", password: "SECRET_PASS_1234" });
      await h.flush();

      // Tab B deletes AAAA2345 from storage
      h.storage.removeItem(RECENT_ROOMS_STORAGE_KEY);

      h.ctrl.rename("AAAA2345", "GhostLabel");
      h.ctrl.updatePeers("AAAA2345", ["GhostPeer"]);
      h.ctrl.updatePassword("AAAA2345", "GHOST_PASS_12345", false);
      h.creatorCodes.delete("AAAA2345");
      h.ctrl.handleCreatorHostForgotten("AAAA2345");

      // Mid-flight syncFromStorage must not retain deleted AAAA2345
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms()).toEqual([]);

      const changesBeforeFlush = h.onChange.mock.calls.length;
      await h.flush();
      expect(h.onChange.mock.calls.length).toBeGreaterThan(changesBeforeFlush);
      expect(loadRecentRooms(h.storage, now)).toEqual([]);
      expect(h.ctrl.getRooms()).toEqual([]);
    }

    // 1b. Out-of-order patches after external delete: newer gen 3 runs first -> sets lastExternalDeleteGen -> older gen 2 skips
    {
      const storage = makeMemoryStorage();
      const tasks: Promise<unknown>[] = [];
      const pending: Array<{ resolve: () => void }> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve) => {
            pending.push({
              resolve: () => {
                void Promise.resolve(cb()).finally(resolve);
              },
            });
          }),
      };
      const onChange = vi.fn();
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange,
        now: () => now,
      });
      ctrl.recordJoin({ code: "AAAA2345", password: "ROOM_PASS_123456" });
      pending.shift()?.resolve();
      await Promise.all(tasks.splice(0));

      storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
      ctrl.updatePeers("AAAA2345", ["PeerOne"]);
      const peersLock = pending.shift();
      ctrl.rename("AAAA2345", "GhostLabel");
      const renameLock = pending.shift();

      renameLock?.resolve();
      await Promise.resolve();
      const changesAfterRename = onChange.mock.calls.length;

      // Re-add AAAA2345 externally; older pre-delete peersLock MUST be skipped by lastExternalDeleteGen >= gen
      upsertRecentRoom(storage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
      peersLock?.resolve();
      await Promise.all(tasks.splice(0));
      expect(onChange).toHaveBeenCalledTimes(changesAfterRename);
      expect(loadRecentRooms(storage, now)[0]?.peerNames).toEqual([]);
    }

    // 2. Pre-delete updatePeers followed by a brand-new recordJoin after Tab B deleted -> pre-delete patch does not attach to new join
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345", password: "OLD_PASS_1234567" });
      await h.flush();

      h.storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
      h.ctrl.updatePeers("AAAA2345", ["OldPeer"]);
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flush();

      const saved = loadRecentRooms(h.storage, now).find((r) => r.code === "AAAA2345");
      expect(saved).toBeDefined();
      expect(saved?.peerNames).toEqual([]);
    }

    // 3. Legacy synthesized host-rooms entry deleted from host-rooms by Tab B before rename lock runs -> does NOT resurrect
    {
      const h = makeHarness({ creatorCodes: new Set(["SYNA2345"]), deferredLocks: true, now: () => now });
      writePersistedHostToken(h.storage, "SYNA2345", "tok-syna", now);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["SYNA2345"]);

      // Tab B clears host-rooms
      h.storage.removeItem(HOST_ROOMS_STORAGE_KEY);
      h.ctrl.rename("SYNA2345", "GhostSynth");
      await h.flush();
      expect(loadRecentRooms(h.storage, now)).toEqual([]);
      expect(h.ctrl.getRooms()).toEqual([]);
    }
  });

  it("purges stale/expired recent-rooms in background under lock without breaking empty/fresh lock count (Finding #5)", async () => {
    const now = 1_700_000_000_000;
    const lockCalls: string[] = [];
    const pending: Array<() => void> = [];
    const tasks: Promise<unknown>[] = [];
    const locks: LockManagerLike = {
      request: (name, cb) => {
        lockCalls.push(name);
        return new Promise<void>((resolve) => {
          pending.push(() => {
            void Promise.resolve(cb()).finally(resolve);
          });
        });
      },
    };

    const storage = makeMemoryStorage({
      [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
        { code: "EXPD2345", role: "guest", lastJoinedAt: now - RECENT_ROOM_TTL_MS },
        { code: "KEEP2345", role: "host", lastJoinedAt: now - 1000, label: "Valid" },
      ]),
    });

    const ctrl = new RecentRoomsController({
      getLocalStorage: () => storage,
      getLocks: () => locks,
      runBackground: (t) => {
        tasks.push(t);
      },
      hasSavedCreatorHostFor: () => false,
      onRemoveHostToken: vi.fn(),
      onForgetAllHostTokens: vi.fn(),
      onChange: vi.fn(),
      now: () => now,
    });

    // Startup scheduled 1 purge lock; duplicate syncFromStorage while pendingPurge=true debounces
    expect(lockCalls).toEqual([RECENT_ROOMS_LOCK_NAME]);
    ctrl.syncFromStorage(false);
    expect(lockCalls).toEqual([RECENT_ROOMS_LOCK_NAME]);

    // Concurrent write from another tab before purge lock runs is preserved while EXPD2345 remains on disk until purge runs
    const prevRaw = JSON.parse(storage.store.get(RECENT_ROOMS_STORAGE_KEY) ?? "[]") as unknown[];
    storage.setItem(
      RECENT_ROOMS_STORAGE_KEY,
      JSON.stringify([{ code: "XTAB2345", role: "guest", lastJoinedAt: now, peerNames: [] }, ...prevRaw]),
    );
    expect(
      (JSON.parse(storage.store.get(RECENT_ROOMS_STORAGE_KEY) ?? "[]") as Array<{ code: string }>).some(
        (r) => r.code === "EXPD2345",
      ),
    ).toBe(true);
    pending.shift()?.();
    await Promise.all(tasks.splice(0));

    expect(loadRecentRooms(storage, now).map((r) => r.code)).toEqual(["XTAB2345", "KEEP2345"]);
    const rawAfter = JSON.parse(storage.store.get(RECENT_ROOMS_STORAGE_KEY) ?? "[]") as Array<{ code: string }>;
    expect(rawAfter.some((r) => r.code === "EXPD2345")).toBe(false);

    // Subsequent sync on clean storage acquires 0 locks
    ctrl.syncFromStorage(false);
    expect(lockCalls).toHaveLength(1);

    // If clearAll() or setDisabled(true) runs while purge lock is pending, purge skips writing
    storage.setItem(
      RECENT_ROOMS_STORAGE_KEY,
      JSON.stringify([{ code: "EXPD2345", role: "guest", lastJoinedAt: now - RECENT_ROOM_TTL_MS }]),
    );
    ctrl.syncFromStorage(false);
    expect(lockCalls).toHaveLength(2);
    ctrl.clearAll();
    const purgeLock = pending.shift();
    const clearLock = pending.shift();
    // While pendingClearAll > 0, syncFromStorage does not schedule another purge
    ctrl.syncFromStorage(false);
    expect(lockCalls).toHaveLength(3);
    purgeLock?.();
    await Promise.resolve();
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(true); // purge skipped because clearAllGen > persistedClearAllGen
    clearLock?.();
    await Promise.all(tasks.splice(0));
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

    // If setDisabled(true) runs while purge lock is pending, purge skips writing
    storage.setItem(
      RECENT_ROOMS_STORAGE_KEY,
      JSON.stringify([{ code: "EXPD2345", role: "guest", lastJoinedAt: now - RECENT_ROOM_TTL_MS }]),
    );
    ctrl.syncFromStorage(false);
    expect(lockCalls).toHaveLength(4);
    ctrl.setDisabled(true);
    const purgeLock2 = pending.shift();
    const disableLock2 = pending.shift();
    purgeLock2?.();
    await Promise.resolve();
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(true);
    disableLock2?.();
    await Promise.all(tasks.splice(0));
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
  });

  it("retains local deletions, clearAll, and opt-out across storage errors and retries when recovered (Finding #9)", async () => {
    const now = 1_700_000_000_000;
    const inner = makeMemoryStorage();
    let failWrites = false;
    let failRemoves = false;
    const flakeyStorage: StorageLike = {
      getItem: (k) => inner.getItem(k),
      setItem: (k, v) => {
        if (failWrites) throw new Error("QuotaExceededError");
        inner.setItem(k, v);
      },
      removeItem: (k) => {
        if (failRemoves) throw new Error("SecurityError");
        inner.removeItem(k);
      },
    };
    const tasks: Promise<unknown>[] = [];
    const ctrl = new RecentRoomsController({
      getLocalStorage: () => flakeyStorage,
      getLocks: () => null,
      runBackground: (t) => {
        tasks.push(t);
      },
      hasSavedCreatorHostFor: () => false,
      onRemoveHostToken: vi.fn(),
      onForgetAllHostTokens: vi.fn(),
      onChange: vi.fn(),
      now: () => now,
    });

    // 1. clearAll() when removeItem throws -> does not resurrect on syncFromStorage and retries when recovered
    ctrl.recordJoin({ code: "AAAA2345", password: "OLD_PASSWORD_1111" });
    await Promise.all(tasks.splice(0));
    failRemoves = true;
    expect(() => ctrl.clearAll()).not.toThrow();
    await Promise.all(tasks.splice(0));
    ctrl.syncFromStorage();
    expect(ctrl.getRooms()).toEqual([]);

    failRemoves = false;
    ctrl.recordJoin({ code: "BBBB2345" });
    await Promise.all(tasks.splice(0));
    expect(loadRecentRooms(inner, now).map((r) => r.code)).toEqual(["BBBB2345"]);

    // 2. remove() when setItem/removeItem throws -> does not resurrect and flushes removal on recovery
    ctrl.recordJoin({ code: "CCCC2345", password: "OLD_CCCC_PASS123" });
    ctrl.rename("CCCC2345", "OldName");
    await Promise.all(tasks.splice(0));
    failWrites = true;
    failRemoves = true;
    expect(() => ctrl.remove("CCCC2345")).not.toThrow();
    await Promise.all(tasks.splice(0));
    ctrl.syncFromStorage();
    expect(ctrl.getRooms().some((r) => r.code === "CCCC2345")).toBe(false);

    // Calling recordJoin while remove still failed to flush aborts write without resurrecting old credentials
    ctrl.recordJoin({ code: "CCCC2345" });
    await Promise.all(tasks.splice(0));
    expect(loadRecentRooms(inner, now).find((r) => r.code === "CCCC2345")?.password).toBe("OLD_CCCC_PASS123");

    // Re-remove while failing, then recover and recordJoin -> flushes removal cleanly before saving
    ctrl.remove("CCCC2345");
    await Promise.all(tasks.splice(0));
    failWrites = false;
    failRemoves = false;
    ctrl.recordJoin({ code: "CCCC2345" });
    await Promise.all(tasks.splice(0));
    const readded = loadRecentRooms(inner, now).find((r) => r.code === "CCCC2345");
    expect(readded).toBeDefined();
    expect(readded?.password).toBeUndefined();
    expect(readded?.label).toBeUndefined();

    // 3. setDisabled(true) when setItem throws -> isDisabled() stays true across syncFromStorage
    failWrites = true;
    ctrl.setDisabled(true);
    await Promise.all(tasks.splice(0));
    ctrl.syncFromStorage();
    expect(ctrl.isDisabled()).toBe(true);
  });

  it("forwards expectedHostToken on handleFatalError (Finding #7) and kills remaining controller mutants", async () => {
    const now = 1_700_000_000_000;

    // 1. handleFatalError forwards expectedHostToken to SessionController so newer token is preserved
    {
      const storage = createFullMemoryStorage();
      const sessStorage = createFullMemoryStorage();
      const tasks: Promise<unknown>[] = [];
      let ctrl!: RecentRoomsController;
      const session = new SessionController({
        getLocalStorage: () => storage,
        getSessionStorage: () => sessStorage,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        onForgetHostUiChange: () => ctrl.syncFromStorage(),
      });
      ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: (c) => session.hasSavedCreatorHostFor(c),
        onRemoveHostToken: (c, onlyIfMatching) => session.forgetCreatorHostToken(c, onlyIfMatching),
        onForgetAllHostTokens: () => session.forgetAllHostTokens(),
        onChange: vi.fn(),
        now: () => now,
      });

      session.saveCreatorHostToken("KYCK2345", "tok-old");
      ctrl.recordJoin({ code: "KYCK2345", password: "PASS_12345678901" });
      await Promise.all(tasks.splice(0));

      writePersistedHostToken(storage, "KYCK2345", "tok-new", now + 100);
      expect(ctrl.handleFatalError("kyck2345", "kicked", "tok-old")).toBe(true);
      await Promise.all(tasks.splice(0));
      expect(readPersistedHostToken(storage, "KYCK2345", now + 100)).toBe("tok-new");
      expect(ctrl.getRooms()).toEqual([]);
    }

    // 2. Constructor, syncFromStorage(notify), no-op guards, trim, onChange counts, normalizeUiState
    {
      const seededStorage = makeMemoryStorage();
      upsertRecentRoom(seededStorage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
      upsertRecentRoom(seededStorage, { code: "BBBB2345", role: "guest", lastJoinedAt: now - 100 }, now);
      upsertRecentRoom(seededStorage, { code: "CCCC2345", role: "guest", lastJoinedAt: now - 200 }, now);
      const onChange = vi.fn();
      const onRemoveHostToken = vi.fn();
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => seededStorage,
        getLocks: () => null,
        runBackground: vi.fn(),
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken,
        onForgetAllHostTokens: vi.fn(),
        onChange,
        now: () => now,
      });

      expect(onChange).toHaveBeenCalledTimes(0);
      expect(ctrl.getSearchQuery()).toBe("");
      expect(ctrl.getFilteredRooms().map((r) => r.code)).toEqual(["AAAA2345", "BBBB2345", "CCCC2345"]);

      ctrl.syncFromStorage(false);
      expect(onChange).toHaveBeenCalledTimes(0);
      ctrl.syncFromStorage();
      expect(onChange).toHaveBeenCalledTimes(1);

      // setSearchQuery no-op vs change; preserved at 3 rooms on syncFromStorage
      ctrl.setSearchQuery("aaaa");
      expect(onChange).toHaveBeenCalledTimes(2);
      ctrl.setSearchQuery("aaaa");
      expect(onChange).toHaveBeenCalledTimes(2);
      ctrl.syncFromStorage();
      expect(ctrl.getSearchQuery()).toBe("aaaa");
      expect(onChange).toHaveBeenCalledTimes(3);

      // setEditingCode no-op, unknown code while rooms exist, trimmed lowercase, repeat
      ctrl.setEditingCode(null);
      expect(onChange).toHaveBeenCalledTimes(3);
      ctrl.setEditingCode("UNKN2345");
      expect(ctrl.getEditingCode()).toBeNull();
      expect(onChange).toHaveBeenCalledTimes(3);
      ctrl.setEditingCode("  aaaa2345  ");
      expect(ctrl.getEditingCode()).toBe("AAAA2345");
      expect(onChange).toHaveBeenCalledTimes(4);
      ctrl.setEditingCode("AAAA2345");
      expect(onChange).toHaveBeenCalledTimes(4);

      // External removal of AAAA2345 leaving BBBB2345 + CCCC2345 clears editingCode & searchQuery
      upsertRecentRoom(seededStorage, { code: "DDDD2345", role: "guest", lastJoinedAt: now - 300 }, now);
      const filteredSeed = loadRecentRooms(seededStorage, now).filter((r) => r.code !== "AAAA2345");
      seededStorage.setItem(RECENT_ROOMS_STORAGE_KEY, JSON.stringify(filteredSeed));
      ctrl.syncFromStorage();
      expect(ctrl.getEditingCode()).toBeNull();

      // Trimmed codes & onChange on recordJoin, updatePassword, updatePeers, rename, remove, handleCreatorHostForgotten, handleFatalError, setDisabled, clearAll
      const cBefore = onChange.mock.calls.length;
      ctrl.recordJoin({ code: "  bbbb2345  ", password: "PW_TRIM_12345678" });
      expect(onChange).toHaveBeenCalledTimes(cBefore + 1);
      ctrl.updatePassword("  bbbb2345  ", "PW_TRIM_22345678", false);
      expect(onChange).toHaveBeenCalledTimes(cBefore + 2);
      ctrl.updatePeers("  bbbb2345  ", ["P1", "P2"]);
      expect(onChange).toHaveBeenCalledTimes(cBefore + 3);
      ctrl.updatePeers("  bbbb2345  ", ["P1", "X2"]);
      expect(onChange).toHaveBeenCalledTimes(cBefore + 4);
      ctrl.rename("  bbbb2345  ", "Trimmed");
      expect(onChange).toHaveBeenCalledTimes(cBefore + 5);
      ctrl.rename("  bbbb2345  ", "");
      const clearedB = ctrl.getRooms().find((r) => r.code === "BBBB2345");
      expect(clearedB).toBeDefined();
      expect("label" in (clearedB ?? {})).toBe(false);
      expect(onChange).toHaveBeenCalledTimes(cBefore + 6);
      ctrl.setEditingCode("CCCC2345");
      ctrl.rename("BAD", "Nope");
      expect(ctrl.getEditingCode()).toBe("CCCC2345");
      ctrl.rename("UNKN2345", "Nope");
      expect(ctrl.getEditingCode()).toBeNull();
      expect(onChange).toHaveBeenCalledTimes(cBefore + 8);

      ctrl.remove("BAD");
      expect(onRemoveHostToken).not.toHaveBeenCalled();
      const cBeforeRem = onChange.mock.calls.length;
      ctrl.remove("  cccc2345  ");
      expect(onRemoveHostToken).toHaveBeenCalledWith("CCCC2345");
      expect(onChange).toHaveBeenCalledTimes(cBeforeRem + 1);

      // handleCreatorHostForgotten: trim, invalid, onChange, normalizeUiState (3->2 drops search & editingCode)
      // Currently 2 rooms (BBBB2345, DDDD2345); adding FFFF2345 makes 3, then passwordless forget drops to 2
      ctrl.recordJoin({ code: "FFFF2345" });
      ctrl.setSearchQuery("bbbb");
      ctrl.setEditingCode("FFFF2345");
      const cBeforeHost = onChange.mock.calls.length;
      ctrl.handleCreatorHostForgotten("BAD");
      expect(onChange).toHaveBeenCalledTimes(cBeforeHost);
      ctrl.handleCreatorHostForgotten("  ffff2345  ");
      expect(onChange).toHaveBeenCalledTimes(cBeforeHost + 1);
      expect(ctrl.getSearchQuery()).toBe("");
      expect(ctrl.getEditingCode()).toBeNull();
      ctrl.recordJoin({ code: "EEEE2345", password: "PASS_EEEE_123456" });
      ctrl.handleCreatorHostForgotten("  eeee2345  ");
      expect(onChange).toHaveBeenCalledTimes(cBeforeHost + 3);
      expect(ctrl.getRooms().find((r) => r.code === "EEEE2345")?.role).toBe("guest");

      // handleFatalError: invalid, trim, onRemoveHostToken(code, expectedHostToken), onChange
      const cBeforeFatal = onChange.mock.calls.length;
      expect(ctrl.handleFatalError("BAD", "kicked")).toBe(false);
      expect(onChange).toHaveBeenCalledTimes(cBeforeFatal);
      onRemoveHostToken.mockClear();
      expect(ctrl.handleFatalError("  eeee2345  ", "kicked", "tok-exp")).toBe(true);
      expect(onRemoveHostToken).toHaveBeenCalledTimes(1);
      expect(onRemoveHostToken).toHaveBeenCalledWith("EEEE2345", "tok-exp");
      expect(onChange).toHaveBeenCalledTimes(cBeforeFatal + 1);

      // recordJoin with empty peerNames preserves existing persisted peerNames
      upsertRecentRoom(seededStorage, { code: "PEER2345", role: "guest", lastJoinedAt: now, peerNames: ["Alice"] }, now);
      ctrl.syncFromStorage(false);
      ctrl.recordJoin({ code: "PEER2345", peerNames: [] });
      expect(loadRecentRooms(seededStorage, now).find((r) => r.code === "PEER2345")?.peerNames).toEqual(["Alice"]);

      // setDisabled & clearAll onChange counts + searchQuery reset
      ctrl.recordJoin({ code: "GGGG2345" });
      ctrl.recordJoin({ code: "HHHH2345" });
      ctrl.setSearchQuery("gggg");
      const cBeforeDis = onChange.mock.calls.length;
      ctrl.setDisabled(false); // idempotent no-op
      expect(onChange).toHaveBeenCalledTimes(cBeforeDis);
      ctrl.setDisabled(true);
      expect(onChange).toHaveBeenCalledTimes(cBeforeDis + 1);
      expect(ctrl.getSearchQuery()).toBe("");
      ctrl.setDisabled(true); // idempotent no-op
      expect(onChange).toHaveBeenCalledTimes(cBeforeDis + 1);
      ctrl.setDisabled(false);
      expect(onChange).toHaveBeenCalledTimes(cBeforeDis + 2);
      ctrl.clearAll();
      expect(onChange).toHaveBeenCalledTimes(cBeforeDis + 3);
      expect(ctrl.getSearchQuery()).toBe("");
    }

    // 3. Double pending setDisabled & pendingClearAll edge cases (Explorer M3-3 killers)
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flush();

      // setDisabled(true) -> setDisabled(false) -> flush lock 1 only -> syncFromStorage keeps isDisabled === false
      h.ctrl.setDisabled(true);
      h.ctrl.setDisabled(false);
      h.pendingLockReleases.shift()?.();
      await Promise.resolve();
      h.ctrl.syncFromStorage();
      expect(h.ctrl.isDisabled()).toBe(false);
      await h.flush();

      // setDisabled(true) -> setDisabled(false) -> setDisabled(true) -> flush lock 1 only -> Tab 2 writes XTAB -> syncFromStorage keeps []
      h.ctrl.setDisabled(true);
      h.ctrl.setDisabled(false);
      h.ctrl.setDisabled(true);
      h.pendingLockReleases.shift()?.();
      await Promise.resolve();
      upsertRecentRoom(h.storage, { code: "XTAB2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms()).toEqual([]);
      await h.flush();

      // clearAll -> recordJoin(BBBB) -> remove(BBBB) while clearAll lock is pending -> syncFromStorage keeps BBBB removed
      h.ctrl.setDisabled(false);
      await h.flush();
      h.ctrl.clearAll();
      h.ctrl.recordJoin({ code: "BBBB2345" });
      h.ctrl.remove("BBBB2345");
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms()).toEqual([]);
      await h.flush();

      // remove(A) lock 1 pending -> recordJoin(A) -> remove(A) lock 2 pending -> resolve lock 1 only -> syncFromStorage keeps A absent
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flush();
      h.ctrl.remove("AAAA2345");
      const rem1 = h.pendingLockReleases.shift();
      h.ctrl.recordJoin({ code: "AAAA2345" });
      const join2 = h.pendingLockReleases.shift();
      h.ctrl.remove("AAAA2345");
      rem1?.();
      join2?.();
      await Promise.resolve();
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms()).toEqual([]);
      await h.flush();
    }
  });

  it("preserves synthesized host metadata edits across recordJoin (FIFO & reverse) and Tab B concurrent joins (Probes 1B & Reviewer 2)", async () => {
    const now = 1_700_000_000_000;

    // 1. Synthesized host-rooms rename / updatePeers / updatePassword -> recordJoin under FIFO and reverse lock order
    for (const reverseOrder of [false, true]) {
      const h = makeHarness({ creatorCodes: new Set(["SYNA2345", "SYNB2345", "SYNC2345"]), deferredLocks: true, now: () => now });
      writePersistedHostToken(h.storage, "SYNA2345", "tok-a", now - 1000);
      writePersistedHostToken(h.storage, "SYNB2345", "tok-b", now - 2000);
      writePersistedHostToken(h.storage, "SYNC2345", "tok-c", now - 3000);
      h.ctrl.syncFromStorage(false);

      h.ctrl.rename("SYNA2345", "Work Sync");
      h.ctrl.recordJoin({ code: "SYNA2345", password: "JOIN_PASS_A_1234" });

      h.ctrl.updatePeers("SYNB2345", ["Bob"]);
      h.ctrl.recordJoin({ code: "SYNB2345", password: "JOIN_PASS_B_1234" });

      h.ctrl.updatePassword("SYNC2345", "PATCH_PASS_C_123", false);
      h.ctrl.recordJoin({ code: "SYNC2345" });

      if (reverseOrder) {
        const locks = h.pendingLockReleases.splice(0).reverse();
        for (const release of locks) {
          release();
          await Promise.resolve();
        }
      }
      await h.flush();

      const synaMem = h.ctrl.getRooms().find((r) => r.code === "SYNA2345");
      const synaDisk = loadRecentRooms(h.storage, now).find((r) => r.code === "SYNA2345");
      expect(synaMem?.label).toBe("Work Sync");
      expect(synaMem?.password).toBe("JOIN_PASS_A_1234");
      expect(synaDisk?.label).toBe("Work Sync");
      expect(synaDisk?.password).toBe("JOIN_PASS_A_1234");

      const synbDisk = loadRecentRooms(h.storage, now).find((r) => r.code === "SYNB2345");
      expect(synbDisk?.peerNames).toEqual(["Bob"]);
      expect(synbDisk?.password).toBe("JOIN_PASS_B_1234");

      const syncDisk = loadRecentRooms(h.storage, now).find((r) => r.code === "SYNC2345");
      expect(syncDisk?.password).toBe("PATCH_PASS_C_123");
    }

    // 2. Probe 1B: Synthesized host-rooms + rename in Tab A racing with Tab B join must not poison syncFromStorage()
    {
      const h = makeHarness({ creatorCodes: new Set(["HCST2345"]), deferredLocks: true, now: () => now });
      writePersistedHostToken(h.storage, "HCST2345", "tok-hcst", now - 1000);
      h.ctrl.syncFromStorage(false);

      h.ctrl.rename("HCST2345", "Tab A Label");
      // Before Tab A's lock executes, Tab B persists HCST2345 to recent-rooms
      upsertRecentRoom(
        h.storage,
        { code: "HCST2345", role: "guest", password: "TAB_B_PASSWORD_1", peerNames: ["Bob"], lastJoinedAt: now },
        now,
      );
      await h.flush();

      h.ctrl.syncFromStorage();
      const memAfterSync = h.ctrl.getRooms().find((r) => r.code === "HCST2345");
      expect(memAfterSync).toBeDefined();
      expect(memAfterSync?.label).toBe("Tab A Label");
      expect(memAfterSync?.password).toBe("TAB_B_PASSWORD_1");
      expect(memAfterSync?.peerNames).toEqual(["Bob"]);

      // Subsequent Tab B updates must continue propagating on syncFromStorage()
      upsertRecentRoom(
        h.storage,
        { code: "HCST2345", role: "guest", password: "TAB_B_PASSWORD_2", peerNames: ["Bob", "Carol"], lastJoinedAt: now + 100 },
        now + 100,
      );
      h.ctrl.syncFromStorage();
      const memAfterSecondSync = h.ctrl.getRooms().find((r) => r.code === "HCST2345");
      expect(memAfterSecondSync?.password).toBe("TAB_B_PASSWORD_2");
      expect(memAfterSecondSync?.peerNames).toEqual(["Bob", "Carol"]);
      expect(memAfterSecondSync?.label).toBe("Tab A Label");
    }
  });

  it("preserves intermediate patches across recordJoin -> patch -> recordJoin under transient failure and out-of-order locks (Probes 1C-v1 & 1C-v2)", async () => {
    const now = 1_700_000_000_000;

    // 1C-v1: recordJoin (QuotaExceededError) -> rename -> recordJoin -> storage recovers -> FIFO flush
    {
      const inner = makeMemoryStorage();
      let failSet = true;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          if (failSet) throw new Error("QuotaExceededError");
          inner.setItem(k, v);
        },
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: async (_name, cb) => {
          await new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
            });
          });
        },
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      ctrl.recordJoin({ code: "ABCD2345", password: "PASS1_1234567890" });
      pending.shift()?.();
      await Promise.resolve();

      ctrl.rename("ABCD2345", "Important Label");
      ctrl.recordJoin({ code: "ABCD2345", password: "PASS2_1234567890" });
      failSet = false;
      while (pending.length > 0) {
        pending.shift()?.();
        await Promise.resolve();
      }
      await Promise.all(tasks);

      const mem = ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(inner, now).find((r) => r.code === "ABCD2345");
      expect(mem?.label).toBe("Important Label");
      expect(mem?.password).toBe("PASS2_1234567890");
      expect(disk?.label).toBe("Important Label");
      expect(disk?.password).toBe("PASS2_1234567890");
    }

    // 1C-v2 & field precedence: recordJoin -> rename / updatePassword / updatePeers -> recordJoin with out-of-order locks
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "ABCD2345", password: "PASS1_1234567890" });
      h.ctrl.rename("ABCD2345", "Keep My Label");
      h.ctrl.recordJoin({ code: "ABCD2345", password: "PASS2_1234567890" });

      // Resolve rename lock (lock 2) BEFORE join1 (lock 1) and join2 (lock 3)
      const join1 = h.pendingLockReleases.shift();
      const renameLock = h.pendingLockReleases.shift();
      const join2 = h.pendingLockReleases.shift();
      renameLock?.();
      await Promise.resolve();
      join1?.();
      join2?.();
      await h.flush();

      const mem = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "ABCD2345");
      expect(mem?.label).toBe("Keep My Label");
      expect(mem?.password).toBe("PASS2_1234567890");
      expect(disk?.label).toBe("Keep My Label");
      expect(disk?.password).toBe("PASS2_1234567890");

      // Newer recordJoin password overrides older updatePassword even when updatePassword lock resolves first;
      // omitted peerNames in newer recordJoin retains earlier updatePeers
      h.ctrl.recordJoin({ code: "EFGH2345", password: "INIT_PASS_123456" });
      h.ctrl.updatePassword("EFGH2345", "OLD_PATCH_PASS12", false);
      h.ctrl.updatePeers("EFGH2345", ["Alice"]);
      h.ctrl.recordJoin({ code: "EFGH2345", password: "NEW_JOIN_PASS123" });
      const eJoin1 = h.pendingLockReleases.shift();
      const ePwPatch = h.pendingLockReleases.shift();
      const ePeersPatch = h.pendingLockReleases.shift();
      const eJoin2 = h.pendingLockReleases.shift();
      ePwPatch?.();
      await Promise.resolve();
      ePeersPatch?.();
      await Promise.resolve();
      eJoin1?.();
      eJoin2?.();
      await h.flush();

      const efghDisk = loadRecentRooms(h.storage, now).find((r) => r.code === "EFGH2345");
      expect(efghDisk?.password).toBe("NEW_JOIN_PASS123");
      expect(efghDisk?.peerNames).toEqual(["Alice"]);
    }
  });

  it("recovers from QuotaExceededError/SecurityError split-brain on syncFromStorage without infinite retries (Probes 2A-1, 2A-2, 2B-1)", async () => {
    const now = 1_700_000_000_000;

    const createFlakyHarness = () => {
      const inner = makeMemoryStorage();
      let failSet = false;
      let failRemove = false;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          if (failSet) throw new Error("QuotaExceededError");
          inner.setItem(k, v);
        },
        removeItem: (k) => {
          if (failRemove) throw new Error("SecurityError");
          inner.removeItem(k);
        },
      };
      const tasks: Promise<unknown>[] = [];
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });
      return {
        inner,
        ctrl,
        tasks,
        setFailSet: (v: boolean) => {
          failSet = v;
        },
        setFailRemove: (v: boolean) => {
          failRemove = v;
        },
      };
    };

    // 2A-1: QuotaExceededError on setItem only during setDisabled(true), then recovery + syncFromStorage
    {
      const h = createFlakyHarness();
      h.ctrl.recordJoin({ code: "ABCD2345" });
      await Promise.all(h.tasks.splice(0));

      h.setFailSet(true);
      h.ctrl.setDisabled(true);
      await Promise.all(h.tasks.splice(0));
      expect(isRecentRoomsDisabled(h.inner)).toBe(false);

      // Continued failure on syncFromStorage must not infinitely recurse
      h.ctrl.syncFromStorage();
      await Promise.all(h.tasks.splice(0));
      expect(h.ctrl.isDisabled()).toBe(true);

      // Recover storage; Tab B sees disabled=false and saves EFGH2345; Tab A syncFromStorage reconciles
      h.setFailSet(false);
      upsertRecentRoom(h.inner, { code: "EFGH2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();
      await Promise.all(h.tasks.splice(0));
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(isRecentRoomsDisabled(h.inner)).toBe(true);
      expect(loadRecentRooms(h.inner, now)).toEqual([]);
    }

    // 2A-2: QuotaExceededError on rename drops failed patch so Tab B's later label is never shadowed forever
    {
      const h = createFlakyHarness();
      h.ctrl.recordJoin({ code: "ABCD2345" });
      await Promise.all(h.tasks.splice(0));

      h.setFailSet(true);
      h.ctrl.rename("ABCD2345", "Tab A Failed Label");
      await Promise.all(h.tasks.splice(0));

      h.setFailSet(false);
      upsertRecentRoom(h.inner, { code: "ABCD2345", role: "guest", label: "Tab B Saved Label", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();
      h.ctrl.updatePeers("ABCD2345", ["Alice"]);
      await Promise.all(h.tasks.splice(0));
      h.ctrl.syncFromStorage();

      const mem = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(h.inner, now).find((r) => r.code === "ABCD2345");
      expect(mem?.label).toBe("Tab B Saved Label");
      expect(disk?.label).toBe("Tab B Saved Label");
      expect(disk?.peerNames).toEqual(["Alice"]);
    }

    // 2B-1: SecurityError on clearAll() retries removal on syncFromStorage() once storage recovers
    {
      const h = createFlakyHarness();
      h.ctrl.recordJoin({ code: "ABCD2345" });
      await Promise.all(h.tasks.splice(0));

      h.setFailRemove(true);
      h.ctrl.clearAll();
      await Promise.all(h.tasks.splice(0));
      expect(loadRecentRooms(h.inner, now).some((r) => r.code === "ABCD2345")).toBe(true);

      h.setFailRemove(false);
      upsertRecentRoom(h.inner, { code: "EFGH2345", role: "guest", lastJoinedAt: now + 1000 }, now + 1000);
      h.ctrl.syncFromStorage();
      await Promise.all(h.tasks.splice(0));
      expect(loadRecentRooms(h.inner, now + 1000).some((r) => r.code === "ABCD2345")).toBe(false);

      // Subsequent cross-tab write is visible because persistedClearAllGen caught up to clearAllGen
      upsertRecentRoom(h.inner, { code: "JKMN2345", role: "guest", lastJoinedAt: now + 2000 }, now + 2000);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["JKMN2345"]);
    }

    // 4. Synthesized room failed rename reverts cleanly, and newer queued rename survives earlier failed rename
    {
      const inner = makeMemoryStorage();
      let failSet = false;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          if (failSet) throw new Error("QuotaExceededError");
          inner.setItem(k, v);
        },
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: async (_name, cb) => {
          await new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
            });
          });
        },
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: (c) => c === "SYNF2345",
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      writePersistedHostToken(inner, "SYNF2345", "tok-synf", now);
      ctrl.syncFromStorage(false);
      failSet = true;
      ctrl.rename("SYNF2345", "Failed Synth Label");
      pending.shift()?.();
      await Promise.all(tasks.splice(0));
      const synfMem = ctrl.getRooms().find((r) => r.code === "SYNF2345");
      expect(synfMem).toBeDefined();
      expect(synfMem?.label).toBeUndefined();

      failSet = false;
      ctrl.recordJoin({ code: "ABCD2345" });
      pending.shift()?.();
      await Promise.all(tasks.splice(0));

      failSet = true;
      ctrl.rename("ABCD2345", "Label 1 Fail");
      const lockFail = pending.shift();
      ctrl.rename("ABCD2345", "Label 2 Keep");
      const lockKeep = pending.shift();
      lockFail?.();
      await Promise.resolve();
      failSet = false;
      lockKeep?.();
      await Promise.all(tasks.splice(0));
      expect(ctrl.getRooms().find((r) => r.code === "ABCD2345")?.label).toBe("Label 2 Keep");
      expect(loadRecentRooms(inner, now).find((r) => r.code === "ABCD2345")?.label).toBe("Label 2 Keep");
    }
  });

  it("drops stale pre-delete patches on externally deleted synthesized host rooms before fresh recordJoin (Probes 1E-ExternalDelete & NoSync)", async () => {
    const now = 1_700_000_000_000;

    for (const runSyncBeforeJoin of [true, false]) {
      for (const reverseOrder of [false, true]) {
        const h = makeHarness({ creatorCodes: new Set(["SYNA2345"]), deferredLocks: true, now: () => now });
        writePersistedHostToken(h.storage, "SYNA2345", "tok-syna", now - 1000);
        h.ctrl.syncFromStorage(false);
        expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["SYNA2345"]);

        h.ctrl.rename("SYNA2345", "Stale Pre-Delete Label");
        const renameLock = h.pendingLockReleases.shift();

        // External Tab B deletes SYNA2345 from host-rooms and creator tokens
        h.storage.removeItem(HOST_ROOMS_STORAGE_KEY);
        h.creatorCodes.delete("SYNA2345");
        if (runSyncBeforeJoin) {
          h.ctrl.syncFromStorage(false);
          expect(h.ctrl.getRooms()).toEqual([]);
        }

        h.ctrl.recordJoin({ code: "SYNA2345", password: "FRESH_GUEST_PW12" });
        const joinLock = h.pendingLockReleases.shift();

        if (reverseOrder) {
          joinLock?.();
          await Promise.resolve();
          renameLock?.();
        } else {
          renameLock?.();
          await Promise.resolve();
          joinLock?.();
        }
        await h.flush();

        const mem = h.ctrl.getRooms().find((r) => r.code === "SYNA2345");
        const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "SYNA2345");
        expect(mem).toBeDefined();
        expect(mem?.password).toBe("FRESH_GUEST_PW12");
        expect(mem?.label).toBeUndefined();
        expect(disk).toBeDefined();
        expect(disk?.password).toBe("FRESH_GUEST_PW12");
        expect(disk?.label).toBeUndefined();
      }
    }
  });

  it("scrubs failed patch fields from memory when sibling pendingJoin or synth patches succeed (Probes 1H & 1L)", async () => {
    const now = 1_700_000_000_000;

    // 1H: pendingJoin + failed rename -> failed label scrubbed from memory & disk; prior saved label restored
    for (const withPriorLabel of [false, true]) {
      const inner = makeMemoryStorage();
      let failSet = false;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          if (failSet) throw new Error("QuotaExceededError");
          inner.setItem(k, v);
        },
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: async (_name, cb) => {
          await new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
            });
          });
        },
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      ctrl.recordJoin({ code: "ABCD2345", password: "PW1_123456789012" });
      if (withPriorLabel) ctrl.rename("ABCD2345", "Saved Label");
      while (pending.length > 0) pending.shift()?.();
      await Promise.all(tasks.splice(0));

      ctrl.recordJoin({ code: "ABCD2345", password: "PW2_123456789012" });
      const joinLock = pending.shift();
      ctrl.rename("ABCD2345", withPriorLabel ? "" : "Failed Ghost Label");
      const renameLock = pending.shift();

      failSet = true;
      renameLock?.();
      await Promise.resolve();
      failSet = false;
      joinLock?.();
      await Promise.all(tasks.splice(0));

      const mem = ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(inner, now).find((r) => r.code === "ABCD2345");
      expect(mem).toBeDefined();
      expect(mem?.password).toBe("PW2_123456789012");
      expect(mem?.label).toBe(withPriorLabel ? "Saved Label" : undefined);
      expect(disk).toBeDefined();
      expect(disk?.password).toBe("PW2_123456789012");
      expect(disk?.label).toBe(withPriorLabel ? "Saved Label" : undefined);
    }

    // 1L: synthesized host room failed rename + sibling updatePeers (both FIFO and reverse lock orders)
    for (const reverseOrder of [false, true]) {
      const inner = makeMemoryStorage();
      let failSet = false;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          if (failSet) throw new Error("QuotaExceededError");
          inner.setItem(k, v);
        },
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: async (_name, cb) => {
          await new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
            });
          });
        },
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: (c) => c === "SYNA2345",
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      writePersistedHostToken(inner, "SYNA2345", "tok-syna", now - 1000);
      ctrl.syncFromStorage(false);

      ctrl.rename("SYNA2345", "Failed Synth Label");
      const renameLock = pending.shift();
      ctrl.updatePeers("SYNA2345", ["Alice"]);
      const peersLock = pending.shift();

      if (reverseOrder) {
        peersLock?.();
        await Promise.resolve();
        failSet = true;
        renameLock?.();
        await Promise.resolve();
        failSet = false;
      } else {
        failSet = true;
        renameLock?.();
        await Promise.resolve();
        failSet = false;
        peersLock?.();
      }
      await Promise.all(tasks.splice(0));

      const mem = ctrl.getRooms().find((r) => r.code === "SYNA2345");
      const disk = loadRecentRooms(inner, now).find((r) => r.code === "SYNA2345");
      expect(mem).toBeDefined();
      expect(mem?.label).toBeUndefined();
      expect(mem?.peerNames).toEqual(["Alice"]);
      expect(disk).toBeDefined();
      expect(disk?.label).toBeUndefined();
      expect(disk?.peerNames).toEqual(["Alice"]);
    }
  });

  it("recovers failed remove(code) and failed recordJoin under transient storage faults (Probes 1G & 2D)", async () => {
    let now = 1_700_000_000_000;

    // 2D: SecurityError on remove(code) retries removal cleanly when storage recovers and syncFromStorage runs
    {
      const inner = makeMemoryStorage();
      let failRemove = false;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => inner.setItem(k, v),
        removeItem: (k) => {
          if (failRemove) throw new Error("SecurityError");
          inner.removeItem(k);
        },
      };
      const tasks: Promise<unknown>[] = [];
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      ctrl.recordJoin({ code: "ABCD2345", password: "ROOM_PASS_123456" });
      await Promise.all(tasks.splice(0));

      failRemove = true;
      ctrl.remove("ABCD2345");
      await Promise.all(tasks.splice(0));
      expect(ctrl.getRooms()).toEqual([]);
      expect(loadRecentRooms(inner, now)).toHaveLength(1);

      // Persistent failure on syncFromStorage must not loop
      ctrl.syncFromStorage();
      await Promise.all(tasks.splice(0));
      expect(tasks).toHaveLength(0);

      // Recovery + syncFromStorage flushes removal to disk
      failRemove = false;
      ctrl.syncFromStorage();
      await Promise.all(tasks.splice(0));
      expect(ctrl.getRooms()).toEqual([]);
      expect(loadRecentRooms(inner, now)).toEqual([]);
    }

    // 1G counterexamples + fast-check transient storage fault recovery property
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("fault-get" as const), fail: fc.boolean() }),
            fc.record({ kind: fc.constant("fault-set" as const), fail: fc.boolean() }),
            fc.record({ kind: fc.constant("fault-rem" as const), fail: fc.boolean() }),
            fc.record({
              kind: fc.constant("a-join" as const),
              code: fc.constantFrom("ABCD2345", "EFGH2345", "JKMN2345"),
              pw: fc.option(fc.constantFrom("PASS_A_12345678", "PASS_B_12345678"), { nil: undefined }),
            }),
            fc.record({
              kind: fc.constant("b-join" as const),
              code: fc.constantFrom("ABCD2345", "EFGH2345", "JKMN2345"),
              pw: fc.option(fc.constantFrom("TABB_PW_1234567", "TABB_PW_2234567"), { nil: undefined }),
            }),
            fc.record({
              kind: fc.constant("a-rename" as const),
              code: fc.constantFrom("ABCD2345", "EFGH2345", "JKMN2345"),
              label: fc.constantFrom("Alpha", "Beta", ""),
            }),
            fc.record({
              kind: fc.constant("a-peers" as const),
              code: fc.constantFrom("ABCD2345", "EFGH2345", "JKMN2345"),
              peers: fc.constantFrom(["Alice"], ["Bob", "Carol"]),
            }),
            fc.record({
              kind: fc.constant("a-remove" as const),
              code: fc.constantFrom("ABCD2345", "EFGH2345", "JKMN2345"),
            }),
            fc.record({ kind: fc.constant("a-sync" as const) }),
            fc.record({ kind: fc.constant("flush" as const) }),
          ),
          { minLength: 1, maxLength: 20 },
        ),
        async (ops) => {
          now = 1_700_000_000_000;
          const inner = makeMemoryStorage();
          let failGet = false;
          let failSet = false;
          let failRem = false;
          const storage: StorageLike = {
            getItem: (k) => {
              if (failGet) throw new Error("SecurityError");
              return inner.getItem(k);
            },
            setItem: (k, v) => {
              if (failSet) throw new Error("QuotaExceededError");
              inner.setItem(k, v);
            },
            removeItem: (k) => {
              if (failRem) throw new Error("SecurityError");
              inner.removeItem(k);
            },
          };
          const tasks: Promise<unknown>[] = [];
          const pending: Array<() => void> = [];
          const locks: LockManagerLike = {
            request: async (_name, cb) => {
              await new Promise<void>((resolve) => {
                pending.push(() => {
                  void Promise.resolve(cb()).finally(resolve);
                });
              });
            },
          };
          const flushAll = async () => {
            while (pending.length > 0 || tasks.length > 0) {
              while (pending.length > 0) {
                pending.shift()?.();
                await Promise.resolve();
              }
              if (tasks.length > 0) await Promise.all(tasks.splice(0));
            }
          };
          const ctrl = new RecentRoomsController({
            getLocalStorage: () => storage,
            getLocks: () => locks,
            runBackground: (t) => {
              tasks.push(t);
            },
            hasSavedCreatorHostFor: () => false,
            onRemoveHostToken: vi.fn(),
            onForgetAllHostTokens: vi.fn(),
            onChange: vi.fn(),
            now: () => now,
          });

          for (const op of ops) {
            now += 1;
            if (op.kind === "fault-get") failGet = op.fail;
            else if (op.kind === "fault-set") failSet = op.fail;
            else if (op.kind === "fault-rem") failRem = op.fail;
            else if (op.kind === "a-join") ctrl.recordJoin({ code: op.code, password: op.pw });
            else if (op.kind === "b-join") {
              upsertRecentRoom(
                inner,
                { code: op.code, role: "guest", ...(op.pw !== undefined ? { password: op.pw } : {}), lastJoinedAt: now },
                now,
              );
            } else if (op.kind === "a-rename") ctrl.rename(op.code, op.label);
            else if (op.kind === "a-peers") ctrl.updatePeers(op.code, op.peers);
            else if (op.kind === "a-remove") ctrl.remove(op.code);
            else if (op.kind === "a-sync") {
              ctrl.syncFromStorage();
              // Even if storage is still partially faulted (e.g. setItem QuotaExceededError),
              // if reads work and no ops/removals remain pending, memory matches disk
              if (!failGet && pending.length === 0) {
                await flushAll();
              }
            } else await flushAll();
          }

          await flushAll();
          // Check convergence even if failSet/failRem are still true as long as no removals are pending
          failGet = false;
          failSet = false;
          failRem = false;
          ctrl.syncFromStorage();
          await flushAll();

          const expected = mergeSynthesizedHostRooms(
            loadRecentRooms(inner, now),
            listPersistedHostRooms(inner, now),
            () => false,
          );
          expect(ctrl.getRooms()).toEqual(expected);
        },
      ),
      { numRuns: 150 },
    );

    // Explicit Challenger 1 minimized 1G counterexamples (including unrecovered fault-set during a-sync)
    {
      const inner = makeMemoryStorage();
      let failGet = false;
      let failSet = true;
      const storage: StorageLike = {
        getItem: (k) => {
          if (failGet) throw new Error("SecurityError");
          return inner.getItem(k);
        },
        setItem: (k, v) => {
          if (failSet) throw new Error("QuotaExceededError");
          inner.setItem(k, v);
        },
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      // fault-set counterexample: Tab B writes B_PW1, Tab A fails join on setItem, syncFromStorage reconciles to B_PW1 even while failSet=true
      upsertRecentRoom(inner, { code: "ABCD2345", role: "guest", password: "TABB_PW_1234567", lastJoinedAt: now }, now);
      now += 1;
      ctrl.recordJoin({ code: "ABCD2345" });
      await Promise.all(tasks.splice(0));
      ctrl.syncFromStorage();
      await Promise.all(tasks.splice(0));
      expect(ctrl.getRooms()).toEqual(loadRecentRooms(inner, now));

      // fault-get counterexample: Tab A fails join on getItem, recovers, syncFromStorage drops phantom join
      failSet = false;
      failGet = true;
      ctrl.recordJoin({ code: "EFGH2345" });
      await Promise.all(tasks.splice(0));
      failGet = false;
      ctrl.syncFromStorage();
      await Promise.all(tasks.splice(0));
      expect(ctrl.getRooms()).toEqual(loadRecentRooms(inner, now));
    }
  });

  it("drops all multi-patch pre-delete edits on externally deleted synthesized rooms across lock permutations (Multi-Patch 1E-ExternalDelete-NoSync)", async () => {
    const now = 1_700_000_000_000;
    const permutations: Array<readonly [number, number, number]> = [
      [0, 1, 2],
      [2, 1, 0],
      [0, 2, 1],
      [1, 2, 0],
      [2, 0, 1],
    ];

    // 1. rename + updatePeers before external delete -> recordJoin
    for (const order of permutations) {
      const h = makeHarness({ creatorCodes: new Set(["SYNA2345"]), deferredLocks: true, now: () => now });
      writePersistedHostToken(h.storage, "SYNA2345", "tok-syna", now - 1000);
      h.ctrl.syncFromStorage(false);

      h.ctrl.rename("SYNA2345", "Stale Multi Label");
      h.ctrl.updatePeers("SYNA2345", ["StalePeer"]);
      h.storage.removeItem(HOST_ROOMS_STORAGE_KEY);
      h.creatorCodes.delete("SYNA2345");
      h.ctrl.recordJoin({ code: "SYNA2345", password: "FRESH_MULTI_PW12" });

      const locks = h.pendingLockReleases.splice(0);
      for (const idx of order) {
        locks[idx]?.();
        await Promise.resolve();
      }
      await h.flush();

      const mem = h.ctrl.getRooms().find((r) => r.code === "SYNA2345");
      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "SYNA2345");
      expect(mem).toBeDefined();
      expect(mem?.password).toBe("FRESH_MULTI_PW12");
      expect(mem?.peerNames).toEqual([]);
      expect(mem?.label).toBeUndefined();
      expect(disk).toBeDefined();
      expect(disk?.password).toBe("FRESH_MULTI_PW12");
      expect(disk?.peerNames).toEqual([]);
      expect(disk?.label).toBeUndefined();
    }

    // 2. updatePeers + rename AND rename1 + rename2 before external delete -> recordJoin under [3,2,1] and [1,3,2]
    for (const variant of ["peers-then-rename", "rename-twice"] as const) {
      for (const order of [
        [2, 1, 0],
        [0, 2, 1],
      ] as const) {
        const h = makeHarness({ creatorCodes: new Set(["SYNA2345"]), deferredLocks: true, now: () => now });
        writePersistedHostToken(h.storage, "SYNA2345", "tok-syna", now - 1000);
        h.ctrl.syncFromStorage(false);

        if (variant === "peers-then-rename") {
          h.ctrl.updatePeers("SYNA2345", ["StalePeer"]);
          h.ctrl.rename("SYNA2345", "Stale Ghost Label");
        } else {
          h.ctrl.rename("SYNA2345", "Old1");
          h.ctrl.rename("SYNA2345", "Old2");
        }
        h.storage.removeItem(HOST_ROOMS_STORAGE_KEY);
        h.creatorCodes.delete("SYNA2345");
        h.ctrl.recordJoin({ code: "SYNA2345", password: "FRESH_GUEST_PW12" });

        const locks = h.pendingLockReleases.splice(0);
        for (const idx of order) {
          locks[idx]?.();
          await Promise.resolve();
        }
        await h.flush();

        const mem = h.ctrl.getRooms().find((r) => r.code === "SYNA2345");
        const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "SYNA2345");
        expect(mem).toBeDefined();
        expect(mem?.password).toBe("FRESH_GUEST_PW12");
        expect(mem?.peerNames).toEqual([]);
        expect(mem?.label).toBeUndefined();
        expect(disk).toBeDefined();
        expect(disk?.password).toBe("FRESH_GUEST_PW12");
        expect(disk?.peerNames).toEqual([]);
        expect(disk?.label).toBeUndefined();
      }
    }

    // 3. Post-join patch after recordJoin survives while pre-join synth patches are dropped under [3,2,1] and [1,3,2]
    for (const order of [
      [2, 3, 1, 0],
      [0, 2, 3, 1],
    ] as const) {
      const h = makeHarness({ creatorCodes: new Set(["SYNA2345"]), deferredLocks: true, now: () => now });
      writePersistedHostToken(h.storage, "SYNA2345", "tok-syna", now - 1000);
      h.ctrl.syncFromStorage(false);

      h.ctrl.rename("SYNA2345", "PreJoinStale");
      h.ctrl.updatePeers("SYNA2345", ["StalePeer"]);
      h.storage.removeItem(HOST_ROOMS_STORAGE_KEY);
      h.creatorCodes.delete("SYNA2345");
      h.ctrl.recordJoin({ code: "SYNA2345", password: "FRESH_MULTI_PW12" });
      h.ctrl.rename("SYNA2345", "KeepAfterJoin");

      const locks = h.pendingLockReleases.splice(0);
      for (const idx of order) {
        locks[idx]?.();
        await Promise.resolve();
      }
      await h.flush();

      const mem = h.ctrl.getRooms().find((r) => r.code === "SYNA2345");
      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "SYNA2345");
      expect(mem).toBeDefined();
      expect(mem?.label).toBe("KeepAfterJoin");
      expect(mem?.peerNames).toEqual([]);
      expect(disk).toBeDefined();
      expect(disk?.label).toBe("KeepAfterJoin");
      expect(disk?.peerNames).toEqual([]);
    }
  });

  it("clears pre-opt-out pending syncState and barriers queued locks on cross-tab opt-out (Scenarios A & B)", async () => {
    let now = 1_700_000_000_000;

    // Scenario A: Tab B queues join+rename -> Tab A opts out -> Tab B observes opt-out (via lock or sync) -> Tab A re-enables & joins with new secret -> Tab B re-enables & syncs
    for (const observeVia of ["write-lock", "sync"] as const) {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "ABCD2345", password: "OLD_SECRET_12345" });
      h.ctrl.rename("ABCD2345", "Old Label");

      // Tab A enables opt-out and wipes storage
      h.storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      h.storage.removeItem(RECENT_ROOMS_STORAGE_KEY);

      if (observeVia === "write-lock") {
        await h.flush();
      } else {
        h.ctrl.syncFromStorage();
      }
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(h.ctrl.getRooms()).toEqual([]);

      // Tab A later disables opt-out and joins ABCD2345 with NEW_SECRET_12345
      now += 1000;
      h.storage.removeItem(RECENT_ROOMS_OPT_OUT_KEY);
      upsertRecentRoom(
        h.storage,
        { code: "ABCD2345", role: "guest", password: "NEW_SECRET_12345", lastJoinedAt: now },
        now,
      );

      // Tab B re-enables and calls syncFromStorage(), then updates peers
      h.ctrl.setDisabled(false);
      await h.flush();
      h.ctrl.syncFromStorage();
      h.ctrl.updatePeers("ABCD2345", ["Alice"]);
      await h.flush();

      const mem = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "ABCD2345");
      expect(mem).toBeDefined();
      expect(mem?.password).toBe("NEW_SECRET_12345");
      expect(mem?.label).toBeUndefined();
      expect(mem?.peerNames).toEqual(["Alice"]);
      expect(disk).toBeDefined();
      expect(disk?.password).toBe("NEW_SECRET_12345");
      expect(disk?.label).toBeUndefined();
      expect(disk?.peerNames).toEqual(["Alice"]);
    }

    // Scenario B: Tab B queues deferred join -> Tab A opts out -> Tab B syncs -> Tab A & Tab B re-enable BEFORE Tab B's deferred lock runs
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "ABCD2345", password: "OLD_SECRET_12345" });
      const deferredOldJoinLock = h.pendingLockReleases.shift();

      h.storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      h.storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.isDisabled()).toBe(true);

      now += 1000;
      h.storage.removeItem(RECENT_ROOMS_OPT_OUT_KEY);
      upsertRecentRoom(
        h.storage,
        { code: "ABCD2345", role: "guest", password: "NEW_SECRET_12345", lastJoinedAt: now },
        now,
      );

      h.ctrl.setDisabled(false);
      const enableLock = h.pendingLockReleases.shift();

      // Flush deferred pre-opt-out join lock before and after enableLock
      deferredOldJoinLock?.();
      await Promise.resolve();
      enableLock?.();
      await h.flush();

      const mem = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "ABCD2345");
      expect(mem).toBeDefined();
      expect(mem?.password).toBe("NEW_SECRET_12345");
      expect(disk).toBeDefined();
      expect(disk?.password).toBe("NEW_SECRET_12345");
    }

    // Scenario C: clearAll() fails with SecurityError -> Tab A opts out -> Tab B observes opt-out without falsely advancing persistedClearAllGen
    {
      const inner = makeMemoryStorage();
      let failRemove = false;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => inner.setItem(k, v),
        removeItem: (k) => {
          if (failRemove) throw new Error("SecurityError");
          inner.removeItem(k);
        },
      };
      const tasks: Promise<unknown>[] = [];
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      ctrl.recordJoin({ code: "ABCD2345", password: "OLD_SECRET_12345" });
      await Promise.all(tasks.splice(0));

      failRemove = true;
      ctrl.clearAll();
      await Promise.all(tasks.splice(0));
      expect(loadRecentRooms(inner, now)).toHaveLength(1);

      inner.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      ctrl.syncFromStorage();
      await Promise.all(tasks.splice(0));
      expect(ctrl.isDisabled()).toBe(true);

      failRemove = false;
      ctrl.syncFromStorage();
      await Promise.all(tasks.splice(0));
      expect(loadRecentRooms(inner, now)).toEqual([]);
    }
  });

  it("rebuilds unpersisted pending join with queued field patches on syncFromStorage before locks flush", async () => {
    const now = 1_700_000_000_000;
    const h = makeHarness({ deferredLocks: true, now: () => now });

    h.ctrl.recordJoin({ code: "ABCD2345", password: "JOIN_PW_12345678" });
    h.ctrl.rename("ABCD2345", "Queued Label");
    h.ctrl.updatePeers("ABCD2345", ["Alice", "Bob"]);

    // Tab B concurrently writes a different room before Tab A's locks flush
    upsertRecentRoom(h.storage, { code: "EFGH2345", role: "guest", lastJoinedAt: now - 500 }, now);
    h.ctrl.syncFromStorage();

    const mem = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
    expect(mem).toBeDefined();
    expect(mem?.password).toBe("JOIN_PW_12345678");
    expect(mem?.label).toBe("Queued Label");
    expect(mem?.peerNames).toEqual(["Alice", "Bob"]);
    expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["ABCD2345", "EFGH2345"]);

    await h.flush();
    const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "ABCD2345");
    expect(disk).toBeDefined();
    expect(disk?.password).toBe("JOIN_PW_12345678");
    expect(disk?.label).toBe("Queued Label");
    expect(disk?.peerNames).toEqual(["Alice", "Bob"]);
  });

  it("clears pendingRemovals on external opt-out so post-reenable sync before deferred remove lock flush keeps fresh room (AO5b)", async () => {
    let now = 1_700_000_000_000;
    const h = makeHarness({ deferredLocks: true, now: () => now });

    h.ctrl.recordJoin({ code: "ABCD2345", password: "INITIAL_PW_12345" });
    await h.flush();

    h.ctrl.remove("ABCD2345");
    const deferredRemoveLock = h.pendingLockReleases.shift();
    expect(deferredRemoveLock).toBeDefined();
    expect(h.ctrl.getRooms()).toEqual([]);

    // Tab A enables opt-out and wipes recent-rooms while Tab B's remove lock is still held
    h.storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
    h.storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
    h.ctrl.syncFromStorage();
    expect(h.ctrl.isDisabled()).toBe(true);
    expect(h.ctrl.getRooms()).toEqual([]);

    // Tab A disables opt-out and joins ABCD2345 with a distinct password
    now += 1000;
    h.storage.removeItem(RECENT_ROOMS_OPT_OUT_KEY);
    upsertRecentRoom(
      h.storage,
      { code: "ABCD2345", role: "guest", password: "FRESH_AFTER_REENABLE", lastJoinedAt: now },
      now,
    );

    // Tab B syncs BEFORE deferredRemoveLock releases
    h.ctrl.syncFromStorage();
    expect(h.ctrl.isDisabled()).toBe(false);
    const memBeforeRelease = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
    expect(memBeforeRelease).toBeDefined();
    expect(memBeforeRelease?.password).toBe("FRESH_AFTER_REENABLE");

    // Now release deferredRemoveLock and flush
    deferredRemoveLock?.();
    await h.flush();

    const mem = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
    const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "ABCD2345");
    expect(mem).toBeDefined();
    expect(mem?.password).toBe("FRESH_AFTER_REENABLE");
    expect(disk).toBeDefined();
    expect(disk?.password).toBe("FRESH_AFTER_REENABLE");
  });

  it("preserves fresh post-reenable room when deferred clearAll lock races with cross-tab external opt-out (BUG-PROBE-ClearAll-DeferredLock-Vs-ExternalOptOut)", async () => {
    let now = 1_700_000_000_000;

    // 1. Exact reproduction: clearAll() queued -> Tab A opts out + wipes -> syncFromStorage() -> clearAllLock runs -> Tab A re-enables + joins -> syncFromStorage()
    // 2. Also variant where Tab A re-enables + joins BEFORE clearAllLock runs and Tab B syncs before & after release
    for (const releaseOrder of ["before-reenable", "after-reenable"] as const) {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "EFGH2345", password: "OLD_SECRET_12345" });
      await h.flush();
      expect(loadRecentRooms(h.storage, now)).toHaveLength(1);

      h.ctrl.clearAll();
      const deferredClearLock = h.pendingLockReleases.shift();
      expect(deferredClearLock).toBeDefined();
      expect(h.ctrl.getRooms()).toEqual([]);

      // Tab A enables opt-out and wipes recent-rooms while Tab B's clearAll lock is held
      h.storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      h.storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.isDisabled()).toBe(true);

      if (releaseOrder === "before-reenable") {
        deferredClearLock?.();
        await h.flush();
      }

      // Tab A disables opt-out and joins ABCD2345
      now += 1000;
      h.storage.removeItem(RECENT_ROOMS_OPT_OUT_KEY);
      upsertRecentRoom(
        h.storage,
        { code: "ABCD2345", role: "guest", password: "FRESH_AFTER_REENABLE", lastJoinedAt: now },
        now,
      );

      h.ctrl.syncFromStorage();
      expect(h.ctrl.isDisabled()).toBe(false);
      if (releaseOrder === "after-reenable") {
        const memBeforeRelease = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
        expect(memBeforeRelease).toBeDefined();
        expect(memBeforeRelease?.password).toBe("FRESH_AFTER_REENABLE");
        deferredClearLock?.();
      }
      await h.flush();

      const mem = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "ABCD2345");
      expect(mem).toBeDefined();
      expect(mem?.password).toBe("FRESH_AFTER_REENABLE");
      expect(disk).toBeDefined();
      expect(disk?.password).toBe("FRESH_AFTER_REENABLE");
    }

    // 3. Variant where Tab A sets opt-out WITHOUT wiping recent-rooms, and clearAllLock either succeeds or hits SecurityError then recovers
    for (const faultOnDeferredClear of [false, true] as const) {
      const inner = makeMemoryStorage();
      let failRemove = false;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => inner.setItem(k, v),
        removeItem: (k) => {
          if (failRemove) throw new Error("SecurityError");
          inner.removeItem(k);
        },
      };
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: async (_name, cb) => {
          await new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
            });
          });
        },
      };
      const flushAll = async () => {
        while (pending.length > 0 || tasks.length > 0) {
          while (pending.length > 0) {
            pending.shift()?.();
            await Promise.resolve();
          }
          if (tasks.length > 0) await Promise.all(tasks.splice(0));
        }
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      ctrl.recordJoin({ code: "EFGH2345", password: "OLD_SECRET_12345" });
      await flushAll();
      expect(loadRecentRooms(inner, now)).toHaveLength(1);

      ctrl.clearAll();
      const deferredClearLock = pending.shift();
      expect(deferredClearLock).toBeDefined();

      // Tab A sets opt-out WITHOUT removing recent-rooms
      inner.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      ctrl.syncFromStorage();
      expect(ctrl.isDisabled()).toBe(true);

      failRemove = faultOnDeferredClear;
      deferredClearLock?.();
      await Promise.all(tasks.splice(0));

      if (faultOnDeferredClear) {
        expect(loadRecentRooms(inner, now)).toHaveLength(1);
        failRemove = false;
        ctrl.syncFromStorage();
        await flushAll();
      }

      // Old room must be wiped before re-enable
      expect(loadRecentRooms(inner, now)).toEqual([]);

      // Tab A re-enables and joins ABCD2345
      now += 1000;
      inner.removeItem(RECENT_ROOMS_OPT_OUT_KEY);
      upsertRecentRoom(
        inner,
        { code: "ABCD2345", role: "guest", password: "FRESH_AFTER_REENABLE", lastJoinedAt: now },
        now,
      );
      ctrl.syncFromStorage();
      await flushAll();

      const mem = ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(inner, now).find((r) => r.code === "ABCD2345");
      expect(mem).toBeDefined();
      expect(mem?.password).toBe("FRESH_AFTER_REENABLE");
      expect(disk).toBeDefined();
      expect(disk?.password).toBe("FRESH_AFTER_REENABLE");
    }

    // 4. Post-opt-out queued join superseded by clearAll() updates writeCutoffGen and stays skipped
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      h.ctrl.syncFromStorage();
      h.storage.removeItem(RECENT_ROOMS_OPT_OUT_KEY);
      h.ctrl.syncFromStorage();

      h.ctrl.recordJoin({ code: "JKMN2345", password: "STALE_PW_1234567" });
      const deferredJoinLock = h.pendingLockReleases.shift();
      expect(deferredJoinLock).toBeDefined();
      h.ctrl.clearAll();
      const deferredClearLock = h.pendingLockReleases.shift();
      expect(deferredClearLock).toBeDefined();

      deferredJoinLock?.();
      await Promise.resolve();
      deferredClearLock?.();
      await h.flush();

      expect(h.ctrl.getRooms()).toEqual([]);
      expect(loadRecentRooms(h.storage, now)).toEqual([]);
    }
  });

  it("handles CodeRabbit final review concurrency, security, and data-integrity fixes (CR #1-#5, #7-#8)", async () => {
    // CR #1: Fresh tab observing external opt-out when recent-rooms is still present does not skip clearAll recovery
    {
      const now = 1_700_000_000_000;
      const inner = makeMemoryStorage();
      upsertRecentRoom(inner, { code: "ABCD2345", role: "guest", password: "OLD_SECRET_12345", lastJoinedAt: now }, now);
      inner.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      let failRemove = true;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => inner.setItem(k, v),
        removeItem: (k) => {
          if (failRemove) throw new Error("SecurityError");
          inner.removeItem(k);
        },
      };
      const tasks: Promise<unknown>[] = [];
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });
      await Promise.all(tasks.splice(0));
      expect(ctrl.isDisabled()).toBe(true);
      expect(inner.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(true);

      // Once storage recovers, syncFromStorage flushes the pending clearAll before any re-enable
      failRemove = false;
      ctrl.syncFromStorage();
      await Promise.all(tasks.splice(0));
      expect(inner.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

      inner.removeItem(RECENT_ROOMS_OPT_OUT_KEY);
      ctrl.syncFromStorage();
      expect(ctrl.isDisabled()).toBe(false);
      expect(ctrl.getRooms()).toEqual([]);
    }

    // CR #3: setDisabled(false) and recovery sync finish pending clearAll before clearing recent-rooms-disabled
    {
      const now = 1_700_000_000_000;
      const inner = makeMemoryStorage();
      let failRemove = false;
      const order: string[] = [];
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => inner.setItem(k, v),
        removeItem: (k) => {
          if (failRemove) throw new Error("SecurityError");
          order.push(k);
          inner.removeItem(k);
        },
      };
      const tasks: Promise<unknown>[] = [];
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      ctrl.recordJoin({ code: "SAFE2345", password: "SECRET_ROOM_1234" });
      await Promise.all(tasks.splice(0));

      failRemove = true;
      ctrl.setDisabled(true);
      await Promise.all(tasks.splice(0));
      expect(inner.store.get(RECENT_ROOMS_OPT_OUT_KEY)).toBe("1");
      expect(inner.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(true);

      // Re-enabling while recent-rooms removal still fails must NOT unset recent-rooms-disabled
      ctrl.setDisabled(false);
      await Promise.all(tasks.splice(0));
      expect(inner.store.get(RECENT_ROOMS_OPT_OUT_KEY)).toBe("1");
      expect(inner.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(true);

      // Once storage recovers, recovery clears recent-rooms BEFORE clearing recent-rooms-disabled
      failRemove = false;
      order.length = 0;
      ctrl.syncFromStorage();
      await Promise.all(tasks.splice(0));
      expect(inner.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
      expect(inner.store.has(RECENT_ROOMS_OPT_OUT_KEY)).toBe(false);
      expect(order).toEqual([RECENT_ROOMS_STORAGE_KEY, RECENT_ROOMS_OPT_OUT_KEY]);
    }

    // CR #2: handleCreatorHostForgotten checks locked disk state and demotes instead of deleting if another tab saved a password
    {
      const now = 1_700_000_000_000;
      const h = makeHarness({ creatorCodes: new Set(["HCST2345"]), deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "HCST2345" });
      await h.flush();

      // Tab B saves a password for HCST2345 before Tab A forgets creator host (and before Tab A syncs)
      upsertRecentRoom(
        h.storage,
        { code: "HCST2345", role: "host", password: "TAB_B_SECRET_123", lastJoinedAt: now },
        now,
      );
      h.creatorCodes.delete("HCST2345");
      h.ctrl.handleCreatorHostForgotten("HCST2345");
      await h.flush();

      const mem = h.ctrl.getRooms().find((r) => r.code === "HCST2345");
      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "HCST2345");
      expect(mem).toBeDefined();
      expect(mem?.role).toBe("guest");
      expect(mem?.password).toBe("TAB_B_SECRET_123");
      expect(disk).toBeDefined();
      expect(disk?.role).toBe("guest");
      expect(disk?.password).toBe("TAB_B_SECRET_123");

      // Also verify recovery path when demote write initially fails with QuotaExceededError
      const inner = makeMemoryStorage();
      let failSet = false;
      const flakey: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          if (failSet) throw new Error("QuotaExceededError");
          inner.setItem(k, v);
        },
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const creatorCodes = new Set(["REC23456"]);
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => flakey,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: (c) => creatorCodes.has(c),
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });
      ctrl.recordJoin({ code: "REC23456" });
      await Promise.all(tasks.splice(0));
      upsertRecentRoom(inner, { code: "REC23456", role: "host", password: "REC_B_SECRET_123", lastJoinedAt: now }, now);
      failSet = true;
      creatorCodes.delete("REC23456");
      ctrl.handleCreatorHostForgotten("REC23456");
      await Promise.all(tasks.splice(0));

      failSet = false;
      ctrl.syncFromStorage();
      await Promise.all(tasks.splice(0));
      const recoveredDisk = loadRecentRooms(inner, now).find((r) => r.code === "REC23456");
      expect(recoveredDisk).toBeDefined();
      expect(recoveredDisk?.role).toBe("guest");
      expect(recoveredDisk?.password).toBe("REC_B_SECRET_123");
    }

    // CR #4: buildMaterializedJoinEntry does not regress lastJoinedAt below a newer persisted timestamp
    {
      const now = 1_700_000_002_000;
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "MNQ23456" });

      upsertRecentRoom(h.storage, { code: "MNQ23456", role: "guest", lastJoinedAt: now + 5_000 }, now + 5_000);
      await h.flush();

      const disk = loadRecentRooms(h.storage, now + 5_000).find((r) => r.code === "MNQ23456");
      expect(disk).toBeDefined();
      expect(disk?.lastJoinedAt).toBe(now + 5_000);
    }

    // CR #5: Lock-time isTimestampValid check prevents persisting expired or future-skewed pendingJoin
    {
      let now = 1_700_000_000_000;
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "EXPJ2345", password: "SECRET_PASS_1234" });
      h.ctrl.recordJoin({ code: "EXPP2345", password: "SECRET_PASS_1234" });
      h.ctrl.rename("EXPP2345", "Too Late");

      now += RECENT_ROOM_TTL_MS;
      // Release EXPP2345 rename lock first so patch materialization hits invalid timestamp check too
      const joinJ = h.pendingLockReleases.shift();
      const joinP = h.pendingLockReleases.shift();
      const patchP = h.pendingLockReleases.shift();
      patchP?.();
      await Promise.resolve();
      joinJ?.();
      joinP?.();
      await h.flush();

      expect(h.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms()).toEqual([]);

      // Backward clock skew > MAX_CLOCK_SKEW_MS also rejects persistJoinOp
      const h2 = makeHarness({ deferredLocks: true, now: () => now });
      h2.ctrl.recordJoin({ code: "SKEW2345", password: "SECRET_PASS_1234" });
      now -= MAX_CLOCK_SKEW_MS + 10_000;
      await h2.flush();
      expect(h2.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
    }

    // CR #7: recordJoin carries forward unpersisted password/peerNames when a patch materializes a second join first
    {
      const now = 1_700_000_000_000;
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "CARR2345", password: "INIT_SECRET_1234", peerNames: ["Alice"] });
      h.ctrl.rename("CARR2345", "Carry Label");
      h.ctrl.recordJoin({ code: "CARR2345" });

      const locks = h.pendingLockReleases.splice(0);
      expect(locks).toHaveLength(3);
      // Release rename lock (index 1) before either join lock
      locks[1]?.();
      await Promise.resolve();
      locks[0]?.();
      locks[2]?.();
      await h.flush();

      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "CARR2345");
      expect(disk).toBeDefined();
      expect(disk?.password).toBe("INIT_SECRET_1234");
      expect(disk?.peerNames).toEqual(["Alice"]);
      expect(disk?.label).toBe("Carry Label");

      // If updatePassword ran between join1 and passwordless join2, join2 must not revert to join1's older password
      const h2 = makeHarness({ deferredLocks: true, now: () => now });
      h2.ctrl.recordJoin({ code: "UPDT2345", password: "OLD_SECRET_12345" });
      h2.ctrl.updatePassword("UPDT2345", "NEW_SECRET_12345", false);
      h2.ctrl.recordJoin({ code: "UPDT2345" });
      await h2.flush();
      const disk2 = loadRecentRooms(h2.storage, now).find((r) => r.code === "UPDT2345");
      expect(disk2).toBeDefined();
      expect(disk2?.password).toBe("NEW_SECRET_12345");
    }

    // CR #8: syncFromStorage does not resurrect removed room's old password/label into a fresh pending join before removal flushes
    {
      const now = 1_700_000_000_000;
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "PURG2345", password: "OLD_SECRET_12345", peerNames: ["OldPeer"] });
      h.ctrl.rename("PURG2345", "Old Label");
      await h.flush();

      h.ctrl.remove("PURG2345");
      h.ctrl.recordJoin({ code: "PURG2345" });
      h.ctrl.syncFromStorage();

      const memBeforeFlush = h.ctrl.getRooms().find((r) => r.code === "PURG2345");
      expect(memBeforeFlush).toBeDefined();
      expect(memBeforeFlush?.password).toBeUndefined();
      expect(memBeforeFlush?.label).toBeUndefined();
      expect(memBeforeFlush?.peerNames).toEqual([]);

      await h.flush();
      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "PURG2345");
      expect(disk).toBeDefined();
      expect(disk?.password).toBeUndefined();
      expect(disk?.label).toBeUndefined();
      expect(disk?.peerNames).toEqual([]);
    }
  });
});
