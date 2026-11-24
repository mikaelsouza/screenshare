import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteController } from "@src/controllers/invite-controller";
import { PopoverToastController } from "@src/controllers/popover-toast-controller";
import { RecentRoomsController } from "@src/controllers/recent-rooms-controller";
import { SessionController } from "@src/controllers/session-controller";
import { HOST_ROOMS_STORAGE_KEY } from "@src/host-tokens";
import { RECENT_ROOMS_OPT_OUT_KEY, RECENT_ROOMS_STORAGE_KEY } from "@src/recent-rooms";
import type { SignalingClient } from "@src/signaling";
import type { UiElements } from "@src/views/dom";
import { bindAllDomEvents, type DomEventsContext } from "@src/views/dom-events";
import type { TileView } from "@src/views/tile-view";

type Listener = (ev?: unknown) => unknown;

function makeFakeElement() {
  const listeners = new Map<string, Listener[]>();
  return {
    value: "",
    disabled: false,
    addEventListener: vi.fn((type: string, fn: Listener) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    }),
    dispatch: (type: string, ev?: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    },
    focus: vi.fn(),
    blur: vi.fn(),
  };
}

class FakeElement {
  private readonly isAnchor: boolean;
  constructor(isAnchor = false) {
    this.isAnchor = isAnchor;
  }
  closest(selector: string): Element | null {
    return this.isAnchor && selector === ".popover-anchor" ? (this as unknown as Element) : null;
  }
}

function makeFakeTarget() {
  const listeners = new Map<string, Listener[]>();
  return {
    hidden: false,
    addEventListener: vi.fn((type: string, fn: Listener) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    }),
    dispatch: (type: string, ev?: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    },
  };
}

function setupDomEvents(opts?: {
  storedName?: string | null;
  throwingStorage?: boolean;
  client?: Partial<SignalingClient> | null;
  sharing?: boolean;
  focusedAndVisible?: boolean;
}) {
  const docTarget = makeFakeTarget();
  const winTarget = makeFakeTarget();
  const storageValues = new Map<string, string>();
  if (opts?.storedName) storageValues.set("name", opts.storedName);

  if (opts?.throwingStorage) {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  } else {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storageValues.get(k) ?? null,
      setItem: (k: string, v: string) => storageValues.set(k, v),
      removeItem: (k: string) => storageValues.delete(k),
    });
  }

  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("document", docTarget);
  vi.stubGlobal("window", winTarget);
  vi.stubGlobal("location", { origin: "https://screenshare.example" });

  const session = new SessionController({
    getLocalStorage: () => null,
    getSessionStorage: () => null,
    getLocks: () => null,
    runBackground: vi.fn(),
    onForgetHostUiChange: vi.fn(),
  });
  const recentRooms = new RecentRoomsController({
    getLocalStorage: () => null,
    getLocks: () => null,
    runBackground: vi.fn(),
    hasSavedCreatorHostFor: () => false,
    onRemoveHostToken: vi.fn(),
    onForgetAllHostTokens: vi.fn(),
    onChange: vi.fn(),
  });
  const invite = new InviteController({ onChange: vi.fn() });
  const popovers = new PopoverToastController({ onJoinChipChange: vi.fn() });

  const uiElements = {
    inviteBtn: makeFakeElement(),
    inviteShowBtn: makeFakeElement(),
    inviteCopyLinkBtn: makeFakeElement(),
    inviteCopyCodeBtn: makeFakeElement(),
    inviteForgetHostBtn: makeFakeElement(),
    inviteRotateBtn: makeFakeElement(),
    rosterBtn: makeFakeElement(),
    lockBtn: makeFakeElement(),
    brandHomeBtn: makeFakeElement(),
    nameInput: makeFakeElement(),
    roomNameInput: makeFakeElement(),
    roomInput: makeFakeElement(),
    joinBtn: makeFakeElement(),
    createBtn: makeFakeElement(),
    shareBtn: makeFakeElement(),
  };

  let client: SignalingClient | null = (opts?.client ?? null) as SignalingClient | null;
  let sharing = opts?.sharing ?? false;
  const focusedAndVisible = opts?.focusedAndVisible ?? true;
  const backgroundTasks: Promise<unknown>[] = [];
  const renderAllControls = vi.fn();

  const ctx: DomEventsContext = {
    controllers: { session, recentRooms, invite, popovers },
    views: {
      ui: uiElements as unknown as UiElements,
      tileView: { renderAllControls } as unknown as TileView,
    },
    state: {
      getClient: () => client,
      isSharing: () => sharing,
      isFocusedAndVisible: () => focusedAndVisible,
      currentName: () => "Alice",
    },
    actions: {
      runBackground: vi.fn((task: Promise<unknown>) => {
        backgroundTasks.push(task);
      }),
      setStatus: vi.fn(),
      setLobbyError: vi.fn(),
      setLobbyNotice: vi.fn(),
      showTransientRoomNotice: vi.fn(),
      dismissTransientRoomNotice: vi.fn(),
      togglePopover: vi.fn(),
      closeAllPopovers: vi.fn(),
      renderInviteMenu: vi.fn(),
      renderJoinChip: vi.fn(),
      renderRoster: vi.fn(),
      scrubRoomUrl: vi.fn(),
      startSharing: vi.fn().mockResolvedValue(undefined),
      stopSharing: vi.fn().mockResolvedValue(undefined),
      enterInvite: vi.fn().mockResolvedValue(undefined),
      joinRoom: vi.fn().mockResolvedValue(undefined),
      leaveRoom: vi.fn(),
      syncNameInputs: vi.fn(),
      joinFromBootOrHash: vi.fn(),
    },
  };

  bindAllDomEvents(ctx);
  return {
    ui: uiElements,
    docTarget,
    winTarget,
    session,
    recentRooms,
    invite,
    popovers,
    ctx,
    renderAllControls,
    setClient: (next: SignalingClient | null) => {
      client = next;
    },
    setSharing: (next: boolean) => {
      sharing = next;
    },
    flushBackground: () => Promise.all(backgroundTasks.splice(0)),
  };
}

describe("bindAllDomEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("succeeds on boot and leaves name inputs empty when localStorage.getItem throws SecurityError", () => {
    const setup = setupDomEvents({ throwingStorage: true });
    expect(setup.ui.nameInput.value).toBe("");
    expect(setup.ui.roomNameInput.value).toBe("");
  });

  it("handles copyInvite guards, clipboard failures, password rotation races, and happy paths", async () => {
    const setup = setupDomEvents();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    // Missing room/password or locked room -> no-op
    setup.ui.inviteCopyLinkBtn.dispatch("click");
    setup.session.lastJoinCode = "ABCD2345";
    setup.session.roomPassword = "SECRET1234";
    setup.session.roomLocked = true;
    setup.ui.inviteCopyLinkBtn.dispatch("click");
    await setup.flushBackground();
    expect(writeText).not.toHaveBeenCalled();

    // Happy path copy link
    setup.session.roomLocked = false;
    const spyFeedback = vi.spyOn(setup.invite, "showCopyFeedback");
    setup.ui.inviteCopyLinkBtn.dispatch("click");
    await setup.flushBackground();
    expect(writeText).toHaveBeenCalledWith("https://screenshare.example/#ABCD2345-SECRET1234");
    expect(setup.ctx.actions.dismissTransientRoomNotice).toHaveBeenCalledTimes(1);
    expect(spyFeedback).toHaveBeenCalledWith("link");

    // Stale joinGeneration while copying -> aborts before feedback/status
    let resolveCopy!: () => void;
    writeText.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveCopy = resolve; }),
    );
    setup.ui.inviteCopyCodeBtn.dispatch("click");
    setup.session.joinGeneration++;
    resolveCopy();
    await setup.flushBackground();
    expect(spyFeedback).toHaveBeenCalledTimes(1);

    // Password rotated during copy -> shows transient notice instead of copy feedback
    writeText.mockImplementationOnce(async () => {
      setup.session.roomPassword = "NEWPASSWORD1";
    });
    setup.ui.inviteCopyLinkBtn.dispatch("click");
    await setup.flushBackground();
    expect(setup.ctx.actions.showTransientRoomNotice).toHaveBeenCalledWith(
      expect.stringContaining("rotated while copying"),
    );

    // Clipboard failure -> warns and auto-opens invite popover on "link"
    writeText.mockRejectedValue(new Error("denied"));
    setup.ui.inviteCopyLinkBtn.dispatch("click");
    await setup.flushBackground();
    expect(setup.ctx.actions.setStatus).toHaveBeenCalledWith(expect.stringContaining("Could not copy"), "warn");
    expect(setup.ctx.actions.togglePopover).toHaveBeenCalledWith("invite");
  });

  it("handles lobby join validation, room creation, and error recovery", async () => {
    const setup = setupDomEvents();

    // Invalid invite focuses roomInput
    setup.ui.roomInput.value = "bad";
    setup.ui.joinBtn.dispatch("click");
    await setup.flushBackground();
    expect(setup.ctx.actions.setLobbyError).toHaveBeenCalled();
    expect(setup.ui.roomInput.focus).toHaveBeenCalledTimes(1);

    // Input clears error/notice and Enter submits valid invite
    setup.ui.roomInput.dispatch("input");
    expect(setup.ctx.actions.setLobbyNotice).toHaveBeenCalledWith(null);

    const preventDefault = vi.fn();
    setup.ui.roomInput.value = "ABCD2345-ABCDEFGHJKMNPQRS";
    setup.ui.roomInput.dispatch("keydown", { key: "Enter", preventDefault });
    await setup.flushBackground();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(setup.ctx.actions.enterInvite).toHaveBeenCalledWith("ABCD2345", "ABCDEFGHJKMNPQRS");

    // Create room: HTTP error re-enables button
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);
    setup.ui.createBtn.dispatch("click");
    expect(setup.ui.createBtn.disabled).toBe(true);
    // Double-click ignored while disabled
    setup.ui.createBtn.dispatch("click");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await setup.flushBackground();
    expect(setup.ui.createBtn.disabled).toBe(false);
    expect(setup.ctx.actions.setLobbyError).toHaveBeenCalledWith(expect.stringContaining("Could not create a room"));

    // Create room: success saves session vs creator host token based on opt-out and clears previous room
    setup.session.lastJoinCode = "EFGH6789";
    const clearSpy = vi.spyOn(setup.session, "clearRoomSession");
    const creatorSpy = vi.spyOn(setup.session, "saveCreatorHostToken");
    const sessionHostSpy = vi.spyOn(setup.session, "saveSessionHostToken");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: "JKMN2345", password: "ABCDEFGHJKMNPQRT", hostToken: "tok-1" }),
    });
    setup.ui.createBtn.dispatch("click");
    await setup.flushBackground();
    expect(clearSpy).toHaveBeenCalledWith("EFGH6789");
    expect(creatorSpy).toHaveBeenCalledWith("JKMN2345", "tok-1");
    expect(setup.ctx.actions.joinRoom).toHaveBeenCalledWith("JKMN2345", "ABCDEFGHJKMNPQRT");

    // With opt-out enabled, saves in-memory session host token instead of localStorage creator token
    setup.recentRooms.setDisabled(true);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: "PQRS6789", password: "ABCDEFGHJKMNPQRU", hostToken: "tok-2" }),
    });
    setup.ui.createBtn.dispatch("click");
    await setup.flushBackground();
    expect(sessionHostSpy).toHaveBeenCalledWith("PQRS6789", "tok-2");

    // Stale joinGeneration aborts before joining
    fetchMock.mockImplementationOnce(async () => {
      setup.session.joinGeneration++;
      return {
        ok: true,
        json: async () => ({ code: "TUVW2345", password: "ABCDEFGHJKMNPQRV", hostToken: "tok-3" }),
      };
    });
    setup.ui.createBtn.dispatch("click");
    await setup.flushBackground();
    expect(setup.ctx.actions.joinRoom).not.toHaveBeenCalledWith("TUVW2345", "ABCDEFGHJKMNPQRV");
  });

  it("wires invite, roster, lock, navigation, name, and share controls", async () => {
    const rotatePassword = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const setLocked = vi.fn();
    const rename = vi.fn();
    const setup = setupDomEvents({
      storedName: "Bob",
      client: { rotatePassword, setLocked, rename },
    });
    expect(setup.ui.nameInput.value).toBe("Bob");

    // Show toggle & forget host
    setup.session.lastJoinCode = "ABCD2345";
    setup.session.roomPassword = "PASSWORD12";
    setup.ui.inviteShowBtn.dispatch("click");
    expect(setup.invite.isRevealed).toBe(true);
    setup.ui.inviteForgetHostBtn.dispatch("click");
    expect(setup.ctx.actions.closeAllPopovers).toHaveBeenCalled();

    // Rotate password false -> renders menu; true -> beginRotate
    setup.session.isHost = true;
    setup.ui.inviteRotateBtn.dispatch("click");
    expect(setup.ctx.actions.renderInviteMenu).toHaveBeenCalledTimes(1);
    setup.ui.inviteRotateBtn.dispatch("click");
    expect(setup.invite.isRotatePending).toBe(true);

    // Roster, lock, name inputs, share toggle, brandHome
    setup.ui.rosterBtn.dispatch("click");
    expect(setup.ctx.actions.togglePopover).toHaveBeenCalledWith("roster");
    setup.ui.lockBtn.dispatch("click");
    expect(setLocked).toHaveBeenCalledWith(true);

    const preventDefault = vi.fn();
    setup.ui.roomNameInput.dispatch("keydown", { key: "Enter", preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(setup.ui.roomNameInput.blur).toHaveBeenCalled();
    setup.session.selfId = "peer-1";
    setup.ui.roomNameInput.value = "Carol";
    setup.ui.roomNameInput.dispatch("change");
    expect(rename).toHaveBeenCalledWith("Alice");

    setup.ui.shareBtn.dispatch("click");
    setup.setSharing(true);
    setup.ui.shareBtn.dispatch("click");
    await setup.flushBackground();
    expect(setup.ctx.actions.startSharing).toHaveBeenCalledTimes(1);
    expect(setup.ctx.actions.stopSharing).toHaveBeenCalledTimes(1);

    setup.ui.brandHomeBtn.dispatch("click");
    expect(setup.ctx.actions.leaveRoom).toHaveBeenCalledTimes(1);
    setup.setClient(null);
    setup.setSharing(false);
    setup.session.lastJoinCode = null;
    setup.ui.brandHomeBtn.dispatch("click");
    expect(setup.ctx.actions.leaveRoom).toHaveBeenCalledTimes(1);
  });

  it("handles window, document popover dismissal, and cross-tab storage sync events", () => {
    const setup = setupDomEvents();
    const syncCreatorSpy = vi.spyOn(setup.session, "syncCreatorTokensFromStorage");
    const syncRecentSpy = vi.spyOn(setup.recentRooms, "syncFromStorage");
    const hideSpy = vi.spyOn(setup.invite, "hideIfRevealed");

    setup.docTarget.dispatch("fullscreenchange");
    expect(setup.renderAllControls).toHaveBeenCalledTimes(1);
    expect(setup.ctx.actions.renderJoinChip).toHaveBeenCalledTimes(1);

    setup.winTarget.dispatch("blur");
    expect(hideSpy).toHaveBeenCalledTimes(1);
    setup.winTarget.dispatch("focus");
    setup.docTarget.hidden = true;
    setup.docTarget.dispatch("visibilitychange");
    expect(hideSpy).toHaveBeenCalledTimes(2);
    setup.docTarget.hidden = false;
    setup.docTarget.dispatch("visibilitychange");

    // Popover close on outside click & Escape; inside .popover-anchor stays open
    setup.popovers.applyPopover("invite", true, false);
    setup.docTarget.dispatch("click", { target: new FakeElement(true) });
    expect(setup.ctx.actions.closeAllPopovers).not.toHaveBeenCalled();
    setup.docTarget.dispatch("click", { target: new FakeElement(false) });
    expect(setup.ctx.actions.closeAllPopovers).toHaveBeenCalledTimes(1);
    setup.docTarget.dispatch("keydown", { key: "Escape" });
    expect(setup.ctx.actions.closeAllPopovers).toHaveBeenCalledTimes(2);

    // Storage filtering
    setup.winTarget.dispatch("storage", { key: "unrelated-key" });
    expect(syncRecentSpy).not.toHaveBeenCalled();
    setup.winTarget.dispatch("storage", { key: RECENT_ROOMS_STORAGE_KEY });
    expect(syncRecentSpy).toHaveBeenCalledTimes(1);
    expect(syncCreatorSpy).not.toHaveBeenCalled();
    setup.winTarget.dispatch("storage", { key: RECENT_ROOMS_OPT_OUT_KEY });
    expect(syncRecentSpy).toHaveBeenCalledTimes(2);
    setup.winTarget.dispatch("storage", { key: HOST_ROOMS_STORAGE_KEY });
    expect(syncCreatorSpy).toHaveBeenCalledTimes(1);
    setup.winTarget.dispatch("storage", { key: null });
    expect(syncCreatorSpy).toHaveBeenCalledTimes(2);

    setup.winTarget.dispatch("beforeunload");
    setup.winTarget.dispatch("pagehide");
    expect(setup.ctx.actions.leaveRoom).toHaveBeenCalledTimes(2);
    setup.winTarget.dispatch("hashchange");
    expect(setup.ctx.actions.joinFromBootOrHash).toHaveBeenCalledWith(true);
  });
});
