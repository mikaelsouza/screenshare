import { describe, expect, it, vi } from "vitest";
import { RecentRoomsController, type RecentRoomsEnvironment } from "@src/controllers/recent-rooms-controller";
import { HOST_ROOMS_STORAGE_KEY, type LockManagerLike, type StorageLike } from "@src/host-tokens";
import { RECENT_ROOMS_OPT_OUT_KEY, RECENT_ROOMS_STORAGE_KEY } from "@src/recent-rooms";

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

function makeControllerSetup(opts?: {
  initialStorage?: Record<string, string>;
  locks?: LockManagerLike | null;
  hostCodes?: Set<string>;
  now?: () => number;
}) {
  const storage = makeMemoryStorage(opts?.initialStorage);
  const hostCodes = opts?.hostCodes ?? new Set<string>();
  const bgTasks: Promise<unknown>[] = [];
  const onRemoveHostToken = vi.fn((code: string) => {
    hostCodes.delete(code);
  });
  const onForgetAllHostTokens = vi.fn(() => {
    hostCodes.clear();
  });
  const onChange = vi.fn();

  const env: RecentRoomsEnvironment = {
    getLocalStorage: () => storage,
    getLocks: () => (opts?.locks === undefined ? null : opts.locks),
    runBackground: vi.fn((p: Promise<unknown>) => {
      bgTasks.push(p);
    }),
    hasSavedCreatorHostFor: (code) => hostCodes.has(code),
    onRemoveHostToken,
    onForgetAllHostTokens,
    onChange,
    ...(opts?.now ? { now: opts.now } : {}),
  };

  const ctrl = new RecentRoomsController(env);
  return {
    ctrl,
    storage,
    hostCodes,
    onRemoveHostToken,
    onForgetAllHostTokens,
    onChange,
    flush: async () => {
      while (bgTasks.length > 0) {
        const pending = bgTasks.splice(0);
        await Promise.all(pending);
      }
    },
  };
}

describe("RecentRoomsController", () => {
  it("records joins, patches password/peers/label, searches, and synthesizes legacy host-rooms", () => {
    let now = 1_700_000_000_000;
    const hostCodes = new Set(["ABCD2345", "EFGH2345"]);
    const s = makeControllerSetup({
      hostCodes,
      now: () => now,
      initialStorage: {
        [HOST_ROOMS_STORAGE_KEY]: JSON.stringify([{ code: "EFGH2345", token: "tok-legacy", updatedAt: now - 5_000 }]),
      },
    });

    // Constructor syncs silently (notify = false) and loads synthesized legacy host room
    expect(s.onChange).not.toHaveBeenCalled();
    expect(s.ctrl.getRooms().map((r) => r.code)).toEqual(["EFGH2345"]);

    // Invalid codes are ignored without notifying
    s.ctrl.recordJoin({ code: "bad" });
    expect(s.ctrl.getRooms()).toHaveLength(1);
    expect(s.onChange).not.toHaveBeenCalled();

    // Join as host and guest, patch password/peers/rename (with whitespace trimming)
    s.ctrl.recordJoin({ code: "  abcd2345  ", password: "  SECRET1234567890  ", peerNames: ["Alice"] });
    now += 1000;
    s.ctrl.recordJoin({ code: "GUST2345", password: "GUEST12345678901" });
    expect(s.ctrl.getRooms().map((r) => [r.code, r.role])).toEqual([
      ["GUST2345", "guest"],
      ["ABCD2345", "host"],
      ["EFGH2345", "host"],
    ]);

    // Password updates respect lock, trim code, and skip identical password
    s.ctrl.updatePassword("GUST2345", "ROTATED_LOCKED12", true);
    expect(s.ctrl.getRooms().find((r) => r.code === "GUST2345")?.password).toBe("GUEST12345678901");
    s.onChange.mockClear();
    s.ctrl.updatePassword("  gust2345  ", "ROTATED_NEW12345", false);
    expect(s.ctrl.getRooms().find((r) => r.code === "GUST2345")?.password).toBe("ROTATED_NEW12345");
    expect(s.onChange).toHaveBeenCalledTimes(1);
    s.ctrl.updatePassword("GUST2345", "ROTATED_NEW12345", false);
    expect(s.onChange).toHaveBeenCalledTimes(1);

    // Peer updates validate code, filter blanks, and detect equal/length/element diffs
    s.ctrl.updatePeers("bad", ["Bob"]);
    s.ctrl.updatePeers("GUST2345", ["  ", ""]);
    s.ctrl.updatePeers("  gust2345  ", ["Bob", "Carol"]);
    expect(s.ctrl.getRooms().find((r) => r.code === "GUST2345")?.peerNames).toEqual(["Bob", "Carol"]);
    expect(s.onChange).toHaveBeenCalledTimes(2);
    s.ctrl.updatePeers("GUST2345", ["Bob", "Carol"]);
    expect(s.onChange).toHaveBeenCalledTimes(2);
    s.ctrl.updatePeers("GUST2345", ["Bob", "Dave"]);
    expect(s.ctrl.getRooms().find((r) => r.code === "GUST2345")?.peerNames).toEqual(["Bob", "Dave"]);
    expect(s.onChange).toHaveBeenCalledTimes(3);
    s.ctrl.updatePeers("GUST2345", ["Bob"]);
    expect(s.onChange).toHaveBeenCalledTimes(4);

    // Search & editing state across 3 rooms (searchQuery preserved when count === 3)
    s.ctrl.setEditingCode("  gust2345  ");
    expect(s.ctrl.getEditingCode()).toBe("GUST2345");
    s.ctrl.setEditingCode("GUST2345");
    expect(s.onChange).toHaveBeenCalledTimes(5);
    s.ctrl.setEditingCode("JKMN2345");
    expect(s.ctrl.getEditingCode()).toBeNull();
    s.ctrl.rename("  gust2345  ", "  Game Night  ");
    expect(s.ctrl.getRooms().find((r) => r.code === "GUST2345")?.label).toBe("Game Night");
    s.ctrl.rename("GUST2345", "   ");
    expect(s.ctrl.getRooms().find((r) => r.code === "GUST2345")?.label).toBeUndefined();
    s.onChange.mockClear();
    s.ctrl.rename("JKMN2345", "Missing");
    expect(s.onChange).toHaveBeenCalledTimes(1);
    s.ctrl.rename("bad", "Invalid");
    expect(s.onChange).toHaveBeenCalledTimes(1);

    s.ctrl.setSearchQuery("bob");
    expect(s.ctrl.getSearchQuery()).toBe("bob");
    s.ctrl.setSearchQuery("bob");
    expect(s.onChange).toHaveBeenCalledTimes(2);
    expect(s.ctrl.getFilteredRooms().map((r) => r.code)).toEqual(["GUST2345"]);

    // With 3 rooms, syncFromStorage keeps searchQuery; removing 3rd clears searchQuery and active editingCode
    s.ctrl.setEditingCode("EFGH2345");
    s.ctrl.syncFromStorage(false);
    expect(s.ctrl.getSearchQuery()).toBe("bob");
    expect(s.ctrl.getEditingCode()).toBe("EFGH2345");

    s.ctrl.remove("  efgh2345  ");
    expect(s.onRemoveHostToken).toHaveBeenCalledWith("EFGH2345");
    expect(s.ctrl.getEditingCode()).toBeNull();
    expect(s.ctrl.getSearchQuery()).toBe("");
    s.ctrl.remove("bad");
  });

  it("handles creator-host forgetting, fatal errors, opt-out, re-enable reload, and clearAll", () => {
    const now = 1_700_000_000_000;
    const hostCodes = new Set(["ABCD2345", "PQRS2345"]);
    const s = makeControllerSetup({ hostCodes, now: () => now });

    s.ctrl.recordJoin({ code: "ABCD2345", password: "PASS_12345678901" });
    s.ctrl.recordJoin({ code: "PQRS2345" });

    // Forgetting creator host demotes passworded room to guest and deletes passwordless room
    s.ctrl.handleCreatorHostForgotten("  abcd2345  ");
    expect(s.ctrl.getRooms().find((r) => r.code === "ABCD2345")?.role).toBe("guest");
    s.ctrl.handleCreatorHostForgotten("PQRS2345");
    expect(s.ctrl.getRooms().find((r) => r.code === "PQRS2345")).toBeUndefined();
    s.ctrl.handleCreatorHostForgotten("ZZZZ2345");
    s.ctrl.handleCreatorHostForgotten("bad");

    // Remove deletes even passworded entries (unlike handleCreatorHostForgotten)
    s.ctrl.recordJoin({ code: "WXYZ2345", password: "PASS_WXYZ_123456" });
    s.ctrl.remove("WXYZ2345");
    expect(s.ctrl.getRooms().find((r) => r.code === "WXYZ2345")).toBeUndefined();

    // Fatal errors remove matching room & pass expectedHostToken only on kicked/bad-password
    expect(s.ctrl.handleFatalError("ABCD2345", "room-locked", "tok-1")).toBe(false);
    expect(s.ctrl.handleFatalError("bad", "kicked")).toBe(false);
    s.ctrl.recordJoin({ code: "EFGH2345", password: "PASS_EFGH_123456" });
    expect(s.ctrl.handleFatalError("  efgh2345  ", "bad-password")).toBe(true);
    expect(s.onRemoveHostToken).not.toHaveBeenCalledWith("EFGH2345", expect.anything());
    expect(s.ctrl.handleFatalError("  abcd2345  ", "kicked", "tok-1")).toBe(true);
    expect(s.onRemoveHostToken).toHaveBeenCalledWith("ABCD2345", "tok-1");
    expect(s.ctrl.getRooms()).toEqual([]);

    // Opt-out clears UI state/search/editing/rooms, wipes storage, forgets tokens, and suppresses writes
    s.ctrl.recordJoin({ code: "AAAA2345", password: "PASS_12345678901" });
    s.ctrl.setSearchQuery("aaaa");
    s.ctrl.setEditingCode("AAAA2345");
    s.onChange.mockClear();
    s.ctrl.setDisabled(true);
    expect(s.onChange).toHaveBeenCalled();
    s.ctrl.setDisabled(true);
    expect(s.ctrl.isDisabled()).toBe(true);
    expect(s.ctrl.getSearchQuery()).toBe("");
    expect(s.ctrl.getEditingCode()).toBeNull();
    expect(s.onForgetAllHostTokens).toHaveBeenCalledTimes(1);
    expect(s.storage.store.get(RECENT_ROOMS_OPT_OUT_KEY)).toBe("1");
    expect(s.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

    s.ctrl.recordJoin({ code: "BBBB2345", password: "PASS_12345678901" });
    s.ctrl.updatePassword("AAAA2345", "NEW_PASS_1234567", false);
    s.ctrl.updatePeers("AAAA2345", ["Eve"]);
    s.ctrl.rename("AAAA2345", "Ignored");
    expect(s.ctrl.getRooms()).toEqual([]);

    // Re-enabling reloads any rooms present on disk (e.g. legacy host-rooms)
    s.hostCodes.add("AAAA2345");
    s.storage.store.set(HOST_ROOMS_STORAGE_KEY, JSON.stringify([{ code: "AAAA2345", token: "t1", updatedAt: now }]));
    s.ctrl.setDisabled(false);
    expect(s.ctrl.isDisabled()).toBe(false);
    expect(s.storage.store.has(RECENT_ROOMS_OPT_OUT_KEY)).toBe(false);
    expect(s.ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345"]);

    // clearAll clears rooms, searchQuery, editingCode, and host tokens
    s.ctrl.setSearchQuery("search");
    s.ctrl.setEditingCode("AAAA2345");
    s.onChange.mockClear();
    s.ctrl.clearAll();
    expect(s.ctrl.getRooms()).toEqual([]);
    expect(s.ctrl.getSearchQuery()).toBe("");
    expect(s.ctrl.getEditingCode()).toBeNull();
    expect(s.onForgetAllHostTokens).toHaveBeenCalledTimes(2);
    expect(s.onChange).toHaveBeenCalled();
    expect(s.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
  });

  it("boots cleanly when already disabled on disk and avoids pruning while opted out", () => {
    const now = 1_700_000_000_000;
    const s = makeControllerSetup({
      now: () => now,
      initialStorage: {
        [RECENT_ROOMS_OPT_OUT_KEY]: "1",
        [RECENT_ROOMS_STORAGE_KEY]: "{corrupt",
      },
    });
    expect(s.ctrl.isDisabled()).toBe(true);
    expect(s.ctrl.getRooms()).toEqual([]);
    // Opt-out prevents background pruning from modifying storage
    expect(s.storage.store.get(RECENT_ROOMS_STORAGE_KEY)).toBe("{corrupt");

    s.onChange.mockClear();
    s.ctrl.syncFromStorage();
    expect(s.onChange).toHaveBeenCalledTimes(1);
    expect(s.ctrl.getRooms()).toEqual([]);
  });

  it("serializes async Web Lock writes FIFO, respects external opt-out, and prunes stale disk entries", async () => {
    const now = 1_700_000_000_000;
    const locks: LockManagerLike = {
      request: async (_name, cb) => {
        await Promise.resolve();
        await cb();
      },
    };
    const s = makeControllerSetup({
      locks,
      now: () => now,
      initialStorage: {
        [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
          { code: "EXPD2345", role: "guest", lastJoinedAt: 1 },
          { code: "KEEP2345", role: "guest", lastJoinedAt: now - 1000 },
        ]),
      },
    });

    // Startup sync detects stale entry and schedules locked prune
    expect(s.ctrl.getRooms().map((r) => r.code)).toEqual(["KEEP2345"]);
    await s.flush();
    expect(JSON.parse(s.storage.store.get(RECENT_ROOMS_STORAGE_KEY) ?? "[]")).toHaveLength(1);

    // Back-to-back join + password patch settle in strict FIFO order under Web Lock
    s.ctrl.recordJoin({ code: "MNPQ2345" });
    s.ctrl.updatePassword("MNPQ2345", "PASS_FIFO_123456", false);
    await s.flush();
    expect(s.ctrl.getRooms().find((r) => r.code === "MNPQ2345")?.password).toBe("PASS_FIFO_123456");

    // External opt-out flag on disk aborts queued patch and join, clears storage, and flips controller disabled
    s.storage.store.set(RECENT_ROOMS_OPT_OUT_KEY, "1");
    s.ctrl.updatePassword("MNPQ2345", "PASS_BLCK_999999", false);
    await s.flush();
    expect(s.ctrl.isDisabled()).toBe(true);
    expect(s.ctrl.getRooms()).toEqual([]);
    expect(s.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

    // Re-enable externally, then test external opt-out during join and during stale prune
    s.storage.store.delete(RECENT_ROOMS_OPT_OUT_KEY);
    s.storage.store.set(
      RECENT_ROOMS_STORAGE_KEY,
      JSON.stringify([{ code: "SYNC2345", role: "guest", lastJoinedAt: now, peerNames: ["Zed"] }]),
    );
    s.ctrl.syncFromStorage();
    expect(s.ctrl.isDisabled()).toBe(false);
    expect(s.ctrl.getRooms().map((r) => r.code)).toEqual(["SYNC2345"]);

    s.storage.store.set(RECENT_ROOMS_OPT_OUT_KEY, "1");
    s.ctrl.recordJoin({ code: "BKMN2345", password: "PASS_BKMN_123456" });
    await s.flush();
    expect(s.ctrl.isDisabled()).toBe(true);
    expect(s.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
  });

  it("tolerates throwing storage reads/writes without corrupting state", () => {
    const throwing: StorageLike = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    const ctrl = new RecentRoomsController({
      getLocalStorage: () => throwing,
      getLocks: () => null,
      runBackground: vi.fn(),
      hasSavedCreatorHostFor: () => false,
      onRemoveHostToken: vi.fn(),
      onForgetAllHostTokens: vi.fn(),
      onChange: vi.fn(),
    });
    expect(ctrl.getRooms()).toEqual([]);
    ctrl.recordJoin({ code: "AAAA2345" });
    ctrl.updatePassword("AAAA2345", "PASS_12345678901", false);
    ctrl.setDisabled(true);
    ctrl.clearAll();
    expect(ctrl.isDisabled()).toBe(true);
    // Throwing read during syncFromStorage preserves in-memory disabled state
    ctrl.syncFromStorage();
    expect(ctrl.isDisabled()).toBe(true);
  });
});
