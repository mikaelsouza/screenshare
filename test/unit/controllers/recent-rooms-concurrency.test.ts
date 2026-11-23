import { describe, expect, it, vi } from "vitest";
import { RecentRoomsController } from "@src/controllers/recent-rooms-controller";
import { SessionController } from "@src/controllers/session-controller";
import { HOST_ROOMS_STORAGE_KEY, readPersistedHostToken, writePersistedHostToken } from "@src/host-tokens";
import { MAX_STORED_RECENT_ROOMS, RECENT_ROOMS_LOCK_NAME, RECENT_ROOMS_OPT_OUT_KEY, RECENT_ROOMS_STORAGE_KEY, RECENT_ROOM_TTL_MS, type LockManagerLike, type StorageLike } from "@src/recent-rooms";
import { createFullMemoryStorage, isRecentRoomsDisabled, loadRecentRooms, makeHarness, makeMemoryStorage, upsertRecentRoom } from "./recent-rooms-harness";

describe("RecentRoomsController — cross-tab concurrency and lock guards", () => {
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

      expect(h.pendingLockReleases).toHaveLength(1);
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
      ctrl.recordJoin({ code: "NEWC2345" });
      ctrl.rename("SYNA2345", "Second");
      expect(pending).toHaveLength(1);

      ctrl.syncFromStorage();
      pending.shift()?.reject(new Error("AbortError"));
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
      ctrl.recordJoin({ code: "BBBB2345" });
      ctrl.recordJoin({ code: "CCCC2345" });
      expect(pending).toHaveLength(1);

      ctrl.syncFromStorage();
      expect(ctrl.getRooms().map((r) => r.code)).toEqual(["CCCC2345", "BBBB2345"]);

      if (rejectLockC) pending.shift()?.reject(new Error("AbortError"));
      else pending.shift()?.resolve();
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

    // 2. Tab A starts disabled, calls setDisabled(false) -> recordJoin(...) under single-flight + cross-tab opt-out race
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
      ctrl.recordJoin({ code: "CCCC2345", password: "NEW_PASS_1234567" });
      expect(pending).toHaveLength(1);
      pending.shift()?.resolve();
      await Promise.all(tasks.splice(0));
      expect(isRecentRoomsDisabled(storage)).toBe(false);
      expect(loadRecentRooms(storage, now).map((r) => r.code)).toEqual(["CCCC2345"]);

      // Tab B sets opt-out after Tab A's enable already flushed; Tab A's next join observes opt-out without overwriting it
      storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      ctrl.recordJoin({ code: "DDDD2345", password: "NEW_PASS_2345678" });
      expect(pending).toHaveLength(1);
      pending.shift()?.resolve();
      await Promise.all(tasks.splice(0));
      expect(isRecentRoomsDisabled(storage)).toBe(true);
      expect(ctrl.isDisabled()).toBe(true);
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

    // 1b. Queued patches under single-flight lock observe external delete, scrub memory, and do not taint subsequent Tab B re-add
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
      ctrl.rename("AAAA2345", "GhostLabel");
      expect(pending).toHaveLength(1);
      const changesBeforeFlush = onChange.mock.calls.length;

      pending.shift()?.resolve();
      await Promise.all(tasks.splice(0));
      expect(onChange.mock.calls.length).toBeGreaterThan(changesBeforeFlush);
      expect(ctrl.getRooms()).toEqual([]);

      // Tab B re-adds AAAA2345 externally; Tab A syncs cleanly with empty peerNames and no GhostLabel
      upsertRecentRoom(storage, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
      ctrl.syncFromStorage();
      expect(loadRecentRooms(storage, now)[0]?.peerNames).toEqual([]);
      expect(ctrl.getRooms()[0]?.peerNames).toEqual([]);
      expect(ctrl.getRooms()[0]?.label).toBeUndefined();
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

    // If clearAll() or setDisabled(true) runs while purge lock is pending, single-flight reuses the pending lock and skips purge
    storage.setItem(
      RECENT_ROOMS_STORAGE_KEY,
      JSON.stringify([{ code: "EXPD2345", role: "guest", lastJoinedAt: now - RECENT_ROOM_TTL_MS }]),
    );
    ctrl.syncFromStorage(false);
    expect(lockCalls).toHaveLength(2);
    ctrl.clearAll();
    ctrl.syncFromStorage(false);
    expect(lockCalls).toHaveLength(2);
    pending.shift()?.();
    await Promise.all(tasks.splice(0));
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

    // If setDisabled(true) runs while purge lock is pending, single-flight reuses the pending lock and skips purge
    storage.setItem(
      RECENT_ROOMS_STORAGE_KEY,
      JSON.stringify([{ code: "EXPD2345", role: "guest", lastJoinedAt: now - RECENT_ROOM_TTL_MS }]),
    );
    ctrl.syncFromStorage(false);
    expect(lockCalls).toHaveLength(3);
    ctrl.setDisabled(true);
    expect(lockCalls).toHaveLength(3);
    pending.shift()?.();
    await Promise.all(tasks.splice(0));
    expect(storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
    expect(isRecentRoomsDisabled(storage)).toBe(true);
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

    // 3. Double pending setDisabled & pendingClearAll edge cases under single-flight queue
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flush();

      // setDisabled(true) -> setDisabled(false) -> mid-flight syncFromStorage keeps isDisabled === false
      h.ctrl.setDisabled(true);
      h.ctrl.setDisabled(false);
      expect(h.pendingLockReleases).toHaveLength(1);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.isDisabled()).toBe(false);
      await h.flush();

      // setDisabled(true) -> setDisabled(false) -> setDisabled(true) -> Tab 2 writes XTAB -> mid-flight syncFromStorage keeps []
      h.ctrl.setDisabled(true);
      h.ctrl.setDisabled(false);
      h.ctrl.setDisabled(true);
      expect(h.pendingLockReleases).toHaveLength(1);
      upsertRecentRoom(h.storage, { code: "XTAB2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms()).toEqual([]);
      await h.flush();

      // clearAll -> recordJoin(BBBB) -> remove(BBBB) while lock is pending -> syncFromStorage keeps BBBB removed
      h.ctrl.setDisabled(false);
      await h.flush();
      h.ctrl.clearAll();
      h.ctrl.recordJoin({ code: "BBBB2345" });
      h.ctrl.remove("BBBB2345");
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms()).toEqual([]);
      await h.flush();

      // remove(A) -> recordJoin(A) -> remove(A) while single-flight lock is pending -> syncFromStorage keeps A absent
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flush();
      h.ctrl.remove("AAAA2345");
      h.ctrl.recordJoin({ code: "AAAA2345" });
      h.ctrl.remove("AAAA2345");
      expect(h.pendingLockReleases).toHaveLength(1);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms()).toEqual([]);
      await h.flush();
      expect(loadRecentRooms(h.storage, now)).toEqual([]);
    }
  });

  it("preserves synthesized host metadata edits across recordJoin (FIFO & reverse) and Tab B concurrent joins (Probes 1B & Reviewer 2)", async () => {
    const now = 1_700_000_000_000;

    // 1. Synthesized host-rooms rename / updatePeers / updatePassword -> recordJoin under single-flight + AbortError fallback
    for (const rejectLock of [false, true]) {
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
      const creatorCodes = new Set(["SYNA2345", "SYNB2345", "SYNC2345"]);
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: (c) => creatorCodes.has(c),
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });
      writePersistedHostToken(storage, "SYNA2345", "tok-a", now - 1000);
      writePersistedHostToken(storage, "SYNB2345", "tok-b", now - 2000);
      writePersistedHostToken(storage, "SYNC2345", "tok-c", now - 3000);
      ctrl.syncFromStorage(false);

      ctrl.rename("SYNA2345", "Work Sync");
      ctrl.recordJoin({ code: "SYNA2345", password: "JOIN_PASS_A_1234" });

      ctrl.updatePeers("SYNB2345", ["Bob"]);
      ctrl.recordJoin({ code: "SYNB2345", password: "JOIN_PASS_B_1234" });

      ctrl.updatePassword("SYNC2345", "PATCH_PASS_C_123", false);
      ctrl.recordJoin({ code: "SYNC2345" });

      expect(pending).toHaveLength(1);
      if (rejectLock) pending.shift()?.reject(new Error("AbortError"));
      else pending.shift()?.resolve();
      await Promise.all(tasks.splice(0));

      const synaMem = ctrl.getRooms().find((r) => r.code === "SYNA2345");
      const synaDisk = loadRecentRooms(storage, now).find((r) => r.code === "SYNA2345");
      expect(synaMem?.label).toBe("Work Sync");
      expect(synaMem?.password).toBe("JOIN_PASS_A_1234");
      expect(synaDisk?.label).toBe("Work Sync");
      expect(synaDisk?.password).toBe("JOIN_PASS_A_1234");

      const synbDisk = loadRecentRooms(storage, now).find((r) => r.code === "SYNB2345");
      expect(synbDisk?.peerNames).toEqual(["Bob"]);
      expect(synbDisk?.password).toBe("JOIN_PASS_B_1234");

      const syncDisk = loadRecentRooms(storage, now).find((r) => r.code === "SYNC2345");
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

    // 1C-v2 & field precedence: recordJoin -> rename / updatePassword / updatePeers -> recordJoin under single-flight + AbortError fallback
    for (const rejectLock of [false, true]) {
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

      ctrl.recordJoin({ code: "ABCD2345", password: "PASS1_1234567890" });
      ctrl.rename("ABCD2345", "Keep My Label");
      ctrl.recordJoin({ code: "ABCD2345", password: "PASS2_1234567890" });
      expect(pending).toHaveLength(1);
      ctrl.syncFromStorage();

      if (rejectLock) pending.shift()?.reject(new Error("AbortError"));
      else pending.shift()?.resolve();
      await Promise.all(tasks.splice(0));

      const mem = ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(storage, now).find((r) => r.code === "ABCD2345");
      expect(mem?.label).toBe("Keep My Label");
      expect(mem?.password).toBe("PASS2_1234567890");
      expect(disk?.label).toBe("Keep My Label");
      expect(disk?.password).toBe("PASS2_1234567890");

      // Newer recordJoin password overrides older updatePassword; omitted peerNames in newer recordJoin retains earlier updatePeers
      ctrl.recordJoin({ code: "EFGH2345", password: "INIT_PASS_123456" });
      ctrl.updatePassword("EFGH2345", "OLD_PATCH_PASS12", false);
      ctrl.updatePeers("EFGH2345", ["Alice"]);
      ctrl.recordJoin({ code: "EFGH2345", password: "NEW_JOIN_PASS123" });
      expect(pending).toHaveLength(1);

      if (rejectLock) pending.shift()?.reject(new Error("AbortError"));
      else pending.shift()?.resolve();
      await Promise.all(tasks.splice(0));

      const efghDisk = loadRecentRooms(storage, now).find((r) => r.code === "EFGH2345");
      expect(efghDisk?.password).toBe("NEW_JOIN_PASS123");
      expect(efghDisk?.peerNames).toEqual(["Alice"]);
    }
  });
});
