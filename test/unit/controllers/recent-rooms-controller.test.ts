import { describe, expect, it, vi } from "vitest";
import { RecentRoomsController } from "@src/controllers/recent-rooms-controller";
import { SessionController } from "@src/controllers/session-controller";
import {
  HOST_ROOMS_LOCK_NAME,
  HOST_ROOMS_STORAGE_KEY,
  readPersistedHostToken,
  writePersistedHostToken,
} from "@src/host-tokens";
import {
  MAX_STORED_RECENT_ROOMS,
  RECENT_ROOMS_LOCK_NAME,
  RECENT_ROOMS_OPT_OUT_KEY,
  RECENT_ROOMS_STORAGE_KEY,
  formatRelativeTime,
  isRecentRoomsDisabled,
  loadRecentRooms,
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
      onRemoveHostToken: (code) => session.forgetCreatorHostToken(code),
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
    const h = makeHarness({
      creatorCodes: new Set(["KYCK2345", "BADP2345"]),
      now: () => now,
    });
    writePersistedHostToken(h.storage, "KYCK2345", "tok-kick", now);
    writePersistedHostToken(h.storage, "BADP2345", "tok-badp", now);
    h.ctrl.recordJoin({ code: "KYCK2345", password: "PASS123456789012" });
    h.ctrl.recordJoin({ code: "BADP2345", password: "PASS223456789012" });
    await h.flush();

    expect(h.ctrl.handleFatalError("KYCK2345", "kicked")).toBe(true);
    expect(h.ctrl.handleFatalError("BADP2345", "bad-password")).toBe(true);
    expect(h.onRemoveHostToken).toHaveBeenCalledWith("KYCK2345");
    expect(h.onRemoveHostToken).toHaveBeenCalledWith("BADP2345");

    // Even if host-rooms still had entries until its own lock completes, hasSavedCreatorHostFor + pendingRemovals prevent resurrection
    await h.flush();
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms()).toEqual([]);
    expect(readPersistedHostToken(h.storage, "KYCK2345", now)).toBe("tok-kick"); // mock onRemoveHostToken only updates creatorCodes
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
    expect(h.ctrl.getRooms().find((r) => r.code === "PASS29AA")?.password).toBeUndefined();

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
    expect(loadRecentRooms(h.storage, now).find((r) => r.code === "PASS29AA")?.password).toBeUndefined();

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

      expect(h.ctrl.getRooms()[0]?.label).toBeUndefined();
      expect(loadRecentRooms(h.storage, now)[0]?.label).toBeUndefined();
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms()[0]?.label).toBeUndefined();

      // 5-step -> recordJoin
      h.ctrl.recordJoin({ code: "FIVE2345" });
      now += dt;
      h.ctrl.rename("FIVE2345", "My Room");
      now += dt;
      h.ctrl.recordJoin({ code: "FIVE2345" });
      now += dt;
      h.ctrl.rename("FIVE2345", "");
      now += dt;
      h.ctrl.recordJoin({ code: "FIVE2345" });
      await h.flush();
      expect(h.ctrl.getRooms().find((r) => r.code === "FIVE2345")?.label).toBeUndefined();
      expect(loadRecentRooms(h.storage, now).find((r) => r.code === "FIVE2345")?.label).toBeUndefined();

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
      expect(h.ctrl.getRooms().find((r) => r.code === "PEER2345")?.label).toBeUndefined();
      expect(loadRecentRooms(h.storage, now).find((r) => r.code === "PEER2345")?.label).toBeUndefined();
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
});
