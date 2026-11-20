import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInviteInput } from "@shared/protocol";
import { SessionController } from "@src/controllers/session-controller";
import { readPersistedHostToken, writePersistedHostToken } from "@src/host-tokens";

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

function makeController(overrides?: {
  local?: Storage | null;
  session?: Storage | null;
  onForgetHostUiChange?: () => void;
}) {
  const local = overrides?.local !== undefined ? overrides.local : createMemoryStorage();
  const sess = overrides?.session !== undefined ? overrides.session : createMemoryStorage();
  const tasks: Promise<unknown>[] = [];
  const onForgetHostUiChange = overrides?.onForgetHostUiChange ?? vi.fn();
  const ctrl = new SessionController({
    getLocalStorage: () => local,
    getSessionStorage: () => sess,
    getLocks: () => null,
    runBackground: (t) => {
      tasks.push(t);
    },
    onForgetHostUiChange,
  });
  return { ctrl, local, sess, tasks, onForgetHostUiChange };
}

describe("SessionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists creator host tokens separately from ephemeral session host tokens", async () => {
    const { ctrl, local, sess, tasks } = makeController();
    ctrl.saveCreatorHostToken("ABCD2345", "creator-tok");
    await Promise.all(tasks);

    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-tok");
    expect(ctrl.hasSavedCreatorHostFor("ABCD2345")).toBe(true);
    expect(ctrl.hasAnySavedCreatorHosts()).toBe(true);
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("creator-tok");

    // Promoted session host token takes precedence in-memory without overwriting localStorage creator token
    ctrl.saveSessionHostToken("ABCD2345", "promoted-tok");
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("promoted-tok");

    // Clearing room session drops promoted session token + rejoin token but keeps creator provenance
    ctrl.lastJoinCode = "ABCD2345";
    ctrl.saveActiveRoom("ABCD2345");
    ctrl.saveRejoinToken("ABCD2345", "rejoin-1");
    ctrl.clearRoomSession();
    expect(ctrl.activeRoomFor()).toBeUndefined();
    expect(ctrl.rejoinTokenFor("ABCD2345")).toBeUndefined();
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("creator-tok");

    // Legacy sessionStorage host:CODE migration
    sess?.setItem("host:WXYZ5678", "legacy-tok");
    expect(ctrl.hostTokenFor("WXYZ5678")).toBe("legacy-tok");
    await Promise.all(tasks);
    expect(sess?.getItem("host:WXYZ5678")).toBeNull();
    expect(ctrl.hasSavedCreatorHostFor("WXYZ5678")).toBe(true);

    // Cross-tab storage sync removes deleted creator tokens and updates rotated ones
    writePersistedHostToken(local, "ABCD2345", undefined);
    writePersistedHostToken(local, "WXYZ5678", "updated-tok");
    ctrl.syncCreatorTokensFromStorage();
    expect(ctrl.hasSavedCreatorHostFor("ABCD2345")).toBe(false);
    expect(ctrl.hostTokenFor("WXYZ5678")).toBe("updated-tok");

    // Forget all clears both maps and storage
    ctrl.forgetAllHostTokens();
    await Promise.all(tasks);
    expect(ctrl.hasAnySavedCreatorHosts()).toBe(false);
    expect(ctrl.hostTokenFor("WXYZ5678")).toBeUndefined();
  });

  it("keeps a forgotten creator token out of memory while persisted removal awaits the lock", async () => {
    const local = createMemoryStorage();
    const sess = createMemoryStorage();
    const tasks: Promise<unknown>[] = [];
    const pendingReleases: Array<() => void> = [];
    const locks = {
      request: vi.fn((_name: string, cb: () => unknown) => {
        return new Promise<unknown>((resolve) => {
          pendingReleases.push(() => resolve(cb()));
        });
      }),
    } as unknown as LockManager;
    const ctrl = new SessionController({
      getLocalStorage: () => local,
      getSessionStorage: () => sess,
      getLocks: () => locks,
      runBackground: (p) => { tasks.push(p); },
      onForgetHostUiChange: vi.fn(),
    });
    writePersistedHostToken(local, "ABCD2345", "creator-tok");
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("creator-tok");

    ctrl.forgetCreatorHostToken("ABCD2345");
    // Before the lock resolves, storage still has the token, but lookups must NOT return or re-cache it
    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-tok");
    expect(ctrl.hostTokenFor("ABCD2345")).toBeUndefined();
    expect(ctrl.hasSavedCreatorHostFor("ABCD2345")).toBe(false);

    for (const release of pendingReleases) release();
    await Promise.all(tasks);
    expect(readPersistedHostToken(local, "ABCD2345")).toBeUndefined();
    expect(ctrl.hostTokenFor("ABCD2345")).toBeUndefined();
  });

  it("handles welcome credentials, room state, room password, and host promotion", async () => {
    const { ctrl, tasks } = makeController();
    ctrl.selfId = "self1";
    ctrl.members.set("peer2", { name: "Bob", sharing: false, host: true });

    ctrl.saveCreatorHostToken("ABCD1234", "creator-tok");
    await Promise.all(tasks);

    // Non-host welcome in locked room clears roomPassword and requests invite hide
    const res1 = ctrl.applyWelcomeCredentials(
      "ABCD1234",
      { host: false, locked: true, rejoinToken: "rj-1" },
      "creator-tok",
    );
    expect(res1.hideInvite).toBe(true);
    expect(ctrl.roomPassword).toBeNull();
    expect(ctrl.rejoinTokenFor("ABCD1234")).toBe("rj-1");

    // Host welcome with hostToken stores in sessionHostTokens
    const res2 = ctrl.applyWelcomeCredentials(
      "ABCD1234",
      { host: true, locked: false, hostToken: "promo-1", password: "PASSWORD12345678", rejoinToken: "rj-2" },
      undefined,
    );
    expect(res2.hideInvite).toBe(false);
    expect(ctrl.roomPassword).toBe("PASSWORD12345678");
    expect(ctrl.hostTokenFor("ABCD1234")).toBe("promo-1");

    // Creator welcome without new hostToken refreshes creator token
    ctrl.deleteSessionHostToken("ABCD1234");
    const res3 = ctrl.applyWelcomeCredentials("ABCD1234", { host: true, locked: false }, "creator-tok");
    expect(res3.hideInvite).toBe(false);
    await Promise.all(tasks);

    // Room lock clears password for non-host, unlock restores it
    ctrl.isHost = false;
    ctrl.applyRoomState(true);
    expect(ctrl.roomLocked).toBe(true);
    expect(ctrl.roomPassword).toBeNull();
    ctrl.applyRoomState(false, "UNLOCKED12345678");
    expect(ctrl.roomPassword).toBe("UNLOCKED12345678");

    // Room password update while locked as non-host without password clears password
    ctrl.roomLocked = true;
    ctrl.applyRoomPassword("ABCD1234", undefined, "rj-3");
    expect(ctrl.roomPassword).toBeNull();
    expect(ctrl.rejoinTokenFor("ABCD1234")).toBe("rj-3");

    // Host promotion to self updates isHost, member flags, session host token, and password
    ctrl.applyHostPromoted("ABCD1234", "self1", "promo-2", "SECRET1234567890");
    expect(ctrl.isHost).toBe(true);
    expect(ctrl.members.get("peer2")?.host).toBe(false);
    expect(ctrl.hostTokenFor("ABCD1234")).toBe("promo-2");
    expect(ctrl.roomPassword).toBe("SECRET1234567890");
  });

  it("classifies errors and cleans up session vs creator tokens on fatal errors", async () => {
    const { ctrl, tasks } = makeController();
    ctrl.saveCreatorHostToken("ABCD1234", "creator-tok");
    ctrl.saveSessionHostToken("ABCD1234", "sess-tok");
    ctrl.saveRejoinToken("ABCD1234", "rj-1");
    ctrl.saveActiveRoom("ABCD1234");
    ctrl.lastJoinCode = "ABCD1234";
    await Promise.all(tasks);

    expect(ctrl.classifyError("ABCD1234", "kicked", "raw", true)).toEqual({
      friendly: "You were removed from this room by its host.",
      severity: "fatal",
      clearPendingKicks: true,
    });
    expect(ctrl.classifyError("ABCD1234", "not-host", "Only host", false)).toEqual({
      friendly: "Only host",
      severity: "warn",
      clearPendingKicks: true,
    });
    expect(ctrl.classifyError("ABCD1234", "unknown-peer", "nope", false)).toEqual({
      friendly: "nope",
      severity: "ignore",
      clearPendingKicks: true,
    });
    expect(ctrl.classifyError("ABCD1234", "not-sharing", "nope", false)).toEqual({
      friendly: "nope",
      severity: "ignore",
      clearPendingKicks: false,
    });
    ctrl.startPendingKick("p-chat", "Bob", vi.fn(), 5000);
    expect(
      ctrl.classifyError("ABCD1234", "chat-rate-limited", "You're sending messages too fast. Wait a moment.", false),
    ).toEqual({
      friendly: "You're sending messages too fast. Wait a moment.",
      severity: "ignore",
      clearPendingKicks: false,
    });
    expect(ctrl.classifyError("ABCD1234", "chat-rate-limited", "Custom chat throttle", false)).toEqual({
      friendly: "Custom chat throttle",
      severity: "ignore",
      clearPendingKicks: false,
    });
    expect(ctrl.classifyError("ABCD1234", "chat-rate-limited", "Slow down", true)).toEqual({
      friendly: "Slow down",
      severity: "fatal",
      clearPendingKicks: true,
    });
    expect(ctrl.hasPendingKick("p-chat")).toBe(true);
    ctrl.clearPendingKicks();
    expect(ctrl.classifyError("ABCD1234", "rate-limited", "Slow down", false)).toEqual({
      friendly: "Slow down",
      severity: "error",
      clearPendingKicks: true,
    });
    expect(ctrl.classifyError("ABCD1234", "room-full", "Full", false)).toEqual({
      friendly: "room-full: Full",
      severity: "error",
      clearPendingKicks: true,
    });

    // Kicked wipes session AND matching creator token
    ctrl.applyFatalErrorCleanup("ABCD1234", "kicked", true, "creator-tok");
    await Promise.all(tasks);
    expect(ctrl.activeRoomFor()).toBeUndefined();
    expect(ctrl.rejoinTokenFor("ABCD1234")).toBeUndefined();
    expect(ctrl.hasSavedCreatorHostFor("ABCD1234")).toBe(false);
    expect(ctrl.lastJoinCode).toBeNull();

    // Non-session-wiping fatal error before welcome clears activeRoom only
    ctrl.saveActiveRoom("WXYZ5678");
    ctrl.saveRejoinToken("WXYZ5678", "rj-keep");
    ctrl.applyFatalErrorCleanup("WXYZ5678", "connection-failed", false, undefined);
    expect(ctrl.activeRoomFor()).toBeUndefined();
    expect(ctrl.rejoinTokenFor("WXYZ5678")).toBe("rj-keep");
  });

  it("manages transient room notices, pending kicks, and boot/hash resolution", () => {
    const { ctrl } = makeController();
    ctrl.selfId = "self1";
    ctrl.lastJoinCode = "ABCD1234";

    const shown: string[] = [];
    const expired: string[] = [];
    const restored: string[] = [];
    ctrl.showTransientNotice("Notice!", (m) => shown.push(m), (m) => expired.push(m), 3000);
    expect(shown).toEqual(["Notice!"]);
    expect(ctrl.currentTransientNotice).toBe("Notice!");

    ctrl.dismissTransientNotice("Notice!", true, (t) => restored.push(t));
    expect(restored).toEqual(["In room ABCD1234 \u2014 1/20 connected"]);
    expect(ctrl.currentTransientNotice).toBeNull();

    ctrl.showTransientNotice("Notice 2", (m) => shown.push(m), (m) => expired.push(m), 3000);
    vi.advanceTimersByTime(3000);
    expect(expired).toEqual(["Notice 2"]);

    // Pending kicks
    const onTimeout = vi.fn();
    expect(ctrl.startPendingKick("p1", "Bob", onTimeout, 5000)).toBe(true);
    expect(ctrl.startPendingKick("p1", "Bob", onTimeout, 5000)).toBe(false);
    expect(ctrl.hasPendingKick("p1")).toBe(true);
    expect(ctrl.consumePendingKick("p1")).toBe("Bob");
    expect(ctrl.consumePendingKick("p1")).toBeNull();

    ctrl.startPendingKick("p2", "Cara", onTimeout, 5000);
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(ctrl.hasPendingKick("p2")).toBe(false);

    // Boot / hash resolution
    expect(ctrl.resolveBootAction("#bad", false, { active: false, fatal: false, ready: false }).kind).toBe("error");
    expect(
      ctrl.resolveBootAction("#ABCD2345-ABCDEFGH23456789", false, { active: false, fatal: false, ready: false }),
    ).toEqual({ kind: "enter-invite", code: "ABCD2345", password: "ABCDEFGH23456789" });

    ctrl.lastJoinCode = "ABCD2345";
    expect(
      ctrl.resolveBootAction("#ABCD2345-ABCDEFGH23456789", true, { active: true, fatal: false, ready: false }),
    ).toEqual({ kind: "reconnect-current", password: "ABCDEFGH23456789" });
    expect(
      ctrl.resolveBootAction("#ABCD2345-ABCDEFGH23456789", true, { active: true, fatal: false, ready: true }),
    ).toEqual({ kind: "none" });
    expect(ctrl.resolveBootAction("", true, { active: false, fatal: false, ready: false })).toEqual({ kind: "none" });

    // Resume saved room on F5 reload
    ctrl.saveActiveRoom("ABCD2345");
    ctrl.saveRejoinToken("ABCD2345", "rj-f5");
    expect(ctrl.resolveBootAction("", false, { active: false, fatal: false, ready: false })).toEqual({
      kind: "resume-saved",
      code: "ABCD2345",
    });

    // Invalid or tokenless saved room is cleared
    ctrl.saveRejoinToken("ABCD2345", undefined);
    expect(ctrl.resolveBootAction("", false, { active: false, fatal: false, ready: false })).toEqual({ kind: "none" });
    expect(ctrl.activeRoomFor()).toBeUndefined();

    ctrl.resetRoomState();
    expect(ctrl.selfId).toBeNull();
    expect(ctrl.isHost).toBe(false);
    expect(ctrl.roomLocked).toBe(false);
  });

  it("handles unavailable storage gracefully", () => {
    const throwingStorage = {
      get length() {
        return 0;
      },
      clear() {
        throw new Error("denied");
      },
      getItem() {
        throw new Error("denied");
      },
      key() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    } as Storage;

    const { ctrl } = makeController({ local: null, session: throwingStorage });
    expect(ctrl.readSession("missing")).toBeUndefined();
    ctrl.writeSession("k", "v");
    expect(ctrl.readSession("k")).toBe("v");
    ctrl.writeSession("k", undefined);
    expect(ctrl.readSession("k")).toBeUndefined();
    ctrl.clearRoomSession();
    expect(ctrl.activeRoomFor()).toBeUndefined();
  });

  it("enforces creator vs mid-session promoted guest hostToken provenance without overwriting localStorage", async () => {
    const { ctrl, local, sess, tasks } = makeController();
    ctrl.selfId = "guest1";

    // Promoted mid-session guest gets an in-memory sessionHostToken ONLY, never localStorage
    ctrl.applyHostPromoted("ABCD2345", "guest1", "promoted-guest-tok", "PASS123456789012");
    await Promise.all(tasks);
    expect(ctrl.isHost).toBe(true);
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("promoted-guest-tok");
    expect(ctrl.hasSavedCreatorHostFor("ABCD2345")).toBe(false);
    expect(readPersistedHostToken(local, "ABCD2345")).toBeUndefined();

    // Creator token in localStorage is NOT overwritten by mid-session promotion or welcome hostToken
    ctrl.saveCreatorHostToken("ABCD2345", "creator-orig");
    await Promise.all(tasks);
    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-orig");

    ctrl.applyWelcomeCredentials(
      "ABCD2345",
      { host: true, locked: false, hostToken: "ephemeral-host-tok", password: "PASS123456789012" },
      "creator-orig",
    );
    await Promise.all(tasks);
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("ephemeral-host-tok");
    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-orig");

    // Non-host welcome drops ephemeral session token while preserving creator provenance
    ctrl.applyWelcomeCredentials("ABCD2345", { host: false, locked: false }, "creator-orig");
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("creator-orig");
    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-orig");

    // forgetCreatorHostToken with non-matching token preserves both creator and session tokens
    ctrl.saveSessionHostToken("ABCD2345", "ephemeral-2");
    ctrl.forgetCreatorHostToken("ABCD2345", "wrong-token");
    await Promise.all(tasks);
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("ephemeral-2");
    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-orig");

    // forgetCreatorHostToken without onlyIfMatching removes creator, session, legacy sessionStorage, and localStorage
    sess?.setItem("host:ABCD2345", "legacy-should-clear");
    ctrl.forgetCreatorHostToken("ABCD2345");
    await Promise.all(tasks);
    expect(ctrl.hostTokenFor("ABCD2345")).toBeUndefined();
    expect(ctrl.hasSavedCreatorHostFor("ABCD2345")).toBe(false);
    expect(sess?.getItem("host:ABCD2345")).toBeNull();
    expect(readPersistedHostToken(local, "ABCD2345")).toBeUndefined();

    // forgetAllHostTokens clears host:* keys from memorySession/sessionStorage/localStorage but keeps activeRoom & rejoin
    ctrl.saveActiveRoom("WXYZ2345");
    ctrl.saveRejoinToken("WXYZ2345", "rj-keep");
    ctrl.writeSession("host:WXYZ2345", "legacy-mem");
    ctrl.saveCreatorHostToken("WXYZ2345", "creator-2");
    await Promise.all(tasks);
    ctrl.forgetAllHostTokens();
    await Promise.all(tasks);
    expect(ctrl.hasAnySavedCreatorHosts()).toBe(false);
    expect(ctrl.readSession("host:WXYZ2345")).toBeUndefined();
    expect(ctrl.activeRoomFor()).toBe("WXYZ2345");
    expect(ctrl.rejoinTokenFor("WXYZ2345")).toBe("rj-keep");
  });

  it("clears sessionStorage on fatal wiping errors vs retains for F5 reload on transient fatal errors", async () => {
    const { ctrl, local, tasks } = makeController();

    // bad-password wipes session + sessionHostTokens but preserves creator token in localStorage
    ctrl.saveCreatorHostToken("ABCD2345", "creator-tok");
    ctrl.saveSessionHostToken("ABCD2345", "promo-tok");
    ctrl.saveActiveRoom("ABCD2345");
    ctrl.saveRejoinToken("ABCD2345", "rj-1");
    ctrl.lastJoinCode = "ABCD2345";
    await Promise.all(tasks);

    ctrl.applyFatalErrorCleanup("ABCD2345", "bad-password", false, "creator-tok");
    await Promise.all(tasks);
    expect(ctrl.activeRoomFor()).toBeUndefined();
    expect(ctrl.rejoinTokenFor("ABCD2345")).toBeUndefined();
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("creator-tok");
    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-tok");

    // kicked with undefined lastPresentedHostToken does NOT wipe creator token
    ctrl.saveActiveRoom("ABCD2345");
    ctrl.saveRejoinToken("ABCD2345", "rj-2");
    ctrl.applyFatalErrorCleanup("ABCD2345", "kicked", true, undefined);
    await Promise.all(tasks);
    expect(ctrl.activeRoomFor()).toBeUndefined();
    expect(ctrl.rejoinTokenFor("ABCD2345")).toBeUndefined();
    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-tok");

    // kicked with mismatched (promoted) token does NOT wipe creator token
    ctrl.applyFatalErrorCleanup("ABCD2345", "kicked", true, "other-promoted-tok");
    await Promise.all(tasks);
    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-tok");

    // bad-room-code with matching creator token wipes creator token
    ctrl.applyFatalErrorCleanup("ABCD2345", "bad-room-code", false, "creator-tok");
    await Promise.all(tasks);
    expect(readPersistedHostToken(local, "ABCD2345")).toBeUndefined();

    // Non-session-wiping fatal error AFTER welcome retains activeRoom + rejoinToken for F5 reload
    ctrl.saveActiveRoom("WXYZ2345");
    ctrl.saveRejoinToken("WXYZ2345", "rj-f5");
    ctrl.applyFatalErrorCleanup("WXYZ2345", "connection-failed", true, undefined);
    expect(ctrl.activeRoomFor()).toBe("WXYZ2345");
    expect(ctrl.rejoinTokenFor("WXYZ2345")).toBe("rj-f5");
    expect(ctrl.resolveBootAction("", false, { active: false, fatal: false, ready: false })).toEqual({
      kind: "resume-saved",
      code: "WXYZ2345",
    });
  });

  it("handles resolveBootAction edge cases across connected/fatal/disconnected states and malformed fragments", async () => {
    const { ctrl, tasks } = makeController();
    ctrl.selfId = "self1";
    ctrl.lastJoinCode = "ABCD2345";
    ctrl.roomPassword = "OLDPASS23456789A";

    // hashchange to SAME room when connected & ready -> none, does not overwrite roomPassword
    expect(
      ctrl.resolveBootAction("#ABCD2345-NEWPASS23456789A", true, { active: true, fatal: false, ready: true }),
    ).toEqual({ kind: "none" });
    expect(ctrl.roomPassword).toBe("OLDPASS23456789A");

    // hashchange to SAME room when active & fatal -> enter-invite (fresh join)
    expect(
      ctrl.resolveBootAction("#ABCD2345-NEWPASS23456789A", true, { active: true, fatal: true, ready: false }),
    ).toEqual({ kind: "enter-invite", code: "ABCD2345", password: "NEWPASS23456789A" });

    // hashchange to DIFFERENT room when connected & ready -> enter-invite
    expect(
      ctrl.resolveBootAction("#WXYZ2345-NEWPASS23456789A", true, { active: true, fatal: false, ready: true }),
    ).toEqual({ kind: "enter-invite", code: "WXYZ2345", password: "NEWPASS23456789A" });

    // hashchange to SAME room while not yet welcomed (selfId === null) -> enter-invite
    ctrl.selfId = null;
    expect(
      ctrl.resolveBootAction("#ABCD2345-NEWPASS23456789A", true, { active: true, fatal: false, ready: false }),
    ).toEqual({ kind: "enter-invite", code: "ABCD2345", password: "NEWPASS23456789A" });

    // Boot with empty hash resumes saved room via creator hostToken even without rejoinToken
    ctrl.saveActiveRoom("WXYZ2345");
    ctrl.saveCreatorHostToken("WXYZ2345", "creator-tok");
    await Promise.all(tasks);
    expect(ctrl.resolveBootAction("", false, { active: false, fatal: false, ready: false })).toEqual({
      kind: "resume-saved",
      code: "WXYZ2345",
    });

    // Boot with invalid saved activeRoom clears it and returns none
    ctrl.saveActiveRoom("NOT-A-VALID-CODE");
    expect(ctrl.resolveBootAction("", false, { active: false, fatal: false, ready: false })).toEqual({ kind: "none" });
    expect(ctrl.activeRoomFor()).toBeUndefined();

    // Malformed fragments return error
    for (const bad of ["#", "#   ", "#ABCD2345", "#ABCD2345-", "#%E0%A4%A"]) {
      expect(ctrl.resolveBootAction(bad, true, { active: false, fatal: false, ready: false }).kind).toBe("error");
    }

    // Direct parseInviteInput edge cases (URL, malformed URI encoding, host/path, concatenated tokens)
    expect(parseInviteInput("")).toEqual({ ok: false, reason: "empty" });
    expect(parseInviteInput("#")).toEqual({ ok: false, reason: "empty" });
    expect(parseInviteInput("https://example.com/")).toEqual({ ok: false, reason: "url-missing-invite" });
    expect(parseInviteInput("https://example.com/#")).toEqual({ ok: false, reason: "url-missing-invite" });
    expect(parseInviteInput("example.com/room")).toEqual({ ok: false, reason: "url-missing-invite" });
    expect(parseInviteInput("/room")).toEqual({ ok: false, reason: "url-missing-invite" });
    expect(parseInviteInput("example.com/#")).toEqual({ ok: false, reason: "url-missing-invite" });
    expect(parseInviteInput("https://[bad-url")).toEqual({ ok: false, reason: "invalid" });
    expect(parseInviteInput("https://example.com/#%E0%A4%A")).toEqual({ ok: false, reason: "invalid" });
    expect(parseInviteInput("ABCD2345-")).toEqual({ ok: false, reason: "missing-secret" });
    expect(parseInviteInput("BAD-")).toEqual({ ok: false, reason: "invalid" });
    expect(parseInviteInput("https://example.com/##abcd2345.abcdefgh23456789")).toEqual({
      ok: true,
      code: "ABCD2345",
      password: "ABCDEFGH23456789",
    });
    expect(parseInviteInput("ABCD2345ABCDEFGH23456789")).toEqual({
      ok: true,
      code: "ABCD2345",
      password: "ABCDEFGH23456789",
    });
  });

  it("handles applyRoomPassword, clearPendingKicks, and transient notice dismissal edge cases", () => {
    const { ctrl } = makeController();
    ctrl.selfId = "self1";
    ctrl.lastJoinCode = "ABCD2345";
    ctrl.isHost = true;
    ctrl.roomLocked = true;

    // applyRoomPassword with explicit password updates roomPassword
    ctrl.applyRoomPassword("ABCD2345", "ROTATED123456789", "rj-rot");
    expect(ctrl.roomPassword).toBe("ROTATED123456789");
    expect(ctrl.rejoinTokenFor("ABCD2345")).toBe("rj-rot");

    // clearPendingKicks cancels all pending kick timers without firing callbacks
    const onTimeout = vi.fn();
    ctrl.startPendingKick("p1", "Alice", onTimeout, 2000);
    ctrl.startPendingKick("p2", "Bob", onTimeout, 2000);
    ctrl.clearPendingKicks();
    expect(ctrl.hasPendingKick("p1")).toBe(false);
    expect(ctrl.hasPendingKick("p2")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();

    // dismissTransientNotice does NOT restore if status text was overwritten by another message
    const onRestore = vi.fn();
    const onExpire = vi.fn();
    ctrl.showTransientNotice("Notice A", vi.fn(), onExpire, 3000);
    ctrl.dismissTransientNotice("Different status text", true, onRestore);
    expect(onRestore).not.toHaveBeenCalled();
    expect(ctrl.currentTransientNotice).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();

    // clearTransientNoticeState prevents expiration callback
    ctrl.showTransientNotice("Notice B", vi.fn(), onExpire, 3000);
    ctrl.clearTransientNoticeState();
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("formats all fatal error codes accurately and invokes onForgetHostUiChange on every host-token mutation", async () => {
    const onForgetHostUiChange = vi.fn();
    const { ctrl, local, sess, tasks } = makeController({ onForgetHostUiChange });
    expect(ctrl.isHost).toBe(false);
    expect(ctrl.roomLocked).toBe(false);

    expect(ctrl.classifyError("ABCD2345", "room-locked", "fallback", true).friendly).toContain("Room ABCD2345 is locked");
    expect(ctrl.classifyError("ABCD2345", "session-replaced", "fallback", true).friendly).toContain("another tab");
    expect(ctrl.classifyError("ABCD2345", "bad-password", "fallback", true).friendly).toBe("Invalid or expired room invite.");
    expect(ctrl.classifyError("ABCD2345", "join-timeout", "fallback", true).friendly).toContain("timed out");
    expect(ctrl.classifyError("ABCD2345", "connection-failed", "fallback", true).friendly).toContain("Could not connect");
    expect(ctrl.classifyError("ABCD2345", "bad-message", "fallback", true).friendly).toContain("protocol error");

    onForgetHostUiChange.mockClear();
    ctrl.saveCreatorHostToken("ABCD2345", "creator-1");
    await Promise.all(tasks);
    expect(onForgetHostUiChange).toHaveBeenCalledTimes(2);

    // Persisted-only creator token still reports hasSavedCreatorHostFor and syncs
    onForgetHostUiChange.mockClear();
    ctrl.syncCreatorTokensFromStorage();
    expect(ctrl.hasSavedCreatorHostFor("ABCD2345")).toBe(true);
    expect(onForgetHostUiChange).toHaveBeenCalledTimes(1);

    // saveSessionHostToken and deleteSessionHostToken trigger UI update
    onForgetHostUiChange.mockClear();
    ctrl.saveSessionHostToken("ABCD2345", "sess-1");
    expect(onForgetHostUiChange).toHaveBeenCalledTimes(1);
    ctrl.deleteSessionHostToken("ABCD2345");
    expect(ctrl.hostTokenFor("ABCD2345")).toBe("creator-1");

    // forgetCreatorHostToken with matching token clears both maps and fires UI update
    onForgetHostUiChange.mockClear();
    ctrl.saveSessionHostToken("ABCD2345", "creator-1");
    ctrl.forgetCreatorHostToken("ABCD2345", "creator-1");
    await Promise.all(tasks);
    expect(ctrl.hostTokenFor("ABCD2345")).toBeUndefined();
    expect(onForgetHostUiChange).toHaveBeenCalled();

    // clearRoomSession falls back to lastJoinCode and activeRoomFor, and handles no target
    ctrl.lastJoinCode = null;
    ctrl.clearRoomSession();
    expect(ctrl.activeRoomFor()).toBeUndefined();
    ctrl.saveActiveRoom("WXYZ2345");
    ctrl.saveRejoinToken("WXYZ2345", "rj-wxyz");
    ctrl.clearRoomSession();
    expect(ctrl.activeRoomFor()).toBeUndefined();
    expect(ctrl.rejoinTokenFor("WXYZ2345")).toBeUndefined();

    // forgetAllHostTokens removes legacy sessionStorage host:* keys
    sess?.setItem("host:ZZZZ2345", "legacy-val");
    ctrl.saveSessionHostToken("ZZZZ2345", "mem-val");
    onForgetHostUiChange.mockClear();
    ctrl.forgetAllHostTokens();
    await Promise.all(tasks);
    expect(sess?.getItem("host:ZZZZ2345")).toBeNull();
    expect(ctrl.hostTokenFor("ZZZZ2345")).toBeUndefined();
    expect(onForgetHostUiChange).toHaveBeenCalled();

    // Re-presenting a creator token on welcome refreshes its persisted timestamp
    ctrl.saveCreatorHostToken("ABCD2345", "creator-refresh");
    await Promise.all(tasks);
    local?.removeItem("host-rooms");
    // Creator token is in memory; presenting it as lastPresentedHostToken re-persists it
    ctrl.applyWelcomeCredentials("ABCD2345", { host: true, locked: false }, "creator-refresh");
    await Promise.all(tasks);
    expect(readPersistedHostToken(local, "ABCD2345")).toBe("creator-refresh");

    // Locked room welcome for non-host clears roomPassword
    ctrl.roomPassword = "OLDSECRET1234567";
    ctrl.applyWelcomeCredentials("ABCD2345", { host: false, locked: true }, undefined);
    expect(ctrl.roomPassword).toBeNull();

    // applyRoomState when locked as non-host clears roomPassword; when unlocked updates password
    ctrl.isHost = false;
    ctrl.roomPassword = "STILLHERE1234567";
    ctrl.applyRoomState(true);
    expect(ctrl.roomPassword).toBeNull();
    ctrl.applyRoomState(false, "NEWPASS123456789");
    expect(ctrl.roomPassword).toBe("NEWPASS123456789");

    // applyRoomPassword when locked as non-host clears roomPassword
    ctrl.roomLocked = true;
    ctrl.isHost = false;
    ctrl.applyRoomPassword("ABCD2345", undefined, "rj-locked");
    expect(ctrl.roomPassword).toBeNull();
    expect(ctrl.rejoinTokenFor("ABCD2345")).toBe("rj-locked");

    // applyHostPromoted updates member host flags for both self and others
    ctrl.selfId = "p1";
    ctrl.members.set("p1", { name: "Me", sharing: false, host: false });
    ctrl.members.set("p2", { name: "Peer", sharing: false, host: true });
    ctrl.applyHostPromoted("ABCD2345", "p2");
    expect(ctrl.isHost).toBe(false);
    expect(ctrl.members.get("p1")?.host).toBe(false);
    expect(ctrl.members.get("p2")?.host).toBe(true);
    ctrl.applyHostPromoted("ABCD2345", "p1", "promo-tok", "PROMOPASS1234567");
    expect(ctrl.isHost).toBe(true);
    expect(ctrl.members.get("p1")?.host).toBe(true);
    expect(ctrl.members.get("p2")?.host).toBe(false);
    expect(ctrl.roomPassword).toBe("PROMOPASS1234567");

    // dismissTransientNotice restores status when message matches, joined, and room active
    const onShow = vi.fn();
    const onRestore = vi.fn();
    ctrl.lastJoinCode = "ABCD2345";
    ctrl.showTransientNotice("Host left", onShow, vi.fn(), 3000);
    expect(onShow).toHaveBeenCalledWith("Host left");
    ctrl.dismissTransientNotice("Host left", true, onRestore);
    expect(onRestore).toHaveBeenCalledTimes(1);

    // resetRoomState clears pending kicks, transient notice, and members
    const kickTimeout = vi.fn();
    ctrl.startPendingKick("p2", "Peer", kickTimeout, 2000);
    ctrl.showTransientNotice("Temp", vi.fn(), vi.fn(), 2000);
    ctrl.resetRoomState();
    expect(ctrl.members.size).toBe(0);
    expect(ctrl.currentTransientNotice).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(kickTimeout).not.toHaveBeenCalled();
  });

  it("hardens storage, async lock guards, transient notice timers, and host/lock transitions", async () => {
    // writeSession / readSession direct sessionStorage sync and null sessionStorage
    const { ctrl: nullSessCtrl } = makeController({ session: null });
    expect(nullSessCtrl.readSession("missing")).toBeUndefined();
    nullSessCtrl.writeSession("k", "v");
    expect(nullSessCtrl.readSession("k")).toBe("v");
    nullSessCtrl.writeSession("k", undefined);
    expect(nullSessCtrl.readSession("k")).toBeUndefined();

    const { ctrl: sessCtrl, sess: realSess } = makeController();
    sessCtrl.writeSession("k", "v");
    expect(realSess?.getItem("k")).toBe("v");
    sessCtrl.writeSession("k", undefined);
    expect(realSess?.getItem("k")).toBeNull();

    // Fresh controller sees persisted-only creator tokens without in-memory cache
    const localOnly = createMemoryStorage();
    writePersistedHostToken(localOnly, "ABCD2345", "persisted-only-tok");
    const { ctrl: freshCtrl } = makeController({ local: localOnly });
    expect(freshCtrl.hasSavedCreatorHostFor("ABCD2345")).toBe(true);
    expect(freshCtrl.hasAnySavedCreatorHosts()).toBe(true);
    expect(freshCtrl.hasSavedCreatorHostFor("ZZZZ9999")).toBe(false);

    // Pending async LockManager: forgetCreatorHostToken with mismatched vs matching token
    const lockLocal = createMemoryStorage();
    const lockSess = createMemoryStorage();
    const lockTasks: Promise<unknown>[] = [];
    const pendingReleases: Array<() => void> = [];
    const onForgetUi = vi.fn();
    const locks = {
      request: vi.fn((_name: string, cb: () => unknown) => {
        return new Promise<unknown>((resolve) => {
          pendingReleases.push(() => resolve(cb()));
        });
      }),
    } as unknown as LockManager;
    const lockCtrl = new SessionController({
      getLocalStorage: () => lockLocal,
      getSessionStorage: () => lockSess,
      getLocks: () => locks,
      runBackground: (p) => {
        lockTasks.push(p);
      },
      onForgetHostUiChange: onForgetUi,
    });
    writePersistedHostToken(lockLocal, "ABCD2345", "creator-tok");
    lockCtrl.forgetCreatorHostToken("ABCD2345", "wrong-tok");
    expect(lockCtrl.hasSavedCreatorHostFor("ABCD2345")).toBe(true);
    expect(lockCtrl.hostTokenFor("ABCD2345")).toBe("creator-tok");
    while (pendingReleases.length > 0) pendingReleases.shift()?.();
    await Promise.all(lockTasks.splice(0));
    expect(readPersistedHostToken(lockLocal, "ABCD2345")).toBe("creator-tok");

    // Pending async LockManager: forgetAllHostTokens keeps non-host keys and suppresses persisted lookup until resolved
    lockCtrl.writeSession("activeRoom", "ABCD2345");
    lockCtrl.writeSession("host:ABCD2345", "legacy-host");
    onForgetUi.mockClear();
    lockCtrl.forgetAllHostTokens();
    expect(onForgetUi).toHaveBeenCalledTimes(1);
    expect(lockCtrl.readSession("activeRoom")).toBe("ABCD2345");
    expect(lockCtrl.readSession("host:ABCD2345")).toBeUndefined();
    expect(lockCtrl.hasAnySavedCreatorHosts()).toBe(false);
    expect(lockCtrl.hostTokenFor("ABCD2345")).toBeUndefined();
    while (pendingReleases.length > 0) pendingReleases.shift()?.();
    await Promise.all(lockTasks.splice(0));
    expect(onForgetUi).toHaveBeenCalledTimes(2);
    writePersistedHostToken(lockLocal, "WXYZ2345", "new-creator-tok");
    expect(lockCtrl.hasAnySavedCreatorHosts()).toBe(true);

    // Transient notice timer replacement cancels prior timer and clear/dismiss clear all timers
    const { ctrl: timerCtrl } = makeController();
    timerCtrl.selfId = "self1";
    timerCtrl.lastJoinCode = "ABCD2345";
    const onShow = vi.fn();
    const onExpire1 = vi.fn();
    const onExpire2 = vi.fn();
    timerCtrl.showTransientNotice("Same", onShow, onExpire1, 3000);
    vi.advanceTimersByTime(2000);
    timerCtrl.showTransientNotice("Same", onShow, onExpire2, 3000);
    vi.advanceTimersByTime(1500);
    expect(onExpire1).not.toHaveBeenCalled();
    expect(onExpire2).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(onExpire2).toHaveBeenCalledWith("Same");
    expect(timerCtrl.currentTransientNotice).toBeNull();

    timerCtrl.showTransientNotice("Temp", onShow, vi.fn(), 3000);
    expect(vi.getTimerCount()).toBe(1);
    const onRestore = vi.fn();
    timerCtrl.dismissTransientNotice("Temp", false, onRestore);
    expect(onRestore).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    timerCtrl.selfId = null;
    timerCtrl.showTransientNotice("Temp2", onShow, vi.fn(), 3000);
    timerCtrl.dismissTransientNotice("Temp2", true, onRestore);
    expect(onRestore).not.toHaveBeenCalled();

    timerCtrl.selfId = "self1";
    timerCtrl.lastJoinCode = null;
    timerCtrl.showTransientNotice("Temp3", onShow, vi.fn(), 3000);
    timerCtrl.dismissTransientNotice("Temp3", true, onRestore);
    expect(onRestore).not.toHaveBeenCalled();

    timerCtrl.showTransientNotice("Temp4", onShow, vi.fn(), 3000);
    expect(vi.getTimerCount()).toBe(1);
    timerCtrl.clearTransientNoticeState();
    expect(vi.getTimerCount()).toBe(0);

    // Host/locked state preservation branches
    const { ctrl: stateCtrl, tasks: stateTasks } = makeController();
    stateCtrl.saveCreatorHostToken("ABCD2345", "creator-tok");
    await Promise.all(stateTasks);
    stateCtrl.isHost = true;
    stateCtrl.roomLocked = true;
    stateCtrl.roomPassword = "HOSTPASS12345678";
    stateCtrl.applyRoomState(true);
    expect(stateCtrl.roomPassword).toBe("HOSTPASS12345678");
    stateCtrl.applyRoomState(false);
    expect(stateCtrl.roomPassword).toBe("HOSTPASS12345678");
    stateCtrl.applyRoomPassword("ABCD2345", undefined, undefined);
    expect(stateCtrl.roomPassword).toBe("HOSTPASS12345678");

    stateCtrl.selfId = "self1";
    stateCtrl.isHost = false;
    stateCtrl.applyHostPromoted("ABCD2345", "otherPeer", "other-tok", "OTHERPASS1234567");
    expect(stateCtrl.isHost).toBe(false);
    expect(stateCtrl.roomPassword).toBe("HOSTPASS12345678");
    expect(stateCtrl.hostTokenFor("ABCD2345")).toBe("creator-tok");

    const welcomeRes = stateCtrl.applyWelcomeCredentials(
      "ABCD2345",
      { host: true, locked: true },
      "wrong-tok",
    );
    expect(welcomeRes.hideInvite).toBe(false);
    expect(stateCtrl.roomPassword).toBe("HOSTPASS12345678");

    // applyFatalErrorCleanup invokes onForgetHostUiChange when kicked without lastPresentedHostToken
    const onKickUi = vi.fn();
    const { ctrl: fatalCtrl } = makeController({ onForgetHostUiChange: onKickUi });
    fatalCtrl.applyFatalErrorCleanup("ABCD2345", "kicked", true, undefined);
    expect(onKickUi).toHaveBeenCalledTimes(1);

    // resolveBootAction with saved activeRoom during hashchange vs empty boot with no activeRoom
    const { ctrl: bootCtrl } = makeController();
    expect(bootCtrl.resolveBootAction("", false, { active: false, fatal: false, ready: false })).toEqual({
      kind: "none",
    });
    bootCtrl.saveActiveRoom("ABCD2345");
    bootCtrl.saveRejoinToken("ABCD2345", "rj-1");
    expect(bootCtrl.resolveBootAction("", true, { active: false, fatal: false, ready: false })).toEqual({
      kind: "none",
    });
  });
});

