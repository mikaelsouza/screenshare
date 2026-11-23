import { describe, expect, it, vi } from "vitest";
import { RecentRoomsController } from "@src/controllers/recent-rooms-controller";
import { HOST_ROOMS_STORAGE_KEY, readPersistedHostToken, writePersistedHostToken } from "@src/host-tokens";
import { MAX_CLOCK_SKEW_MS, RECENT_ROOMS_OPT_OUT_KEY, RECENT_ROOMS_STORAGE_KEY, RECENT_ROOM_TTL_MS, tryIsRecentRoomsDisabled, writePersistedRecentRooms, type LockManagerLike, type StorageLike } from "@src/recent-rooms";
import { applyRecentRoomOp, computeRecentRoomsView, type RecentRoomsSnapshot } from "@src/recent-rooms-model";
import { isRecentRoomsDisabled, loadRecentRooms, makeHarness, makeMemoryStorage, upsertRecentRoom } from "./recent-rooms-harness";

describe("RecentRoomsController — reducer, re-entrant flush, and edge invariants", () => {
  it("covers pure reducer branches and immutability via applyRecentRoomOp and computeRecentRoomsView", () => {
    const now = 1_700_000_000_000;
    const initial: RecentRoomsSnapshot = {
      entries: [
        { code: "GUES2345", role: "guest", lastJoinedAt: now, peerNames: ["Alice"], password: "SECRET_PASS_1234" },
      ],
      disabled: false,
    };

    // No-op patch returns changed=false without mutating input
    const samePw = applyRecentRoomOp(
      initial,
      { kind: "patch", code: "GUES2345", field: "password", password: "SECRET_PASS_1234" },
      now,
      [],
      () => false,
    );
    expect(samePw.changed).toBe(false);
    expect(samePw.missing).toBe(false);
    expect(samePw.snapshot.entries).not.toBe(initial.entries);

    // remove with demoteIfPassworded=true when already guest returns changed=false
    const demoteGuest = applyRecentRoomOp(
      initial,
      { kind: "remove", code: "GUES2345", demoteIfPassworded: true },
      now,
      [],
      () => false,
    );
    expect(demoteGuest.changed).toBe(false);
    expect(demoteGuest.snapshot.entries[0]?.role).toBe("guest");

    // remove on absent room returns changed=false
    const removeAbsent = applyRecentRoomOp(
      initial,
      { kind: "remove", code: "NONE2345" },
      now,
      [],
      () => false,
    );
    expect(removeAbsent.changed).toBe(false);

    // patch on absent non-synth room returns missing=true
    const missingPatch = applyRecentRoomOp(
      initial,
      { kind: "patch", code: "NONE2345", field: "label", label: "Nope" },
      now,
      [],
      () => false,
    );
    expect(missingPatch.changed).toBe(false);
    expect(missingPatch.missing).toBe(true);

    // disabled snapshot rejects join and patch without changing state
    const disabledSnap: RecentRoomsSnapshot = { entries: [], disabled: true };
    expect(
      applyRecentRoomOp(
        disabledSnap,
        { kind: "join", code: "ABCD2345", role: "guest", lastJoinedAt: now },
        now,
        [],
        () => false,
      ),
    ).toEqual({ snapshot: { entries: [], disabled: true }, changed: false, missing: false });
    expect(
      applyRecentRoomOp(
        disabledSnap,
        { kind: "patch", code: "ABCD2345", field: "label", label: "Nope" },
        now,
        [],
        () => false,
      ),
    ).toEqual({ snapshot: { entries: [], disabled: true }, changed: false, missing: false });

    // clear-all idempotency and set-disabled idempotency
    expect(applyRecentRoomOp(disabledSnap, { kind: "clear-all" }, now, [], () => false).changed).toBe(false);
    expect(applyRecentRoomOp(initial, { kind: "clear-all" }, now, [], () => false).changed).toBe(true);
    expect(applyRecentRoomOp(initial, { kind: "set-disabled", disabled: false }, now, [], () => false).changed).toBe(false);
    expect(applyRecentRoomOp(disabledSnap, { kind: "set-disabled", disabled: true }, now, [], () => false).changed).toBe(false);
    expect(applyRecentRoomOp(initial, { kind: "set-disabled", disabled: true }, now, [], () => false)).toEqual({
      snapshot: { entries: [], disabled: true },
      changed: true,
      missing: false,
    });

    // replayRecentRoomOps folds left-to-right cleanly without mutating initial
    const replayed = computeRecentRoomsView(
      initial,
      [
        { kind: "join", code: "NEWW2345", role: "host", lastJoinedAt: now + 100 },
        { kind: "patch", code: "NEWW2345", field: "label", label: "Host" },
        { kind: "remove", code: "GUES2345" },
      ],
      now + 100,
      [],
      () => false,
    );
    expect(replayed.entries.map((e) => e.code)).toEqual(["NEWW2345"]);
    expect(replayed.entries[0]?.label).toBe("Host");
    expect(initial.entries).toHaveLength(1);

    // computeRecentRoomsView suppresses locally removed host-rooms and returns [] when disabled
    const viewWithRemovedSynth = computeRecentRoomsView(
      { entries: [], disabled: false },
      [{ kind: "remove", code: "SYNA2345" }],
      now,
      [{ code: "SYNA2345", updatedAt: now }],
      (code) => code === "SYNA2345",
    );
    expect(viewWithRemovedSynth.entries).toEqual([]);
    const viewDisabled = computeRecentRoomsView(
      initial,
      [{ kind: "set-disabled", disabled: true }],
      now,
      [{ code: "SYNA2345", updatedAt: now }],
      () => true,
    );
    expect(viewDisabled).toEqual({ entries: [], disabled: true });
  });

  it("re-schedules single-flight flush when onChange enqueues a follow-up op during drainQueueUnderLock (flushRequested)", async () => {
    const now = 1_700_000_000_000;
    const storage = makeMemoryStorage();
    const tasks: Promise<unknown>[] = [];
    const pending: Array<() => void> = [];
    const locks: LockManagerLike = {
      request: (_name, cb) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            void Promise.resolve(cb()).finally(resolve);
          });
        }),
    };
    let triggerFollowUp = false;
    let ctrl!: RecentRoomsController;
    ctrl = new RecentRoomsController({
      getLocalStorage: () => storage,
      getLocks: () => locks,
      runBackground: (t) => {
        tasks.push(t);
      },
      hasSavedCreatorHostFor: () => false,
      onRemoveHostToken: vi.fn(),
      onForgetAllHostTokens: vi.fn(),
      onChange: () => {
        if (triggerFollowUp) {
          triggerFollowUp = false;
          ctrl.rename("BBBB2345", "Follow Up Label");
        }
      },
      now: () => now,
    });

    ctrl.recordJoin({ code: "AAAA2345" });
    ctrl.recordJoin({ code: "BBBB2345" });
    pending.shift()?.();
    await Promise.all(tasks.splice(0));

    // Delete AAAA2345 externally so rename("AAAA2345") triggers reconcile -> onChange -> re-entrant rename("BBBB2345")
    storage.setItem(
      RECENT_ROOMS_STORAGE_KEY,
      JSON.stringify([{ code: "BBBB2345", role: "guest", lastJoinedAt: now, peerNames: [] }]),
    );
    ctrl.rename("AAAA2345", "Ghost");
    triggerFollowUp = true;
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    await Promise.resolve();

    // A 2nd single-flight lock was scheduled by finally because flushRequested === true
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    await Promise.all(tasks.splice(0));

    expect(ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345"]);
    expect(loadRecentRooms(storage, now).find((r) => r.code === "BBBB2345")?.label).toBe("Follow Up Label");
  });

  it("drops transient joins while retaining durable removes on getItem storage fault inside drainQueueUnderLock", async () => {
    const now = 1_700_000_000_000;
    const inner = makeMemoryStorage();
    upsertRecentRoom(inner, { code: "AAAA2345", role: "guest", lastJoinedAt: now }, now);
    let failGet = false;
    const storage: StorageLike = {
      getItem: (k) => {
        if (failGet) throw new Error("SecurityError");
        return inner.getItem(k);
      },
      setItem: (k, v) => inner.setItem(k, v),
      removeItem: (k) => inner.removeItem(k),
    };
    const tasks: Promise<unknown>[] = [];
    const pending: Array<() => void> = [];
    const locks: LockManagerLike = {
      request: (_name, cb) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            void Promise.resolve(cb()).finally(resolve);
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

    ctrl.recordJoin({ code: "BBBB2345" });
    ctrl.remove("AAAA2345");
    expect(pending).toHaveLength(1);

    failGet = true;
    pending.shift()?.();
    await Promise.all(tasks.splice(0));
    // Must not spin-retry when hadStorageError === true
    expect(pending).toHaveLength(0);

    // On recovery syncFromStorage, dropped transient join is gone while durable remove flushes to disk
    failGet = false;
    ctrl.syncFromStorage();
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    await Promise.all(tasks.splice(0));

    expect(loadRecentRooms(inner, now)).toEqual([]);
    expect(ctrl.getRooms()).toEqual([]);
  });

  it("prevents host-room resurrection on remove -> rejected join and remove -> patch (Challenger 1)", async () => {
    let now = 1_700_000_000_000;
    const hostRooms = [{ code: "SYNA2345", updatedAt: now - 5000 }];

    // 1. remove -> expired/skewed join must not resurrect synthesized host room
    const viewAfterRejectedJoin = computeRecentRoomsView(
      { entries: [], disabled: false },
      [
        { kind: "remove", code: "SYNA2345" },
        { kind: "join", code: "SYNA2345", role: "host", lastJoinedAt: now - RECENT_ROOM_TTL_MS },
      ],
      now,
      hostRooms,
      () => true,
    );
    expect(viewAfterRejectedJoin.entries).toEqual([]);

    // 2. remove -> patch and remove -> join -> remove -> patch must not resurrect synthesized host room
    const opsRemovePatch = [
      { kind: "remove" as const, code: "SYNA2345" },
      { kind: "patch" as const, code: "SYNA2345", field: "label" as const, label: "Renamed" },
    ];
    expect(computeRecentRoomsView({ entries: [], disabled: false }, opsRemovePatch, now, hostRooms, () => true).entries).toEqual([]);
    expect(computeRecentRoomsView({ entries: [], disabled: false }, opsRemovePatch, now, hostRooms, () => true).entries).toEqual([]);

    const opsRemoveJoinRemovePatch = [
      { kind: "remove" as const, code: "SYNA2345" },
      { kind: "join" as const, code: "SYNA2345", role: "host" as const, lastJoinedAt: now },
      { kind: "remove" as const, code: "SYNA2345" },
      { kind: "patch" as const, code: "SYNA2345", field: "label" as const, label: "Ghost" },
    ];
    expect(computeRecentRoomsView({ entries: [], disabled: false }, opsRemoveJoinRemovePatch, now, hostRooms, () => true).entries).toEqual([]);

    // 3. Controller end-to-end: kicked host room + backward clock skew on deferred join must not resurrect
    const h = makeHarness({ creatorCodes: new Set(["SYNA2345"]), deferredLocks: true, now: () => now });
    writePersistedHostToken(h.storage, "SYNA2345", "tok-syna", now - 20 * 60 * 1000);
    h.ctrl.syncFromStorage(false);
    expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["SYNA2345"]);

    h.ctrl.handleFatalError("SYNA2345", "kicked", "tok-syna");
    expect(h.ctrl.getRooms()).toEqual([]);

    h.ctrl.recordJoin({ code: "SYNA2345" });
    now -= MAX_CLOCK_SKEW_MS + 5 * 60 * 1000;
    h.ctrl.syncFromStorage();
    expect(h.ctrl.getRooms()).toEqual([]);
    await h.flush();
    expect(h.ctrl.getRooms()).toEqual([]);
  });

  it("handles cross-tab sync, double QuotaExceededError, join2 convergence, getItem faults, and demote reconcile (Probes 3B, 3C, 3D, 4B, 3E, 2C-2)", async () => {
    let now = 1_700_000_000_000;

    const createFaultHarness = (opts: { deferredLocks?: boolean } = {}) => {
      const inner = makeMemoryStorage();
      let failGet = false;
      let failSet = false;
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
      const pending: Array<() => void> = [];
      const locks: LockManagerLike | null = opts.deferredLocks
        ? {
            request: (_name, cb) =>
              new Promise<void>((resolve) => {
                pending.push(() => {
                  void Promise.resolve(cb()).finally(resolve);
                });
              }),
          }
        : null;
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
      const flushAll = async () => {
        while (pending.length > 0 || tasks.length > 0) {
          while (pending.length > 0) {
            pending.shift()?.();
            await Promise.resolve();
          }
          if (tasks.length > 0) await Promise.all(tasks.splice(0));
        }
      };
      return {
        inner,
        ctrl,
        flushAll,
        setFailGet: (v: boolean) => {
          failGet = v;
        },
        setFailSet: (v: boolean) => {
          failSet = v;
        },
      };
    };

    // Probe 3B: syncFromStorage mid-flight must not drop failedJoinCodes needed by queued [patch, join2]
    {
      const h = createFaultHarness({ deferredLocks: true });
      h.setFailSet(true);
      h.ctrl.recordJoin({ code: "ABCD2345", password: "PW1_123456789012" });
      await h.flushAll();

      h.setFailSet(false);
      h.ctrl.rename("ABCD2345", "Important");
      h.ctrl.recordJoin({ code: "ABCD2345", password: "PW2_123456789012" });
      upsertRecentRoom(h.inner, { code: "EFGH2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();
      await h.flushAll();

      expect(h.ctrl.getRooms().find((r) => r.code === "ABCD2345")?.label).toBe("Important");
      expect(loadRecentRooms(h.inner, now).find((r) => r.code === "ABCD2345")?.label).toBe("Important");
      expect(h.ctrl.getRooms().some((r) => r.code === "EFGH2345")).toBe(true);
    }

    // Probe 3C: second QuotaExceededError on join2 must drop carried patches without mem/disk split-brain
    {
      const h = createFaultHarness({ deferredLocks: true });
      h.setFailSet(true);
      h.ctrl.recordJoin({ code: "ABCD2345", password: "PW1_123456789012" });
      await h.flushAll();

      h.ctrl.rename("ABCD2345", "Important");
      h.ctrl.recordJoin({ code: "ABCD2345", password: "PW2_123456789012" });
      await h.flushAll();

      h.setFailSet(false);
      h.ctrl.recordJoin({ code: "ABCD2345", password: "PW3_123456789012" });
      await h.flushAll();

      const mem = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(h.inner, now).find((r) => r.code === "ABCD2345");
      expect(mem).toEqual(disk);
      expect(mem?.label).toBeUndefined();
      expect(mem?.password).toBe("PW3_123456789012");
    }

    // Probe 3D & 3D-second-order: join2 without failed join1 fields converges mem to disk and allows subsequent updates
    {
      const h = createFaultHarness();
      h.setFailSet(true);
      h.ctrl.recordJoin({ code: "ABCD2345", password: "PW1_123456789012", peerNames: ["Alice"] });
      await h.flushAll();

      h.setFailSet(false);
      h.ctrl.recordJoin({ code: "ABCD2345" });
      await h.flushAll();

      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.inner, now));
      expect(h.ctrl.getRooms()[0]?.password).toBeUndefined();
      expect(h.ctrl.getRooms()[0]?.peerNames).toEqual([]);

      h.ctrl.updatePassword("ABCD2345", "PW1_123456789012", false);
      h.ctrl.updatePeers("ABCD2345", ["Alice"]);
      await h.flushAll();
      const disk = loadRecentRooms(h.inner, now).find((r) => r.code === "ABCD2345");
      expect(disk?.password).toBe("PW1_123456789012");
      expect(disk?.peerNames).toEqual(["Alice"]);
    }

    // Probe 4B: failed join on existing or absent room without join2/syncFromStorage must match disk
    {
      const h = createFaultHarness();
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flushAll();
      const ts1 = now;

      now += 5;
      h.setFailSet(true);
      h.ctrl.recordJoin({ code: "AAAA2345" });
      h.ctrl.recordJoin({ code: "NEWR2345" });
      await h.flushAll();
      h.setFailSet(false);

      expect(h.ctrl.getRooms()).toEqual(loadRecentRooms(h.inner, now));
      expect(h.ctrl.getRooms()[0]?.lastJoinedAt).toBe(ts1);
    }

    // Probe 3E: getItem SecurityError drops failed patch without leaving ghost label from this.rooms fallback
    {
      const h = createFaultHarness({ deferredLocks: true });
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flushAll();

      h.setFailGet(true);
      h.ctrl.rename("AAAA2345", "GhostLabelDuringGetError");
      await h.flushAll();

      expect(h.ctrl.getRooms().find((r) => r.code === "AAAA2345")?.label).toBeUndefined();
    }

    // Probe 2C-2 & symmetric demote: handleCreatorHostForgotten reconciles when Tab B deleted or added password
    {
      const h = createFaultHarness({ deferredLocks: true });
      h.ctrl.recordJoin({ code: "AAAA2345", password: "PW_A_12345678901" });
      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flushAll();

      h.ctrl.handleCreatorHostForgotten("AAAA2345");
      h.ctrl.handleCreatorHostForgotten("BBBB2345");
      // Tab B deletes AAAA2345 and adds a password to BBBB2345 before Tab A's lock executes
      const rest = loadRecentRooms(h.inner, now).filter((r) => r.code !== "AAAA2345");
      writePersistedRecentRooms(
        h.inner,
        rest.map((r) => (r.code === "BBBB2345" ? { ...r, password: "TABB_PW_12345678" } : r)),
      );
      await h.flushAll();

      expect(h.ctrl.getRooms()).toEqual([
        expect.objectContaining({ code: "BBBB2345", role: "guest", password: "TABB_PW_12345678" }),
      ]);
    }
  });

  it("preserves opt-out disabled state during getItem SecurityError in syncFromStorage (Probe 5B)", async () => {
    const now = 1_700_000_000_000;
    const createFaultHarness = () => {
      const inner = makeMemoryStorage();
      let failGet = false;
      let failRemove = false;
      const storage: StorageLike = {
        getItem: (k) => {
          if (failGet) throw new Error("SecurityError");
          return inner.getItem(k);
        },
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
      return {
        inner,
        storage,
        ctrl,
        flushAll: () => Promise.all(tasks.splice(0)).then(() => undefined),
        setFailGet: (v: boolean) => {
          failGet = v;
        },
        setFailRemove: (v: boolean) => {
          failRemove = v;
        },
      };
    };

    expect(tryIsRecentRoomsDisabled(null)).toEqual({ ok: false, disabled: false });

    // Variant 1: clear-all succeeded, then getItem throws SecurityError during syncFromStorage
    {
      const h = createFaultHarness();
      expect(tryIsRecentRoomsDisabled(h.storage)).toEqual({ ok: true, disabled: false });
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flushAll();

      h.ctrl.setDisabled(true);
      await h.flushAll();
      expect(tryIsRecentRoomsDisabled(h.storage)).toEqual({ ok: true, disabled: true });

      h.setFailGet(true);
      expect(tryIsRecentRoomsDisabled(h.storage)).toEqual({ ok: false, disabled: false });
      h.ctrl.syncFromStorage();
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(h.ctrl.getRooms()).toEqual([]);

      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flushAll();
      expect(h.ctrl.getRooms()).toEqual([]);

      h.setFailGet(false);
      h.ctrl.syncFromStorage();
      await h.flushAll();
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(loadRecentRooms(h.inner, now)).toEqual([]);
    }

    // Variant 2: set-disabled succeeded while clear-all failed removeItem, then getItem throws SecurityError
    {
      const h = createFaultHarness();
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flushAll();

      h.setFailRemove(true);
      h.ctrl.setDisabled(true);
      await h.flushAll();
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(loadRecentRooms(h.inner, now).map((r) => r.code)).toEqual(["AAAA2345"]);

      h.setFailGet(true);
      h.ctrl.syncFromStorage();
      await h.flushAll();
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(h.ctrl.getRooms()).toEqual([]);

      h.setFailGet(false);
      h.setFailRemove(false);
      h.ctrl.syncFromStorage();
      await h.flushAll();
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(loadRecentRooms(h.inner, now)).toEqual([]);
    }
  });

  it("scopes failedJoinCodes pruning on storage error to affected room codes only (Probes 5C, 5C-2)", async () => {
    const now = 1_700_000_000_000;
    const createSetFaultHarness = () => {
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
        request: (_name, cb) =>
          new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
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
      const flushAll = async () => {
        while (pending.length > 0 || tasks.length > 0) {
          while (pending.length > 0) {
            pending.shift()?.();
            await Promise.resolve();
          }
          if (tasks.length > 0) await Promise.all(tasks.splice(0));
        }
      };
      return {
        inner,
        ctrl,
        flushAll,
        setFailSet: (v: boolean) => {
          failSet = v;
        },
      };
    };

    // Probe 5C: carried patch drop on AAAA2345 must not wipe failedJoinCodes for unrelated BBBB2345 (separate flushes)
    {
      const h = createSetFaultHarness();
      h.setFailSet(true);
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flushAll();
      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flushAll();

      h.ctrl.rename("AAAA2345", "LabelA");
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flushAll();

      h.setFailSet(false);
      h.ctrl.rename("BBBB2345", "LabelB");
      h.ctrl.recordJoin({ code: "BBBB2345" });
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flushAll();

      expect(h.ctrl.getRooms().find((r) => r.code === "BBBB2345")?.label).toBe("LabelB");
      expect(loadRecentRooms(h.inner, now).find((r) => r.code === "BBBB2345")?.label).toBe("LabelB");
      expect(h.ctrl.getRooms().find((r) => r.code === "AAAA2345")?.label).toBeUndefined();
      expect(loadRecentRooms(h.inner, now).find((r) => r.code === "AAAA2345")?.label).toBeUndefined();
    }

    // Probe 5C (same-batch failed joins): dropped join for BBBB2345 behind failing AAAA2345 also keeps recovery
    {
      const h = createSetFaultHarness();
      h.setFailSet(true);
      h.ctrl.recordJoin({ code: "AAAA2345" });
      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flushAll();

      h.ctrl.rename("AAAA2345", "LabelA");
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flushAll();

      h.setFailSet(false);
      h.ctrl.rename("BBBB2345", "LabelB");
      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flushAll();

      expect(h.ctrl.getRooms().find((r) => r.code === "BBBB2345")?.label).toBe("LabelB");
      expect(loadRecentRooms(h.inner, now).find((r) => r.code === "BBBB2345")?.label).toBe("LabelB");
    }

    // Probe 5C-2: failed patch on persisted AAAA2345 must not wipe failedJoinCodes for unrelated BBBB2345
    {
      const h = createSetFaultHarness();
      h.ctrl.recordJoin({ code: "AAAA2345" });
      await h.flushAll();

      h.setFailSet(true);
      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flushAll();

      h.ctrl.rename("AAAA2345", "LabelA");
      await h.flushAll();

      h.setFailSet(false);
      h.ctrl.rename("BBBB2345", "LabelB");
      h.ctrl.recordJoin({ code: "BBBB2345" });
      await h.flushAll();

      expect(h.ctrl.getRooms().find((r) => r.code === "BBBB2345")?.label).toBe("LabelB");
      expect(loadRecentRooms(h.inner, now).find((r) => r.code === "BBBB2345")?.label).toBe("LabelB");
      expect(loadRecentRooms(h.inner, now).find((r) => r.code === "AAAA2345")?.label).toBeUndefined();
    }
  });

  it("reconciles remove ops when host-rooms retains a valid creator entry (Probes 6E, 6F)", async () => {
    const now = 1_700_000_000_000;

    // Probe 6F (host-rooms only + recent-rooms + host-rooms): handleFatalError without matching expectedHostToken
    for (const seedRecent of [false, true]) {
      const inner = makeMemoryStorage();
      let failHostGet = false;
      const storage: StorageLike = {
        getItem: (k) => {
          if (failHostGet && k === HOST_ROOMS_STORAGE_KEY) throw new Error("SecurityError");
          return inner.getItem(k);
        },
        setItem: (k, v) => inner.setItem(k, v),
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: (code) => readPersistedHostToken(storage, code, now) !== undefined,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      writePersistedHostToken(inner, "AAAA2345", "creator-tok", now);
      if (seedRecent) {
        upsertRecentRoom(inner, { code: "AAAA2345", role: "host", lastJoinedAt: now }, now);
      }
      ctrl.syncFromStorage(false);
      await Promise.all(tasks.splice(0));
      expect(ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345"]);

      // Mismatched or undefined expectedHostToken leaves creator token in host-rooms
      expect(ctrl.handleFatalError("AAAA2345", "kicked", seedRecent ? "stale-tok" : undefined)).toBe(true);
      await Promise.all(tasks.splice(0));

      const afterDrain = ctrl.getRooms().map((r) => ({ code: r.code, role: r.role }));
      ctrl.syncFromStorage(false);
      const afterSync = ctrl.getRooms().map((r) => ({ code: r.code, role: r.role }));
      expect(afterDrain).toEqual([{ code: "AAAA2345", role: "host" }]);
      expect(afterDrain).toEqual(afterSync);

      // SecurityError on host-rooms must not crash remove drain and falls back cleanly
      failHostGet = true;
      ctrl.handleFatalError("AAAA2345", "kicked");
      await Promise.all(tasks.splice(0));
      expect(ctrl.getRooms()).toEqual([]);

      failHostGet = false;
      ctrl.syncFromStorage(false);
      expect(ctrl.getRooms().map((r) => r.code)).toEqual(["AAAA2345"]);
    }

    // Probe 6E: Cross-tab race where Tab A queues remove(code), Tab B writes creator host token and Tab A syncs before lock drains
    {
      const storage = makeMemoryStorage();
      const tasksA: Promise<unknown>[] = [];
      const pendingA: Array<() => void> = [];
      const locksA: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve) => {
            pendingA.push(() => {
              void Promise.resolve(cb()).finally(resolve);
            });
          }),
      };
      const tasksB: Promise<unknown>[] = [];
      const makeEnv = (locks: LockManagerLike | null, tasks: Promise<unknown>[]) => ({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t: Promise<unknown>) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: (code: string) => readPersistedHostToken(storage, code, now) !== undefined,
        onRemoveHostToken: (code: string, onlyIfMatching?: string) => {
          if (onlyIfMatching === undefined) {
            writePersistedHostToken(storage, code, undefined, now);
          }
        },
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });

      upsertRecentRoom(storage, { code: "AAAA2345", role: "host", lastJoinedAt: now }, now);
      writePersistedHostToken(storage, "AAAA2345", "tok-init", now);
      const tabA = new RecentRoomsController(makeEnv(locksA, tasksA));
      const tabB = new RecentRoomsController(makeEnv(null, tasksB));
      expect(tabA.getRooms().map((r) => r.code)).toEqual(["AAAA2345"]);

      tabB.remove("AAAA2345");
      await Promise.all(tasksB.splice(0));
      expect(tabB.getRooms()).toEqual([]);

      tabA.remove("AAAA2345");
      expect(tabA.getRooms()).toEqual([]);

      // Tab B writes creator host token and both tabs sync before Tab A's lock drains
      writePersistedHostToken(storage, "AAAA2345", "tok-new", now);
      tabB.syncFromStorage();
      tabA.syncFromStorage();
      expect(tabB.getRooms().map((r) => r.code)).toEqual(["AAAA2345"]);
      expect(tabA.getRooms()).toEqual([]);

      // Drain Tab A's queued remove(AAAA2345): must reconcile and converge to Tab B
      while (pendingA.length > 0 || tasksA.length > 0) {
        while (pendingA.length > 0) {
          pendingA.shift()?.();
          await Promise.resolve();
        }
        if (tasksA.length > 0) await Promise.all(tasksA.splice(0));
      }

      expect(tabA.getRooms().map((r) => ({ code: r.code, role: r.role }))).toEqual(
        tabB.getRooms().map((r) => ({ code: r.code, role: r.role })),
      );
      expect(tabA.getRooms().map((r) => r.code)).toEqual(["AAAA2345"]);
    }

    // Edge cases: demoteIfPassworded with concurrent host-rooms re-add, and expired host-rooms entry does not reconcile
    {
      const storage = makeMemoryStorage();
      let currentNow = now;
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
            });
          }),
      };
      const ctrl = new RecentRoomsController({
        getLocalStorage: () => storage,
        getLocks: () => locks,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: (code) => readPersistedHostToken(storage, code, currentNow) !== undefined,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => currentNow,
      });

      writePersistedHostToken(storage, "BBBB2345", "tok-b", currentNow);
      ctrl.syncFromStorage(false);
      expect(ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345"]);

      // Creator host forgotten queues demoteIfPassworded remove; concurrent Tab B re-adds host-rooms before drain
      writePersistedHostToken(storage, "BBBB2345", undefined, currentNow);
      ctrl.handleCreatorHostForgotten("BBBB2345");
      expect(ctrl.getRooms()).toEqual([]);

      writePersistedHostToken(storage, "BBBB2345", "tok-readded", currentNow);
      while (pending.length > 0 || tasks.length > 0) {
        while (pending.length > 0) {
          pending.shift()?.();
          await Promise.resolve();
        }
        if (tasks.length > 0) await Promise.all(tasks.splice(0));
      }
      expect(ctrl.getRooms().map((r) => r.code)).toEqual(["BBBB2345"]);

      // Expired host-rooms entry is ignored on remove drain
      currentNow = now + RECENT_ROOM_TTL_MS + 1000;
      ctrl.remove("BBBB2345");
      while (pending.length > 0 || tasks.length > 0) {
        while (pending.length > 0) {
          pending.shift()?.();
          await Promise.resolve();
        }
        if (tasks.length > 0) await Promise.all(tasks.splice(0));
      }
      expect(ctrl.getRooms()).toEqual([]);
    }
  });

  it("handles carried patch precedence, targeted storage failures, external opt-out variants, re-entrant flush, and stale purge", async () => {
    const now = 1_700_000_000_000;

    // 1. Carried patch precedence on join2: join2 password & non-empty peerNames override carried patches, while label carries;
    //    join2 with empty peerNames allows carried peerNames patch to apply.
    {
      const inner = makeMemoryStorage();
      let failRecentSet = true;
      let failRecentGet = false;
      const storage: StorageLike = {
        getItem: (k) => {
          if (failRecentGet && k === RECENT_ROOMS_STORAGE_KEY) throw new Error("SecurityError");
          return inner.getItem(k);
        },
        setItem: (k, v) => {
          if (failRecentSet && k === RECENT_ROOMS_STORAGE_KEY) throw new Error("QuotaExceededError");
          inner.setItem(k, v);
        },
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
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
      const flushAll = async () => {
        while (pending.length > 0 || tasks.length > 0) {
          while (pending.length > 0) {
            pending.shift()?.();
            await Promise.resolve();
          }
          if (tasks.length > 0) await Promise.all(tasks.splice(0));
        }
      };

      expect(ctrl.isDisabled()).toBe(false);
      expect(ctrl.getRooms()).toEqual([]);

      ctrl.recordJoin({ code: "AAAA2345", password: "PW1_123456789012" });
      await flushAll();
      ctrl.recordJoin({ code: "BBBB2345", password: "PWB1_12345678901" });
      await flushAll();

      failRecentSet = false;
      ctrl.updatePassword("AAAA2345", "PW_PATCH_1234567", false);
      ctrl.updatePeers("AAAA2345", ["PatchPeer"]);
      ctrl.rename("AAAA2345", "CarriedLabel");
      ctrl.recordJoin({ code: "AAAA2345", password: "PW_JOIN2_1234567", peerNames: ["Join2Peer"] });

      ctrl.updatePeers("BBBB2345", ["CarriedB"]);
      ctrl.recordJoin({ code: "BBBB2345", peerNames: [] });
      await flushAll();

      const diskA = loadRecentRooms(inner, now).find((r) => r.code === "AAAA2345");
      expect(diskA?.password).toBe("PW_JOIN2_1234567");
      expect(diskA?.peerNames).toEqual(["Join2Peer"]);
      expect(diskA?.label).toBe("CarriedLabel");

      const diskB = loadRecentRooms(inner, now).find((r) => r.code === "BBBB2345");
      expect(diskB?.peerNames).toEqual(["CarriedB"]);

      // 2. getItem throwing ONLY on RECENT_ROOMS_STORAGE_KEY hits !loaded.ok in persistEntryOp without dropping durable ops
      failRecentGet = true;
      ctrl.rename("AAAA2345", "ShouldFailRead");
      await flushAll();
      failRecentGet = false;
      expect(loadRecentRooms(inner, now).find((r) => r.code === "AAAA2345")?.label).toBe("CarriedLabel");
    }

    // 3. Durable op storage failures (setDisabled & clearAll) + clearing failedJoinCodes on setDisabled(true) & clearAll()
    {
      const inner = makeMemoryStorage();
      let failOptSet = false;
      let failRecentSet = false;
      let failRemove = false;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          if (failOptSet && k === RECENT_ROOMS_OPT_OUT_KEY) throw new Error("Quota");
          if (failRecentSet && k === RECENT_ROOMS_STORAGE_KEY) throw new Error("Quota");
          inner.setItem(k, v);
        },
        removeItem: (k) => {
          if (failRemove) throw new Error("Denied");
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
      const flushAll = () => Promise.all(tasks.splice(0)).then(() => undefined);

      // Failed join then setDisabled(true) when opt-out write fails -> durable ops remain queued and flush on recovery
      failRecentSet = true;
      ctrl.recordJoin({ code: "FA234567" });
      await flushAll();
      failRecentSet = false;

      failOptSet = true;
      ctrl.setDisabled(true);
      await flushAll();
      expect(isRecentRoomsDisabled(inner)).toBe(false);

      failOptSet = false;
      ctrl.syncFromStorage();
      await flushAll();
      expect(isRecentRoomsDisabled(inner)).toBe(true);

      // Re-enable and confirm failedJoinCodes for FA234567 was cleared by setDisabled(true)
      ctrl.setDisabled(false);
      await flushAll();
      ctrl.updatePassword("FA234567", "SHOULD_NOT_APPLY", false);
      await flushAll();
      expect(loadRecentRooms(inner, now)).toEqual([]);

      // clearAll failure on removeItem preserves clear-all op in queue and succeeds when recovered;
      // duplicate clearAll() keeps only one trailing clear-all and retains set-disabled op
      ctrl.recordJoin({ code: "KEEP2345" });
      await flushAll();
      failRemove = true;
      ctrl.clearAll();
      ctrl.clearAll();
      await flushAll();
      expect(loadRecentRooms(inner, now).map((r) => r.code)).toEqual(["KEEP2345"]);

      failRemove = false;
      ctrl.syncFromStorage();
      await flushAll();
      expect(loadRecentRooms(inner, now)).toEqual([]);
    }

    // 4. applyExternalOptOut when RECENT_ROOMS_STORAGE_KEY is already absent vs present
    {
      const h = makeHarness({ deferredLocks: true, now: () => now });
      h.ctrl.recordJoin({ code: "AAAA2345" });
      // External tab sets opt-out and has no recent-rooms key at all
      h.storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      await h.flush();
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(h.ctrl.getRooms()).toEqual([]);
      expect(h.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

      // Reset, seed storage, queue join + clear-all while external opt-out arrives -> keeps clear-all and removes key
      h.ctrl.setDisabled(false);
      await h.flush();
      upsertRecentRoom(h.storage, { code: "BBBB2345", role: "guest", lastJoinedAt: now }, now);
      h.ctrl.syncFromStorage();
      h.ctrl.recordJoin({ code: "CCCC2345" });
      h.storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      await h.flush();
      expect(h.ctrl.isDisabled()).toBe(true);
      expect(h.storage.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);
    }

    // 5. maybeScheduleExpiredPurge + runPendingPurge + re-entrant flushRequested during drain
    {
      const inner = makeMemoryStorage({
        [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
          { code: "EXPD2345", role: "guest", lastJoinedAt: now - RECENT_ROOM_TTL_MS },
          { code: "K7M9P2QR", role: "guest", lastJoinedAt: now - 1000 },
        ]),
      });
      const tasks: Promise<unknown>[] = [];
      let triggerReentrantOnChange = false;
      let ctrlRef: RecentRoomsController | null = null;
      ctrlRef = new RecentRoomsController({
        getLocalStorage: () => inner,
        getLocks: () => null,
        runBackground: (t) => {
          tasks.push(t);
        },
        hasSavedCreatorHostFor: () => false,
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: () => {
          if (triggerReentrantOnChange) {
            triggerReentrantOnChange = false;
            ctrlRef?.recordJoin({ code: "REEN2345" });
          }
        },
        now: () => now,
      });
      await Promise.all(tasks.splice(0));
      const rawAfterPurge = JSON.parse(inner.store.get(RECENT_ROOMS_STORAGE_KEY) ?? "[]") as Array<{ code: string }>;
      expect(rawAfterPurge.map((r) => r.code)).toEqual(["K7M9P2QR"]);

      // Re-entrant enqueue triggered during drainQueueUnderLock (via onChange on reconcile) reschedules and flushes
      ctrlRef.updatePassword("UNKN2345", "NOT_USED_1234567", false); // no-op
      upsertRecentRoom(inner, { code: "XTAB2345", role: "guest", lastJoinedAt: now }, now);
      ctrlRef.syncFromStorage(false);
      ctrlRef.setEditingCode("K7M9P2QR");
      expect(ctrlRef.getEditingCode()).toBe("K7M9P2QR");
      ctrlRef.remove("K7M9P2QR");
      expect(ctrlRef.getEditingCode()).toBeNull();
      await Promise.all(tasks.splice(0));

      // Trigger reconcile path via missing patch (tab B removed XTAB2345 before tab A's rename ran)
      inner.removeItem(RECENT_ROOMS_STORAGE_KEY);
      triggerReentrantOnChange = true;
      ctrlRef.rename("XTAB2345", "TriggersReconcile");
      while (tasks.length > 0) {
        await Promise.all(tasks.splice(0));
      }
      expect(loadRecentRooms(inner, now).map((r) => r.code)).toEqual(["REEN2345"]);
    }

    // 6. shouldReconcileRemove with multiple hostRooms + UI/validation guards
    {
      const h = makeHarness({
        creatorCodes: new Set(["H2345678"]),
        now: () => now,
      });
      writePersistedHostToken(h.storage, "M2345678", "tok-other", now);
      writePersistedHostToken(h.storage, "H2345678", "tok-host", now);
      h.ctrl.syncFromStorage(false);

      // Remove M2345678 (not in creatorCodes, though M2345678 is in host-rooms) -> stays removed without resurrecting
      h.ctrl.remove("M2345678");
      await h.flush();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["H2345678"]);

      // Guard checks: invalid codes, blank peers, same editingCode / searchQuery, rename unknown clears editingCode & calls onChange
      const beforeCalls = h.onChange.mock.calls.length;
      h.ctrl.setSearchQuery("");
      h.ctrl.setEditingCode("BAD");
      h.ctrl.setEditingCode(null);
      h.ctrl.updatePassword("BAD", "PASS123456789012", false);
      h.ctrl.updatePeers("BAD", ["Alice"]);
      h.ctrl.updatePeers("H2345678", ["   "]);
      h.ctrl.updatePeers("UNKN2345", ["Alice"]);
      h.ctrl.remove("BAD");
      expect(h.onChange).toHaveBeenCalledTimes(beforeCalls);

      h.ctrl.setEditingCode("H2345678");
      h.ctrl.setEditingCode("H2345678");
      expect(h.ctrl.getEditingCode()).toBe("H2345678");
      h.ctrl.rename("UNKN2345", "Unknown");
      expect(h.ctrl.getEditingCode()).toBeNull();
      expect(h.onChange).toHaveBeenCalledTimes(beforeCalls + 2);
    }
  });

  it("kills subtle controller mutants: syncFromStorage failedJoinCodes pruning, clearAll/externalOptOut dedup, purge-vs-error, and property presence", async () => {
    const now = 1_700_000_000_000;

    // 1. syncFromStorage prunes failedJoinCodes only when neither patch nor join for that code is in queue
    {
      const inner = makeMemoryStorage();
      let failSet = true;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          if (failSet) throw new Error("Quota");
          inner.setItem(k, v);
        },
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
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
      const flushAll = async () => {
        while (pending.length > 0 || tasks.length > 0) {
          while (pending.length > 0) {
            pending.shift()?.();
            await Promise.resolve();
          }
          if (tasks.length > 0) await Promise.all(tasks.splice(0));
        }
      };

      // Fail joins for AAAA2345, BBBB2345, CCCC2345
      ctrl.recordJoin({ code: "AAAA2345" });
      await flushAll();
      ctrl.recordJoin({ code: "BBBB2345" });
      await flushAll();
      ctrl.recordJoin({ code: "CCCC2345" });
      await flushAll();

      // Queue patch for AAAA2345, join for BBBB2345, remove for CCCC2345; then syncFromStorage before lock runs
      failSet = false;
      ctrl.rename("AAAA2345", "KeepFailedPatch");
      ctrl.recordJoin({ code: "BBBB2345" });
      ctrl.remove("CCCC2345");
      ctrl.syncFromStorage();
      // AAAA2345 still has queued patch -> adding join2 for AAAA2345 must carry KeepFailedPatch!
      ctrl.recordJoin({ code: "AAAA2345" });
      await flushAll();
      expect(loadRecentRooms(inner, now).find((r) => r.code === "AAAA2345")?.label).toBe("KeepFailedPatch");

      // Fail DDDD2345, syncFromStorage with empty queue -> failedJoinCodes for DDDD2345 is pruned so updatePassword is a no-op
      failSet = true;
      ctrl.recordJoin({ code: "DDDD2345" });
      await flushAll();
      failSet = false;
      ctrl.syncFromStorage();
      const callsBefore = onChange.mock.calls.length;
      ctrl.updatePassword("DDDD2345", "SHOULD_BE_NOOP_123", false);
      expect(onChange).toHaveBeenCalledTimes(callsBefore);
    }

    // 2. clearAll() dedup, set-disabled retention in queue, and external opt-out removeItem call counts
    {
      const inner = makeMemoryStorage();
      const removeCalls: string[] = [];
      const setCalls: string[] = [];
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          setCalls.push(k);
          inner.setItem(k, v);
        },
        removeItem: (k) => {
          removeCalls.push(k);
          inner.removeItem(k);
        },
      };
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
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
      const flushAll = async () => {
        while (pending.length > 0 || tasks.length > 0) {
          while (pending.length > 0) {
            pending.shift()?.();
            await Promise.resolve();
          }
          if (tasks.length > 0) await Promise.all(tasks.splice(0));
        }
      };

      ctrl.setDisabled(true);
      await flushAll();
      removeCalls.length = 0;
      setCalls.length = 0;

      // Queue setDisabled(false) -> recordJoin -> clearAll -> clearAll under single lock
      ctrl.setDisabled(false);
      ctrl.recordJoin({ code: "AAAA2345" });
      ctrl.clearAll();
      ctrl.clearAll();
      await flushAll();
      expect(removeCalls).toEqual([RECENT_ROOMS_OPT_OUT_KEY, RECENT_ROOMS_STORAGE_KEY]);
      expect(setCalls).toEqual([]);

      // External opt-out when RECENT_ROOMS_STORAGE_KEY is already absent + queued join -> removeItem NOT called
      removeCalls.length = 0;
      ctrl.recordJoin({ code: "BBBB2345" });
      inner.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      await flushAll();
      expect(removeCalls).toEqual([]);
      expect(ctrl.isDisabled()).toBe(true);

      // Reset, seed storage, queue clearAll while external opt-out arrives -> removeItem called once
      ctrl.setDisabled(false);
      await flushAll();
      upsertRecentRoom(inner, { code: "CCCC2345", role: "guest", lastJoinedAt: now }, now);
      ctrl.syncFromStorage(false);
      removeCalls.length = 0;
      ctrl.recordJoin({ code: "DDDD2345" });
      ctrl.clearAll();
      inner.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
      await flushAll();
      expect(removeCalls).toEqual([RECENT_ROOMS_STORAGE_KEY]);
    }

    // 3. abortQueueOnStorageError droppedPatchCodes vs droppedJoinCodes + pendingPurge skipped on storage error + property presence
    {
      const inner = makeMemoryStorage({
        [RECENT_ROOMS_STORAGE_KEY]: JSON.stringify([
          { code: "EXPD2345", role: "guest", lastJoinedAt: now - RECENT_ROOM_TTL_MS },
        ]),
      });
      let failSet = false;
      const storage: StorageLike = {
        getItem: (k) => inner.getItem(k),
        setItem: (k, v) => {
          if (failSet) throw new Error("Quota");
          inner.setItem(k, v);
        },
        removeItem: (k) => inner.removeItem(k),
      };
      const tasks: Promise<unknown>[] = [];
      const pending: Array<() => void> = [];
      const locks: LockManagerLike = {
        request: (_name, cb) =>
          new Promise<void>((resolve) => {
            pending.push(() => {
              void Promise.resolve(cb()).finally(resolve);
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
      const flushAll = async () => {
        while (pending.length > 0 || tasks.length > 0) {
          while (pending.length > 0) {
            pending.shift()?.();
            await Promise.resolve();
          }
          if (tasks.length > 0) await Promise.all(tasks.splice(0));
        }
      };

      // Constructor scheduled pendingPurge under deferred lock; enqueue failing join -> pendingPurge MUST NOT prune on error
      failSet = true;
      ctrl.recordJoin({ code: "AAAA2345" });
      await flushAll();
      expect(inner.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(true);

      // Now purge cleanly
      failSet = false;
      ctrl.syncFromStorage(false);
      await flushAll();
      expect(inner.store.has(RECENT_ROOMS_STORAGE_KEY)).toBe(false);

      // recordJoin without password omits "password" property; blank rename omits "label" property
      ctrl.recordJoin({ code: "AAAA2345" });
      await flushAll();
      const joinedEntry = ctrl.getRooms()[0];
      expect(joinedEntry).toBeDefined();
      expect("password" in (joinedEntry ?? {})).toBe(false);

      ctrl.rename("AAAA2345", "TempLabel");
      expect(ctrl.getRooms()[0]?.label).toBe("TempLabel");
      ctrl.rename("AAAA2345", "   ");
      expect("label" in (ctrl.getRooms()[0] ?? {})).toBe(false);
      await flushAll();

      // Failed patch on AAAA2345 followed by join(AAAA2345) & join(BBBB2345) -> AAAA2345 dropped from failedJoinCodes, BBBB2345 added
      failSet = true;
      ctrl.rename("AAAA2345", "FailPatch");
      ctrl.recordJoin({ code: "AAAA2345" });
      ctrl.recordJoin({ code: "BBBB2345" });
      await flushAll();

      failSet = false;
      ctrl.rename("BBBB2345", "CarryB");
      ctrl.recordJoin({ code: "BBBB2345" });
      await flushAll();
      expect(loadRecentRooms(inner, now).find((r) => r.code === "BBBB2345")?.label).toBe("CarryB");
    }

    // 4. shouldReconcileDemote & shouldReconcileRemove onChange call counts + handleCreatorHostForgotten guards
    {
      const h = makeHarness({
        creatorCodes: new Set(["AAAA2345", "BBBB2345"]),
        now: () => now,
      });
      writePersistedHostToken(h.storage, "AAAA2345", "tok-a", now);
      writePersistedHostToken(h.storage, "BBBB2345", "tok-b", now);
      h.ctrl.recordJoin({ code: "AAAA2345", password: "PWA_123456789012" });
      h.ctrl.recordJoin({ code: "BBBB2345", password: "PWB_123456789012" });
      await h.flush();

      // handleCreatorHostForgotten on invalid/unknown code is no-op
      const beforeGuard = h.onChange.mock.calls.length;
      h.ctrl.handleCreatorHostForgotten("BAD");
      h.ctrl.handleCreatorHostForgotten("UNKN2345");
      expect(h.onChange).toHaveBeenCalledTimes(beforeGuard);

      // Forget AAAA2345 while BBBB2345 stays host: must NOT trigger extra reconcile onChange
      h.creatorCodes.delete("AAAA2345");
      const beforeForget = h.onChange.mock.calls.length;
      h.ctrl.handleCreatorHostForgotten("AAAA2345");
      await h.flush();
      expect(h.onChange).toHaveBeenCalledTimes(beforeForget + 1);

      // Remove AAAA2345 while BBBB2345 is in host-rooms (and AAAA2345 is NOT in creatorCodes) -> must NOT reconcile
      const beforeRemove = h.onChange.mock.calls.length;
      h.ctrl.remove("AAAA2345");
      await h.flush();
      expect(h.onChange).toHaveBeenCalledTimes(beforeRemove + 1);
    }
  });
});
