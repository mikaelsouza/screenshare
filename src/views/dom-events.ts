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
import type { UiElements } from "./dom";
import { copyTextToClipboard } from "./roster-view";
import type { TileView } from "./tile-view";

export interface DomEventsContext {
  ui: UiElements;
  session: SessionController;
  recentRooms: RecentRoomsController;
  invite: InviteController;
  popovers: PopoverToastController;
  tileView: TileView;
  getClient: () => SignalingClient | null;
  isSharing: () => boolean;
  isFocusedAndVisible: () => boolean;
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
  currentName: () => string;
  syncNameInputs: (value: string) => void;
  joinFromBootOrHash: (isHashChange: boolean) => void;
}

async function copyInvite(ctx: DomEventsContext, mode: "link" | "code"): Promise<void> {
  const { session, invite } = ctx;
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
    ctx.setStatus("Could not copy automatically. Use Show to view and copy manually.", "warn");
    if (mode === "link" && ctx.popovers.activePopover !== "invite") ctx.togglePopover("invite");
    return;
  }
  if (session.roomLocked || invite.isRotatePending) return;
  if (session.roomPassword !== password) {
    ctx.showTransientRoomNotice("Invite link rotated while copying \u2014 click Copy invite link again.");
    return;
  }
  ctx.dismissTransientRoomNotice();
  invite.showCopyFeedback(mode);
}

async function submitLobbyJoin(ctx: DomEventsContext): Promise<void> {
  const parsed = parseInviteInput(ctx.ui.roomInput.value);
  if (!parsed.ok) {
    ctx.setLobbyError(describeInviteParseFailure(parsed.reason));
    ctx.ui.roomInput.focus();
    return;
  }
  ctx.setLobbyError(null);
  ctx.setLobbyNotice(null);
  await ctx.enterInvite(parsed.code, parsed.password);
}

async function handleCreateRoom(ctx: DomEventsContext): Promise<void> {
  const { ui, session, recentRooms } = ctx;
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
    ctx.scrubRoomUrl();
    await ctx.joinRoom(code, password);
  } catch (err) {
    console.error("[main] could not create a room", err);
    ctx.setLobbyError("Could not create a room. Check your connection and try again.");
  } finally {
    ui.createBtn.disabled = false;
  }
}

function bindInviteAndRosterEvents(ctx: DomEventsContext): void {
  const { ui, session, invite } = ctx;
  ui.inviteBtn.addEventListener("click", () => ctx.togglePopover("invite"));
  ui.inviteShowBtn.addEventListener("click", () => {
    if (session.roomLocked || !session.roomPassword) return;
    invite.setRevealed(!invite.isRevealed);
  });
  ui.inviteCopyLinkBtn.addEventListener("click", () => ctx.runBackground(copyInvite(ctx, "link")));
  ui.inviteCopyCodeBtn.addEventListener("click", () => ctx.runBackground(copyInvite(ctx, "code")));
  ui.inviteForgetHostBtn.addEventListener("click", () => {
    const code = session.lastJoinCode;
    if (!code) return;
    session.forgetCreatorHostToken(code);
    ctx.recentRooms.handleCreatorHostForgotten(code);
    ctx.closeAllPopovers();
    ctx.showTransientRoomNotice("Removed saved host access for this room on this device.");
  });
  ui.inviteRotateBtn.addEventListener("click", () => {
    const client = ctx.getClient();
    if (!client || !session.isHost || !session.lastJoinCode || invite.isRotatePending) return;
    invite.setRevealed(false);
    if (!client.rotatePassword()) {
      ctx.renderInviteMenu();
      return;
    }
    invite.beginRotate();
  });
  ui.rosterBtn.addEventListener("click", () => ctx.togglePopover("roster"));
  ui.lockBtn.addEventListener("click", () => ctx.getClient()?.setLocked(!session.roomLocked));
}

function bindLobbyAndNavEvents(ctx: DomEventsContext): void {
  const { ui, session } = ctx;
  ui.brandHomeBtn.addEventListener("click", () => {
    if (!ctx.getClient() && !session.lastJoinCode && !ctx.isSharing()) return;
    ctx.closeAllPopovers();
    ctx.runBackground(ctx.stopSharing());
    session.clearRoomSession();
    session.lastJoinCode = null;
    ctx.leaveRoom();
    ctx.scrubRoomUrl();
    ctx.setLobbyError(null);
    ctx.setLobbyNotice(null);
    ctx.setStatus("", "info");
  });

  const initialStoredName = localStorage.getItem("name") ?? "";
  ui.nameInput.value = initialStoredName;
  ui.roomNameInput.value = initialStoredName;
  ui.nameInput.addEventListener("change", () => ctx.syncNameInputs(ui.nameInput.value));
  ui.roomNameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      ui.roomNameInput.blur();
    }
  });
  ui.roomNameInput.addEventListener("change", () => {
    ctx.syncNameInputs(ui.roomNameInput.value);
    const client = ctx.getClient();
    if (client && session.selfId !== null) client.rename(ctx.currentName());
  });

  ui.roomInput.addEventListener("input", () => {
    ctx.setLobbyError(null);
    ctx.setLobbyNotice(null);
  });
  ui.joinBtn.addEventListener("click", () => ctx.runBackground(submitLobbyJoin(ctx)));
  ui.roomInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    ctx.runBackground(submitLobbyJoin(ctx));
  });
  ui.createBtn.addEventListener("click", () => {
    if (ui.createBtn.disabled) return;
    ctx.setLobbyError(null);
    ctx.setLobbyNotice(null);
    ui.createBtn.disabled = true;
    ctx.runBackground(handleCreateRoom(ctx));
  });
  ui.shareBtn.addEventListener("click", () => {
    ctx.runBackground(ctx.isSharing() ? ctx.stopSharing() : ctx.startSharing());
  });
}

function bindWindowAndDocumentEvents(ctx: DomEventsContext): void {
  const { session, invite, popovers, tileView } = ctx;
  document.addEventListener("fullscreenchange", () => {
    tileView.renderAllControls();
    ctx.renderJoinChip();
  });
  window.addEventListener("blur", () => {
    popovers.pauseJoinChipTimer();
    invite.hideIfRevealed();
  });
  window.addEventListener("focus", () => {
    popovers.armJoinChipTimer(ctx.isFocusedAndVisible());
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      popovers.pauseJoinChipTimer();
      invite.hideIfRevealed();
      return;
    }
    popovers.armJoinChipTimer(ctx.isFocusedAndVisible());
  });
  document.addEventListener("click", (ev) => {
    if (popovers.activePopover === null) return;
    if (ev.target instanceof Element && ev.target.closest(".popover-anchor")) return;
    ctx.closeAllPopovers();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && popovers.activePopover !== null) ctx.closeAllPopovers();
  });
  window.addEventListener("beforeunload", () => ctx.leaveRoom());
  window.addEventListener("pagehide", () => ctx.leaveRoom());
  window.addEventListener("hashchange", () => ctx.joinFromBootOrHash(true));
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
    ctx.recentRooms.syncFromStorage();
  });
}

export function bindAllDomEvents(ctx: DomEventsContext): void {
  bindInviteAndRosterEvents(ctx);
  bindLobbyAndNavEvents(ctx);
  bindWindowAndDocumentEvents(ctx);
}
