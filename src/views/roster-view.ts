import type { PeerId } from "@shared/protocol";
import type { InviteController } from "../controllers/invite-controller";
import type { PopoverToastController } from "../controllers/popover-toast-controller";
import type { SessionController } from "../controllers/session-controller";
import type { TileController } from "../controllers/tile-controller";
import { sortAndFormatRoster, type PopoverKind, type RosterEntry, type RosterSummary } from "../ui-model";
import type { UiElements } from "./dom";

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn("[main] clipboard.writeText failed, using fallback", err);
  }
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    prevFocus?.focus?.({ preventScroll: true });
    return ok;
  } catch {
    prevFocus?.focus?.({ preventScroll: true });
    return false;
  }
}

export function renderInviteMenuView(
  ui: UiElements,
  invite: InviteController,
  session: SessionController,
  activePopover: PopoverKind | null,
  signalingReady: boolean,
): void {
  const code = session.lastJoinCode;
  const state = invite.deriveMenu({
    roomCode: code,
    roomPassword: session.roomPassword,
    roomLocked: session.roomLocked,
    isHost: session.isHost,
    signalingReady,
  });
  const fb = invite.getFeedback();

  ui.inviteMenu.hidden = activePopover !== "invite";
  ui.inviteRotateBtn.hidden = !session.isHost || code === null;
  ui.inviteRotateBtn.disabled = !state.canRotate;
  ui.inviteRotateBtn.textContent = fb.rotateText;
  ui.inviteRotateBtn.classList.toggle("invite-feedback-ok", fb.rotateOk);

  ui.inviteLockedNote.hidden = !state.showLockedBanner;
  ui.inviteCopyLinkBtn.disabled = !state.canCopy;
  ui.inviteCopyLinkBtn.title = state.showLockedBanner
    ? "Room is locked \u2014 unlock to invite"
    : "Copy invite link";
  ui.inviteLinkFeedback.textContent = fb.linkText;
  ui.inviteLinkFeedback.classList.toggle("invite-feedback-ok", fb.linkOk);
  ui.inviteCopyLinkBtn.classList.toggle("invite-feedback-ok", fb.linkOk);

  ui.inviteCodeRow.classList.toggle("is-disabled", !state.canCopy);
  ui.inviteCodeValue.textContent = state.displayCode;
  ui.inviteShowBtn.disabled = !state.canShow;
  ui.inviteShowBtn.textContent = invite.isRevealed && state.canShow ? "Hide" : "Show";
  ui.inviteCopyCodeBtn.disabled = !state.canCopy;
  ui.inviteCopyCodeBtn.textContent = fb.codeText;
  ui.inviteCopyCodeBtn.classList.toggle("invite-feedback-ok", fb.codeOk);
  ui.inviteForgetHostBtn.hidden = !(code !== null && session.hasSavedCreatorHostFor(code));
}

export function renderForgetHostButtons(ui: UiElements, session: SessionController): void {
  ui.lobbyForgetHostsBtn.hidden = !session.hasAnySavedCreatorHosts();
  ui.inviteForgetHostBtn.hidden = !(
    session.lastJoinCode !== null && session.hasSavedCreatorHostFor(session.lastJoinCode)
  );
}

export function renderRosterUnreadDotView(ui: UiElements, popovers: PopoverToastController): void {
  const hasUnread = popovers.hasUnreadDot();
  ui.rosterUnreadDot.hidden = !hasUnread;
  ui.rosterBtn.classList.toggle("has-unread", hasUnread);
}

export class JoinChipView {
  private readonly ui: UiElements;
  private mirror: HTMLElement | null = null;

  constructor(ui: UiElements) {
    this.ui = ui;
  }

  render(text: string): void {
    if (this.mirror) {
      this.mirror.remove();
      this.mirror = null;
    }
    if (!text) {
      this.ui.joinChip.textContent = "";
      this.ui.joinChip.hidden = true;
      return;
    }
    this.ui.joinChip.textContent = text;
    this.ui.joinChip.hidden = false;

    const fsEl = typeof document !== "undefined" ? document.fullscreenElement : null;
    if (fsEl instanceof HTMLElement && fsEl.classList.contains("tile")) {
      const mirror = document.createElement("div");
      mirror.className = "join-chip join-chip-mirror";
      mirror.setAttribute("role", "status");
      mirror.setAttribute("aria-live", "polite");
      mirror.textContent = text;
      fsEl.append(mirror);
      this.mirror = mirror;
    }
  }
}

function makeBadge(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function buildRosterListItem(
  entry: RosterEntry,
  isSharing: boolean,
  tileCtrl: TileController,
  session: SessionController,
  onKick: (entry: RosterEntry, btn: HTMLButtonElement) => void,
): HTMLLIElement {
  const li = document.createElement("li");
  const left = document.createElement("div");
  left.className = "roster-peer";

  const dot = document.createElement("span");
  dot.className = "ui-dot";
  if (entry.sharing) dot.dataset["state"] = "live";
  left.append(dot, makeBadge("peer-name", entry.name));

  if (entry.self) left.append(makeBadge("role-badge", "you"));
  if (entry.host) left.append(makeBadge("role-badge", "host"));
  left.append(makeBadge("peer-id", entry.shortId));
  if (entry.sharing) left.append(makeBadge("badge", "sharing"));
  if (entry.isNew) left.append(makeBadge("tag-new", "new"));
  if (entry.duplicateName) left.append(makeBadge("tag-dup", "same name"));

  const right = document.createElement("div");
  right.className = "roster-meta";
  if (!entry.self) {
    const statsSpan = document.createElement("span");
    statsSpan.className = "peer-stats";
    statsSpan.dataset["peer"] = entry.id;
    statsSpan.textContent = isSharing ? tileCtrl.getPeerOutboundText(entry.id) : "";
    right.append(statsSpan);
  }
  if (entry.canKick) {
    const kick = document.createElement("button");
    kick.type = "button";
    kick.className = "ui-btn kick-btn";
    kick.textContent = "Remove";
    kick.dataset["peer"] = entry.id;
    kick.disabled = session.hasPendingKick(entry.id);
    kick.title = `Remove ${entry.name} from the room and rotate the invite link (blocks their network for 15 minutes).`;
    kick.addEventListener("click", () => onKick(entry, kick));
    right.append(kick);
  }
  li.append(left, right);
  return li;
}

export function renderRosterView(
  ui: UiElements,
  params: {
    connected: boolean;
    selfId: PeerId | null;
    selfName: string;
    isSharing: boolean;
    extraPeerIds: PeerId[];
    session: SessionController;
    popovers: PopoverToastController;
    tileCtrl: TileController;
    onKick: (entry: RosterEntry, btn: HTMLButtonElement) => void;
  },
): void {
  const { connected, selfId, selfName, isSharing, extraPeerIds, session, popovers, tileCtrl, onKick } = params;
  if (!connected || selfId === null) {
    ui.roster.hidden = true;
    ui.rosterList.replaceChildren();
    renderRosterUnreadDotView(ui, popovers);
    return;
  }
  const summary: RosterSummary = sortAndFormatRoster(
    selfId,
    selfName,
    isSharing,
    session.isHost,
    session.roomLocked,
    session.members,
    { newPeerIds: popovers.unreadPeerIds, extraPeerIds },
  );
  ui.roster.hidden = popovers.activePopover !== "roster";
  ui.rosterBtnLabel.textContent = summary.buttonLabel;
  renderRosterUnreadDotView(ui, popovers);
  ui.rosterTitle.textContent = tileCtrl.formatRosterHeaderTitle(summary.totalCount, session.roomLocked, isSharing);
  ui.lockBtn.hidden = !session.isHost;
  ui.lockBtn.textContent = session.roomLocked ? "Unlock room" : "Lock room";

  const activeEl = document.activeElement;
  const focusedKickPeer =
    activeEl instanceof HTMLButtonElement && ui.rosterList.contains(activeEl)
      ? activeEl.dataset["peer"]
      : undefined;

  const items = summary.entries.map((entry) => buildRosterListItem(entry, isSharing, tileCtrl, session, onKick));
  ui.rosterList.replaceChildren(...items);

  if (focusedKickPeer && !ui.roster.hidden) {
    const replacement = [...ui.rosterList.querySelectorAll<HTMLButtonElement>("button")].find(
      (btn) => btn.dataset["peer"] === focusedKickPeer && !btn.disabled,
    );
    if (replacement) replacement.focus();
    else ui.rosterBtn.focus();
  }
}

export function updateRosterStatsInPlaceView(
  ui: UiElements,
  selfId: PeerId,
  distinctPeerIds: Iterable<PeerId>,
  isSharing: boolean,
  roomLocked: boolean,
  tileCtrl: TileController,
): void {
  const peers = new Set<string>(distinctPeerIds);
  peers.delete(selfId);
  ui.rosterTitle.textContent = tileCtrl.formatRosterHeaderTitle(peers.size + 1, roomLocked, isSharing);
  for (const elNode of ui.rosterList.querySelectorAll<HTMLElement>(".peer-stats")) {
    const pid = elNode.dataset["peer"];
    if (!pid) continue;
    elNode.textContent = isSharing ? tileCtrl.getPeerOutboundText(pid) : "";
  }
}

function getPopoverElements(
  ui: UiElements,
  kind: PopoverKind,
): { menu: HTMLElement; trigger: HTMLButtonElement } {
  switch (kind) {
    case "invite":
      return { menu: ui.inviteMenu, trigger: ui.inviteBtn };
    case "roster":
      return { menu: ui.roster, trigger: ui.rosterBtn };
    case "preset":
      return { menu: ui.presetMenu, trigger: ui.presetBtn };
    case "codec":
      return { menu: ui.codecMenu, trigger: ui.codecBtn };
    case "degradation":
      return { menu: ui.degradationMenu, trigger: ui.degradationBtn };
  }
}

export function applyPopoverDom(
  ui: UiElements,
  v: {
    active: PopoverKind | null;
    inviteOpen: boolean;
    rosterOpen: boolean;
    presetOpen: boolean;
    codecOpen: boolean;
    degradationOpen: boolean;
  },
  previous: PopoverKind | null,
): void {
  ui.inviteMenu.hidden = !v.inviteOpen;
  ui.roster.hidden = !v.rosterOpen;
  ui.presetMenu.hidden = !v.presetOpen;
  ui.codecMenu.hidden = !v.codecOpen;
  ui.degradationMenu.hidden = !v.degradationOpen;
  ui.inviteBtn.setAttribute("aria-expanded", String(v.inviteOpen));
  ui.rosterBtn.setAttribute("aria-expanded", String(v.rosterOpen));
  ui.presetBtn.setAttribute("aria-expanded", String(v.presetOpen));
  ui.codecBtn.setAttribute("aria-expanded", String(v.codecOpen));
  ui.degradationBtn.setAttribute("aria-expanded", String(v.degradationOpen));
  if (previous !== null && previous !== v.active) {
    const { menu, trigger } = getPopoverElements(ui, previous);
    if (menu.contains(document.activeElement)) trigger.focus();
  }
}

export function applyViewStateDom(
  ui: UiElements,
  state: {
    lobbyHidden: boolean;
    roomBarHidden: boolean;
    controlsHidden: boolean;
    liveControlsHidden: boolean;
    muteAudioHidden: boolean;
    togglePreviewHidden: boolean;
    stageEmptyHidden: boolean;
    stageEmptyTitle: string;
    stageEmptySubtitle: string;
    shareButtonText: string;
    shareButtonVariant: string;
  },
): void {
  ui.lobby.hidden = state.lobbyHidden;
  ui.brandHomeBtn.disabled = !state.lobbyHidden;
  ui.brandHomeBtn.title = state.lobbyHidden ? "Return to lobby" : "";
  ui.stage.hidden = !state.lobbyHidden;
  ui.stageEmpty.hidden = state.stageEmptyHidden;
  ui.stageEmptyTitle.textContent = state.stageEmptyTitle;
  ui.stageEmptySub.textContent = state.stageEmptySubtitle;
  ui.roomBar.hidden = state.roomBarHidden;
  ui.controls.hidden = state.controlsHidden;
  ui.liveControls.hidden = state.liveControlsHidden;
  ui.muteAudioBtn.hidden = state.muteAudioHidden;
  ui.togglePreviewBtn.hidden = state.togglePreviewHidden;
  ui.shareBtn.textContent = state.shareButtonText;
  ui.shareBtn.className = `ui-btn ${state.shareButtonVariant}`;
}

