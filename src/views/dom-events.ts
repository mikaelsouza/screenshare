import {
  formatInviteCode,
  parseInviteInput,
  parseNewRoomResponse,
} from "@shared/protocol";
import type { InviteController } from "../controllers/invite-controller";
import type { PopoverToastController } from "../controllers/popover-toast-controller";
import type { RecentRoomsController } from "../controllers/recent-rooms-controller";
import type { SessionController } from "../controllers/session-controller";
import { HOST_ROOMS_STORAGE_KEY } from "../host-tokens";
import { RECENT_ROOMS_OPT_OUT_KEY, RECENT_ROOMS_STORAGE_KEY } from "../recent-rooms";
import type { SignalingClient } from "../signaling";
import { describeInviteParseFailure, type PopoverKind } from "../ui-model";
import { readStoredName, type UiElements } from "./dom";
import { copyTextToClipboard } from "./roster-view";
import type { TileView } from "./tile-view";

export interface DomEventsContext {
  controllers: {
    session: SessionController;
    recentRooms: RecentRoomsController;
    invite: InviteController;
    popovers: PopoverToastController;
  };
  views: {
    ui: UiElements;
    tileView: TileView;
  };
  state: {
    getClient: () => SignalingClient | null;
    isSharing: () => boolean;
    isFocusedAndVisible: () => boolean;
    currentName: () => string;
  };
  actions: {
    runBackground: (task: Promise<unknown>) => void;
    setStatus: (text: string, kind?: "info" | "warn" | "error") => void;
    setLobbyError: (message: string | null) => void;
    setLobbyNotice: (message: string | null) => void;
    showTransientRoomNotice: (message: string) => void;
    dismissTransientRoomNotice: () => void;
    togglePopover: (which: PopoverKind) => void;
    closeAllPopovers: () => void;
    renderInviteMenu: () => void;
    renderJoinChip: () => void;
    renderRoster: () => void;
    scrubRoomUrl: () => void;
    startSharing: () => Promise<void>;
    stopSharing: () => Promise<void>;
    enterInvite: (code: string, password: string) => Promise<void>;
    joinRoom: (code: string, initialPassword?: string) => Promise<void>;
    leaveRoom: () => void;
    syncNameInputs: (value: string) => void;
    joinFromBootOrHash: (isHashChange: boolean) => void;
  };
}

async function copyInvite(ctx: DomEventsContext, mode: "link" | "code"): Promise<void> {
  const { session, invite, popovers } = ctx.controllers;
  const { actions } = ctx;
  const code = session.lastJoinCode;
  const password = session.roomPassword;
  if (!code || !password || session.roomLocked) return;
  const gen = session.joinGeneration;
  const inviteCode = formatInviteCode(code, password);
  const text = mode === "link" ? `${location.origin}/#${inviteCode}` : inviteCode;
  const copied = await copyTextToClipboard(text);
  if (gen !== session.joinGeneration || session.lastJoinCode !== code) return;
  if (!copied) {
    session.clearTransientNoticeState();
    actions.setStatus("Could not copy automatically. Use Show to view and copy manually.", "warn");
    if (mode === "link" && popovers.activePopover !== "invite") actions.togglePopover("invite");
    return;
  }
  if (session.roomLocked || invite.isRotatePending) return;
  if (session.roomPassword !== password) {
    actions.showTransientRoomNotice("Invite link rotated while copying \u2014 click Copy invite link again.");
    return;
  }
  actions.dismissTransientRoomNotice();
  invite.showCopyFeedback(mode);
}

async function submitLobbyJoin(ctx: DomEventsContext): Promise<void> {
  const { ui } = ctx.views;
  const { actions } = ctx;
  const parsed = parseInviteInput(ui.roomInput.value);
  if (!parsed.ok) {
    actions.setLobbyError(describeInviteParseFailure(parsed.reason));
    ui.roomInput.focus();
    return;
  }
  actions.setLobbyError(null);
  actions.setLobbyNotice(null);
  await actions.enterInvite(parsed.code, parsed.password);
}

async function handleCreateRoom(ctx: DomEventsContext): Promise<void> {
  const { ui } = ctx.views;
  const { session, recentRooms } = ctx.controllers;
  const { actions } = ctx;
  const genBeforeFetch = session.joinGeneration;
  try {
    const res = await fetch("/api/room", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseNewRoomResponse(await res.json());
    if (!parsed) throw new Error("server returned an invalid room response");
    if (genBeforeFetch !== session.joinGeneration) return;
    const { code, password, hostToken } = parsed;
    const previous = session.lastJoinCode ?? session.activeRoomFor();
    if (previous && previous !== code) session.clearRoomSession(previous);
    session.saveActiveRoom(code);
    if (recentRooms.isDisabled()) {
      session.saveSessionHostToken(code, hostToken);
    } else {
      session.saveCreatorHostToken(code, hostToken);
    }
    ui.roomInput.value = "";
    actions.scrubRoomUrl();
    await actions.joinRoom(code, password);
  } catch (err) {
    console.error("[main] could not create a room", err);
    actions.setLobbyError("Could not create a room. Check your connection and try again.");
  } finally {
    ui.createBtn.disabled = false;
  }
}

function bindInviteAndRosterEvents(ctx: DomEventsContext): void {
  const { ui } = ctx.views;
  const { session, recentRooms, invite } = ctx.controllers;
  const { state, actions } = ctx;
  ui.inviteBtn.addEventListener("click", () => actions.togglePopover("invite"));
  ui.inviteShowBtn.addEventListener("click", () => {
    if (session.roomLocked || !session.roomPassword) return;
    invite.setRevealed(!invite.isRevealed);
  });
  ui.inviteCopyLinkBtn.addEventListener("click", () => actions.runBackground(copyInvite(ctx, "link")));
  ui.inviteCopyCodeBtn.addEventListener("click", () => actions.runBackground(copyInvite(ctx, "code")));
  ui.inviteForgetHostBtn.addEventListener("click", () => {
    const code = session.lastJoinCode;
    if (!code) return;
    session.forgetCreatorHostToken(code);
    recentRooms.handleCreatorHostForgotten(code);
    actions.closeAllPopovers();
    actions.showTransientRoomNotice("Removed saved host access for this room on this device.");
  });
  ui.inviteRotateBtn.addEventListener("click", () => {
    const client = state.getClient();
    if (!client || !session.isHost || !session.lastJoinCode || invite.isRotatePending) return;
    invite.setRevealed(false);
    if (!client.rotatePassword()) {
      actions.renderInviteMenu();
      return;
    }
    invite.beginRotate();
  });
  ui.rosterBtn.addEventListener("click", () => actions.togglePopover("roster"));
  ui.lockBtn.addEventListener("click", () => state.getClient()?.setLocked(!session.roomLocked));
}

function bindLobbyAndNavEvents(ctx: DomEventsContext): void {
  const { ui } = ctx.views;
  const { session } = ctx.controllers;
  const { state, actions } = ctx;
  ui.brandHomeBtn.addEventListener("click", () => {
    if (!state.getClient() && !session.lastJoinCode && !state.isSharing()) return;
    actions.closeAllPopovers();
    actions.runBackground(actions.stopSharing());
    session.clearRoomSession();
    session.lastJoinCode = null;
    actions.leaveRoom();
    actions.scrubRoomUrl();
    actions.setLobbyError(null);
    actions.setLobbyNotice(null);
    actions.setStatus("", "info");
  });

  const initialStoredName = readStoredName() ?? "";
  ui.nameInput.value = initialStoredName;
  ui.roomNameInput.value = initialStoredName;
  ui.nameInput.addEventListener("change", () => actions.syncNameInputs(ui.nameInput.value));
  ui.roomNameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      ui.roomNameInput.blur();
    }
  });
  ui.roomNameInput.addEventListener("change", () => {
    actions.syncNameInputs(ui.roomNameInput.value);
    const client = state.getClient();
    if (client && session.selfId !== null) client.rename(state.currentName());
  });

  ui.roomInput.addEventListener("input", () => {
    actions.setLobbyError(null);
    actions.setLobbyNotice(null);
  });
  ui.joinBtn.addEventListener("click", () => actions.runBackground(submitLobbyJoin(ctx)));
  ui.roomInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    actions.runBackground(submitLobbyJoin(ctx));
  });
  ui.createBtn.addEventListener("click", () => {
    if (ui.createBtn.disabled) return;
    actions.setLobbyError(null);
    actions.setLobbyNotice(null);
    ui.createBtn.disabled = true;
    actions.runBackground(handleCreateRoom(ctx));
  });
  ui.shareBtn.addEventListener("click", () => {
    actions.runBackground(state.isSharing() ? actions.stopSharing() : actions.startSharing());
  });
}

function bindWindowAndDocumentEvents(ctx: DomEventsContext): void {
  const { session, recentRooms, invite, popovers } = ctx.controllers;
  const { tileView } = ctx.views;
  const { state, actions } = ctx;
  document.addEventListener("fullscreenchange", () => {
    tileView.renderAllControls();
    actions.renderJoinChip();
  });
  window.addEventListener("blur", () => {
    popovers.pauseJoinChipTimer();
    invite.hideIfRevealed();
  });
  window.addEventListener("focus", () => {
    popovers.armJoinChipTimer(state.isFocusedAndVisible());
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      popovers.pauseJoinChipTimer();
      invite.hideIfRevealed();
      return;
    }
    popovers.armJoinChipTimer(state.isFocusedAndVisible());
  });
  document.addEventListener("click", (ev) => {
    if (popovers.activePopover === null) return;
    if (ev.target instanceof Element && ev.target.closest(".popover-anchor")) return;
    actions.closeAllPopovers();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && popovers.activePopover !== null) actions.closeAllPopovers();
  });
  window.addEventListener("beforeunload", () => actions.leaveRoom());
  window.addEventListener("pagehide", () => actions.leaveRoom());
  window.addEventListener("hashchange", () => actions.joinFromBootOrHash(true));
  window.addEventListener("storage", (ev) => {
    if (
      ev.key !== HOST_ROOMS_STORAGE_KEY &&
      ev.key !== RECENT_ROOMS_STORAGE_KEY &&
      ev.key !== RECENT_ROOMS_OPT_OUT_KEY &&
      ev.key !== null
    ) {
      return;
    }
    if (ev.key === HOST_ROOMS_STORAGE_KEY || ev.key === null) {
      session.syncCreatorTokensFromStorage();
    }
    recentRooms.syncFromStorage();
  });
}

export function bindAllDomEvents(ctx: DomEventsContext): void {
  bindInviteAndRosterEvents(ctx);
  bindLobbyAndNavEvents(ctx);
  bindWindowAndDocumentEvents(ctx);
}
