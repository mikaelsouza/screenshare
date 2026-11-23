import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { RecentRoomsController } from "@src/controllers/recent-rooms-controller";
import { HOST_ROOMS_STORAGE_KEY, listPersistedHostRooms, writePersistedHostToken } from "@src/host-tokens";
import { MAX_CLOCK_SKEW_MS, RECENT_ROOMS_OPT_OUT_KEY, RECENT_ROOMS_STORAGE_KEY, RECENT_ROOM_TTL_MS, mergeSynthesizedHostRooms, type LockManagerLike, type StorageLike } from "@src/recent-rooms";
import { isRecentRoomsDisabled, loadRecentRooms, makeHarness, makeMemoryStorage, upsertRecentRoom } from "./recent-rooms-harness";

describe("RecentRoomsController — storage fault recovery and opt-out races", () => {
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

      // Subsequent cross-tab write is visible because queued clear-all drained to disk
      upsertRecentRoom(h.inner, { code: "JKMN2345", role: "guest", lastJoinedAt: now + 2000 }, now + 2000);
      h.ctrl.syncFromStorage();
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["JKMN2345"]);
    }

    // 4. Synthesized room failed rename reverts cleanly, and single-flight batch failure drops queued renames cleanly before recovery
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
      ctrl.rename("ABCD2345", "Label 2 Fail");
      expect(pending).toHaveLength(1);
      pending.shift()?.();
      await Promise.all(tasks.splice(0));
      expect(ctrl.getRooms().find((r) => r.code === "ABCD2345")?.label).toBeUndefined();
      expect(loadRecentRooms(inner, now).find((r) => r.code === "ABCD2345")?.label).toBeUndefined();

      failSet = false;
      ctrl.rename("ABCD2345", "Label 2 Keep");
      expect(pending).toHaveLength(1);
      pending.shift()?.();
      await Promise.all(tasks.splice(0));
      expect(ctrl.getRooms().find((r) => r.code === "ABCD2345")?.label).toBe("Label 2 Keep");
      expect(loadRecentRooms(inner, now).find((r) => r.code === "ABCD2345")?.label).toBe("Label 2 Keep");
    }
  });

  it("drops stale pre-delete patches on externally deleted synthesized host rooms before fresh recordJoin (Probes 1E-ExternalDelete & NoSync)", async () => {
    const now = 1_700_000_000_000;

    for (const runSyncBeforeJoin of [true, false]) {
      const h = makeHarness({ creatorCodes: new Set(["SYNA2345"]), deferredLocks: true, now: () => now });
      writePersistedHostToken(h.storage, "SYNA2345", "tok-syna", now - 1000);
      h.ctrl.syncFromStorage(false);
      expect(h.ctrl.getRooms().map((r) => r.code)).toEqual(["SYNA2345"]);

      h.ctrl.rename("SYNA2345", "Stale Pre-Delete Label");
      expect(h.pendingLockReleases).toHaveLength(1);

      // External Tab B deletes SYNA2345 from host-rooms and creator tokens
      h.storage.removeItem(HOST_ROOMS_STORAGE_KEY);
      h.creatorCodes.delete("SYNA2345");
      if (runSyncBeforeJoin) {
        h.ctrl.syncFromStorage(false);
        expect(h.ctrl.getRooms()).toEqual([]);
      }

      h.ctrl.recordJoin({ code: "SYNA2345", password: "FRESH_GUEST_PW12" });
      expect(h.pendingLockReleases).toHaveLength(1);
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
  });

  it("scrubs failed patch fields from memory when sibling pendingJoin or synth patches succeed (Probes 1H & 1L)", async () => {
    const now = 1_700_000_000_000;

    // 1H: pendingJoin + failed rename -> failed label scrubbed from memory & disk; prior saved label restored
    for (const withPriorLabel of [false, true]) {
      for (const batchMode of [false, true]) {
        const inner = makeMemoryStorage();
        let failSet = false;
        let failWriteNum = 0;
        let writeCount = 0;
        const storage: StorageLike = {
          getItem: (k) => inner.getItem(k),
          setItem: (k, v) => {
            writeCount += 1;
            if (failSet || (failWriteNum > 0 && writeCount === failWriteNum)) {
              throw new Error("QuotaExceededError");
            }
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
        expect(pending).toHaveLength(1);
        pending.shift()?.();
        await Promise.all(tasks.splice(0));

        if (batchMode) {
          writeCount = 0;
          failWriteNum = 2; // write #1 (recordJoin PW2) succeeds, write #2 (rename) fails
          ctrl.recordJoin({ code: "ABCD2345", password: "PW2_123456789012" });
          ctrl.rename("ABCD2345", withPriorLabel ? "" : "Failed Ghost Label");
          expect(pending).toHaveLength(1);
          pending.shift()?.();
          await Promise.all(tasks.splice(0));
        } else {
          ctrl.recordJoin({ code: "ABCD2345", password: "PW2_123456789012" });
          pending.shift()?.();
          await Promise.all(tasks.splice(0));

          failSet = true;
          ctrl.rename("ABCD2345", withPriorLabel ? "" : "Failed Ghost Label");
          pending.shift()?.();
          await Promise.all(tasks.splice(0));
        }

        const mem = ctrl.getRooms().find((r) => r.code === "ABCD2345");
        const disk = loadRecentRooms(inner, now).find((r) => r.code === "ABCD2345");
        expect(mem).toBeDefined();
        expect(mem?.password).toBe("PW2_123456789012");
        expect(mem?.label).toBe(withPriorLabel ? "Saved Label" : undefined);
        expect(disk).toBeDefined();
        expect(disk?.password).toBe("PW2_123456789012");
        expect(disk?.label).toBe(withPriorLabel ? "Saved Label" : undefined);
      }
    }

    // 1L: synthesized host room failed rename + sibling updatePeers (sequential recovery & batch failure)
    for (const batchFailure of [false, true]) {
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

      failSet = true;
      ctrl.rename("SYNA2345", "Failed Synth Label");
      if (batchFailure) ctrl.updatePeers("SYNA2345", ["DroppedPeer"]);
      expect(pending).toHaveLength(1);
      pending.shift()?.();
      await Promise.all(tasks.splice(0));

      expect(ctrl.getRooms().find((r) => r.code === "SYNA2345")?.label).toBeUndefined();
      expect(ctrl.getRooms().find((r) => r.code === "SYNA2345")?.peerNames).toEqual([]);

      failSet = false;
      ctrl.updatePeers("SYNA2345", ["Alice"]);
      expect(pending).toHaveLength(1);
      pending.shift()?.();
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

  it("drops all multi-patch pre-delete edits on externally deleted synthesized rooms under single-flight and AbortError fallback (Multi-Patch 1E-ExternalDelete-NoSync)", async () => {
    const now = 1_700_000_000_000;
    const makeLockCtrl = () => {
      const storage = makeMemoryStorage();
      const tasks: Promise<unknown>[] = [];
      const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const creatorCodes = new Set(["SYNA2345"]);
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
        hasSavedCreatorHostFor: (c) => creatorCodes.has(c),
        onRemoveHostToken: vi.fn(),
        onForgetAllHostTokens: vi.fn(),
        onChange: vi.fn(),
        now: () => now,
      });
      writePersistedHostToken(storage, "SYNA2345", "tok-syna", now - 1000);
      ctrl.syncFromStorage(false);
      return { ctrl, storage, tasks, pending, creatorCodes };
    };

    // 1. rename + updatePeers before external delete -> recordJoin (normal resolve & AbortError fallback)
    for (const rejectLock of [false, true]) {
      const h = makeLockCtrl();
      h.ctrl.rename("SYNA2345", "Stale Multi Label");
      h.ctrl.updatePeers("SYNA2345", ["StalePeer"]);
      h.storage.removeItem(HOST_ROOMS_STORAGE_KEY);
      h.creatorCodes.delete("SYNA2345");
      h.ctrl.recordJoin({ code: "SYNA2345", password: "FRESH_MULTI_PW12" });

      expect(h.pending).toHaveLength(1);
      if (rejectLock) h.pending.shift()?.reject(new Error("AbortError"));
      else h.pending.shift()?.resolve();
      await Promise.all(h.tasks.splice(0));

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

    // 2. updatePeers + rename AND rename1 + rename2 before external delete -> recordJoin
    for (const variant of ["peers-then-rename", "rename-twice"] as const) {
      const h = makeLockCtrl();
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

      expect(h.pending).toHaveLength(1);
      h.pending.shift()?.resolve();
      await Promise.all(h.tasks.splice(0));

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

    // 3. Post-join patch after recordJoin survives while pre-join synth patches are dropped
    for (const rejectLock of [false, true]) {
      const h = makeLockCtrl();
      h.ctrl.rename("SYNA2345", "PreJoinStale");
      h.ctrl.updatePeers("SYNA2345", ["StalePeer"]);
      h.storage.removeItem(HOST_ROOMS_STORAGE_KEY);
      h.creatorCodes.delete("SYNA2345");
      h.ctrl.recordJoin({ code: "SYNA2345", password: "FRESH_MULTI_PW12" });
      h.ctrl.rename("SYNA2345", "KeepAfterJoin");

      expect(h.pending).toHaveLength(1);
      if (rejectLock) h.pending.shift()?.reject(new Error("AbortError"));
      else h.pending.shift()?.resolve();
      await Promise.all(h.tasks.splice(0));

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
      expect(h.pendingLockReleases).toHaveLength(0);

      // Flush deferred lock (which now picks up flushRequested -> setDisabled(false))
      deferredOldJoinLock?.();
      await h.flush();

      const mem = h.ctrl.getRooms().find((r) => r.code === "ABCD2345");
      const disk = loadRecentRooms(h.storage, now).find((r) => r.code === "ABCD2345");
      expect(mem).toBeDefined();
      expect(mem?.password).toBe("NEW_SECRET_12345");
      expect(disk).toBeDefined();
      expect(disk?.password).toBe("NEW_SECRET_12345");
    }

    // Scenario C: clearAll() fails with SecurityError -> external opt-out arrives -> queued clear-all is preserved and flushes on recovery
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
      h.ctrl.clearAll();
      expect(h.pendingLockReleases).toHaveLength(1);

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
      expect(h.pendingLockReleases).toHaveLength(1);
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

    // CR #7: recordJoin carries forward omitted password/peerNames under single-flight + AbortError fallback
    for (const rejectLock of [false, true]) {
      const now = 1_700_000_000_000;
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

      ctrl.recordJoin({ code: "CARR2345", password: "INIT_SECRET_1234", peerNames: ["Alice"] });
      ctrl.rename("CARR2345", "Carry Label");
      ctrl.recordJoin({ code: "CARR2345" });

      expect(pending).toHaveLength(1);
      if (rejectLock) pending.shift()?.reject(new Error("AbortError"));
      else pending.shift()?.resolve();
      await Promise.all(tasks.splice(0));

      const disk = loadRecentRooms(storage, now).find((r) => r.code === "CARR2345");
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
