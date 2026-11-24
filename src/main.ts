/**
 * App bootstrap: wires signalling -> mesh -> controllers -> thin DOM views.
 *
 * All state machines live in src/controllers/* and latency-critical paths live in
 * mesh.ts / quality.ts. This file is thin bootstrap glue (< 300 code lines).
 */

import { isValidRoomCode, type PeerId } from "@shared/protocol";
import { QUALITY_PRESETS } from "./capture";
import { InviteController } from "./controllers/invite-controller";
import { PopoverToastController } from "./controllers/popover-toast-controller";
import { RecentRoomsController } from "./controllers/recent-rooms-controller";
import { SessionController } from "./controllers/session-controller";
import { TileController } from "./controllers/tile-controller";
import type { Mesh } from "./mesh";
import { createCaptureController } from "./platform";
import type { EndReason } from "./platform/types";
import { SignalingClient } from "./signaling";
import { describeInviteParseFailure, type PopoverKind, type ViewState } from "./ui-model";
import { mountChatFeature } from "./views/chat-view";
import {
  currentNameDom,
  queryUiElements,
  scrubRoomUrlDom,
  setLobbyErrorDom,
  setLobbyNoticeDom,
  setStatusDom,
  syncNameInputsDom,
} from "./views/dom";
import { bindAllDomEvents } from "./views/dom-events";
import { HealthPoller } from "./views/health-view";
import { captureBlockedReason, initQualityControls, renderFollowChip, syncMuteAudioButton } from "./views/quality-view";
import { RecentRoomsView } from "./views/recent-rooms-view";
import { buildSignalingHandlers } from "./views/room-wiring";
import {
  JoinChipView, applyPopoverDom, applyViewStateDom, renderForgetHostButtons,
  renderInviteMenuView, renderRosterUnreadDotView, renderRosterView, updateRosterStatsInPlaceView,
} from "./views/roster-view";
import { ShareLifecycle } from "./views/share-view";
import { TileView } from "./views/tile-view";

const ui = queryUiElements();
const pendingTasks = new Set<Promise<unknown>>();
const peerLeftTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();

let client: SignalingClient | null = null;
let mesh: Mesh | null = null;

function runBackground(task: Promise<unknown>): void {
  const tracked = task
    .catch((err: unknown) => console.warn("[main] background task failed", err))
    .finally(() => pendingTasks.delete(tracked));
  pendingTasks.add(tracked);
}

function safeStorage(getter: () => Storage | undefined): Storage | null {
  try { return getter() ?? null; } catch { return null; }
}

function safeLocks(): LockManager | null {
  try { return typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : null; } catch { return null; }
}

const isFocusedAndVisible = (): boolean =>
  typeof document === "undefined" || (!document.hidden && document.hasFocus());

const joinChipView = new JoinChipView(ui);
const tileCtrl = new TileController();
const getLocalStorage = (): Storage | null =>
  safeStorage(() => (typeof localStorage !== "undefined" ? localStorage : undefined));
let recentRoomsCtrl: RecentRoomsController | null = null;
const session = new SessionController({
  getLocalStorage,
  getSessionStorage: () => safeStorage(() => (typeof sessionStorage !== "undefined" ? sessionStorage : undefined)),
  getLocks: safeLocks,
  runBackground,
  onForgetHostUiChange: () => {
    renderForgetHostButtons(ui, session);
    recentRoomsCtrl?.syncFromStorage();
  },
});
const setStatus = (text: string, kind: "info" | "warn" | "error" = "info"): void => setStatusDom(ui, text, kind);
const setLobbyError = (message: string | null): void => setLobbyErrorDom(ui, message);
const setLobbyNotice = (message: string | null): void => setLobbyNoticeDom(ui, message);
const recentRoomsView = new RecentRoomsView(ui.lobbyCard, ui.recentRoomsRoot, {
  onRejoin: (code) => runBackground(rejoinRecentRoom(code)),
  onStartRename: (code) => recentRooms.setEditingCode(code),
  onCommitRename: (code, label) => recentRooms.rename(code, label),
  onCancelRename: () => recentRooms.setEditingCode(null),
  onRemove: (code) => {
    recentRooms.remove(code);
    setLobbyNotice(`Removed ${code} from saved rooms.`);
  },
  onClearAll: () => {
    recentRooms.clearAll();
    setLobbyNotice("Cleared all saved rooms and host keys on this device.");
  },
  onSetDisabled: (disabled) => {
    recentRooms.setDisabled(disabled);
    setLobbyNotice(
      disabled ? "Room saving turned off for this shared device." : "Room saving enabled on this device.",
    );
  },
  onSearchChange: (q) => recentRooms.setSearchQuery(q),
});
const recentRooms = new RecentRoomsController({
  getLocalStorage,
  getLocks: safeLocks,
  runBackground,
  hasSavedCreatorHostFor: (code) => session.hasSavedCreatorHostFor(code),
  onRemoveHostToken: (code, onlyIfMatching) => session.forgetCreatorHostToken(code, onlyIfMatching),
  onForgetAllHostTokens: () => session.forgetAllHostTokens(),
  onChange: () => renderRecentRooms(),
});
recentRoomsCtrl = recentRooms;
const invite = new InviteController({ onChange: () => renderInviteMenu() });
const popovers = new PopoverToastController({ onJoinChipChange: () => renderJoinChip() });
const tileView = new TileView(ui, tileCtrl, {
  onViewingChange: (peerId, want) => mesh?.setViewing(peerId, want),
  onSyncViewState: () => syncViewState(),
  runBackground,
});
const health = new HealthPoller({
  getMesh: () => mesh,
  isSharing: () => share.capture !== null,
  getMemberIds: () => session.members.keys(),
  tileCtrl,
  tileView,
  onOutboundUpdated: () => {
    if (!client || session.selfId === null) return;
    const allIds = [...session.members.keys(), ...(mesh ? [...mesh.memberIds(), ...mesh.peers()] : [])];
    updateRosterStatsInPlaceView(ui, session.selfId, allIds, share.capture !== null, session.roomLocked, tileCtrl);
  },
  runBackground,
});
const scrubRoomUrl = (): void => scrubRoomUrlDom();
const currentName = (): string => currentNameDom(ui);
const syncNameInputs = (value: string): void => {
  syncNameInputsDom(ui, value);
  if (session.selfId !== null) renderRoster();
};
const captureController = createCaptureController({
  onEnded: (reason: EndReason) => {
    runBackground(
      share.stop().then(() => {
        if (reason === "follow-ended") setStatus("The game closed, so sharing stopped.", "warn");
      }),
    );
  },
  onVideoTrackSwapped: async (track, stream) => {
    if (share.capture?.stream !== stream) return;
    await mesh?.setVideoTrack(track);
    if (share.capture?.stream !== stream) return;
    tileView.renderSelfPreview(stream);
  },
  onFollowState: (state) => renderFollowChip(ui, state),
});
const share = new ShareLifecycle({
  ui, session, invite, tileCtrl, tileView, health, captureController,
  getClient: () => client, getMesh: () => mesh,
  closeAllPopovers: () => applyPopoverState(null),
  setStatus, syncViewState, renderRoster, runBackground,
});
const chat = mountChatFeature({
  stage: ui.stage,
  roomBar: ui.roomBar,
  getSelfId: () => session.selfId,
  sendMessage: (text) => Boolean(client?.sendChat(text)),
  hasOpenPopover: () => popovers.activePopover !== null,
});

function renderRecentRooms(): void {
  recentRoomsView.render({
    disabled: recentRooms.isDisabled(),
    totalCount: recentRooms.getRooms().length,
    filteredRooms: recentRooms.getFilteredRooms(),
    searchQuery: recentRooms.getSearchQuery(),
    editingCode: recentRooms.getEditingCode(),
  });
}

function renderInviteMenu(): void {
  renderInviteMenuView(ui, invite, session, popovers.activePopover, Boolean(client?.isReady));
}

function renderJoinChip(): void {
  joinChipView.render(popovers.getJoinChipText(Boolean(client && session.selfId !== null)));
}

function renderRoster(): void {
  const extraPeerIds = mesh ? [...mesh.memberIds(), ...mesh.peers()] : [];
  renderRosterView(ui, {
    connected: Boolean(client), selfId: session.selfId, selfName: currentName(),
    isSharing: share.capture !== null, extraPeerIds, session, popovers, tileCtrl,
    onKick: (entry, btn) => {
      if (!client?.isReady || !session.startPendingKick(entry.id, entry.name, () => renderRoster())) return;
      btn.disabled = true;
      client.kick(entry.id);
      if (!session.members.has(entry.id)) teardownPeer(entry.id);
    },
  });
}

function applyPopoverState(target: PopoverKind | null): void {
  const res = popovers.applyPopover(target, session.selfId !== null && client !== null, share.capture !== null);
  applyPopoverDom(ui, res.visibility, res.previous);
  if (res.visibility.inviteOpen) renderInviteMenu();
  if (res.closedInvite) invite.setRevealed(false);
  if (res.openedRoster) renderRosterUnreadDotView(ui, popovers);
  if (res.closedRoster) {
    renderRosterUnreadDotView(ui, popovers);
    renderRoster();
  }
}

function syncViewState(): ViewState {
  const sharing = share.capture !== null;
  const connected = session.selfId !== null && client !== null;
  const state = tileCtrl.deriveView(connected, sharing);
  applyViewStateDom(ui, state);
  chat.syncConnected(connected);
  const active = popovers.activePopover;
  if (client === null || (!sharing && (active === "preset" || active === "codec" || active === "degradation"))) {
    applyPopoverState(null);
  }
  tileView.setFocusButtonsVisible(state.showFocusButtons);
  if (!state.showFocusButtons && tileCtrl.focusedPeerId !== null) tileView.setFocusedTile(null);
  return state;
}

function showTransientRoomNotice(message: string): void {
  session.showTransientNotice(
    message,
    (msg) => setStatus(msg, "warn"),
    (msg) => {
      if (ui.status.textContent === msg && client?.isReady && session.selfId !== null && session.lastJoinCode !== null) {
        setStatus(session.connectedRoomStatusText(session.lastJoinCode), "info");
      }
    },
  );
}

function dismissTransientRoomNotice(): void {
  session.dismissTransientNotice(ui.status.textContent ?? "", Boolean(client?.isReady), (text) =>
    setStatus(text, "info"),
  );
}

function teardownPeer(peerId: PeerId): void {
  const timer = peerLeftTimers.get(peerId);
  if (timer) {
    clearTimeout(timer);
    peerLeftTimers.delete(peerId);
  }
  mesh?.removeMember(peerId);
  session.members.delete(peerId);
  health.deleteInbound(peerId);
  health.deleteOutbound(peerId);
  tileView.removeTile(peerId);
  tileCtrl.teardownPeer(peerId);
  renderRoster();
}

function leaveRoom(): void {
  session.joinGeneration++;
  invite.reset();
  popovers.resetRoom();
  chat.reset();
  for (const timer of peerLeftTimers.values()) clearTimeout(timer);
  peerLeftTimers.clear();
  health.stop();
  if (share.capture) client?.setSharing(false);
  share.forceStop();
  client?.close();
  client = null;
  mesh?.close();
  mesh = null;
  health.clearAll();
  tileView.clearAll();
  tileCtrl.resetAll();
  session.resetRoomState();
  tileView.setFocusedTile(null);
  renderInviteMenu();
  renderRoster();
  syncViewState();
  renderForgetHostButtons(ui, session);
  recentRooms.setEditingCode(null);
  renderRecentRooms();
}

async function joinRoom(code: string, initialPassword?: string): Promise<void> {
  if (!isValidRoomCode(code)) {
    setLobbyError(describeInviteParseFailure("invalid"));
    return;
  }
  const preGen = ++session.joinGeneration;
  if (share.capture && session.lastJoinCode && session.lastJoinCode !== code) {
    await share.stop();
    if (preGen !== session.joinGeneration) return;
  }
  if (session.lastJoinCode && session.lastJoinCode !== code) session.clearRoomSession(session.lastJoinCode);
  leaveRoom();
  const activeGen = ++session.joinGeneration;
  session.lastJoinCode = code;
  session.saveActiveRoom(code);
  session.roomPassword = initialPassword ?? null;
  invite.cancelRotate();
  let lastPresentedHostToken: string | undefined;

  const handlers = buildSignalingHandlers(
    {
      controllers: { session, recentRooms, invite, tileCtrl, popovers },
      views: {
        ui,
        tileView,
        health,
        chat: {
          onMessage: (msg) => chat.onMessage(msg),
          onRateLimited: (friendly) => chat.onRateLimited(friendly),
          syncReady: (ready) => chat.syncReady(ready),
          onFreshWelcome: () => chat.reset(),
        },
      },
      state: {
        peerLeftTimers,
        getClient: () => client,
        getMesh: () => mesh,
        setMesh: (m) => { mesh = m; },
        getCapture: () => share.capture,
        isFocusedAndVisible,
      },
      actions: {
        setStatus,
        setLobbyError,
        showTransientRoomNotice,
        scrubRoomUrl,
        teardownPeer,
        renderInviteMenu,
        renderRoster,
        renderJoinChip,
        syncViewState,
        stopSharing: () => share.stop(),
        leaveRoom,
      },
    },
    code,
    activeGen,
    () => lastPresentedHostToken,
  );
  client = new SignalingClient(code, currentName(), handlers, () => {
    const hostToken = session.hostTokenFor(code);
    lastPresentedHostToken = hostToken;
    return { password: session.roomPassword ?? undefined, hostToken, rejoinToken: session.rejoinTokenFor(code) };
  });
  client.connect();
  scrubRoomUrl();
}

async function enterInvite(code: string, password: string): Promise<void> {
  if (share.capture && session.lastJoinCode && session.lastJoinCode !== code) {
    if (!window.confirm("Leave your current room and stop sharing your screen to join the new room?")) return;
  }
  const previous = session.lastJoinCode ?? session.activeRoomFor();
  if (previous && previous !== code) session.clearRoomSession(previous);
  session.saveActiveRoom(code);
  setLobbyNotice(null);
  scrubRoomUrl();
  await joinRoom(code, password);
}

async function rejoinRecentRoom(code: string): Promise<void> {
  const entry = recentRooms.getRooms().find((r) => r.code === code);
  if (!entry) return;
  if (share.capture && session.lastJoinCode && session.lastJoinCode !== code) {
    if (!window.confirm("Leave your current room and stop sharing your screen to join the new room?")) return;
  }
  const previous = session.lastJoinCode ?? session.activeRoomFor();
  if (previous && previous !== code) session.clearRoomSession(previous);
  session.saveActiveRoom(code);
  setLobbyError(null);
  setLobbyNotice(null);
  scrubRoomUrl();
  await joinRoom(code, entry.password);
}

function joinFromBootOrHash(isHashChange: boolean): void {
  const rawHash = location.hash;
  if (rawHash.length > 0) scrubRoomUrl();
  const action = session.resolveBootAction(rawHash, isHashChange, {
    active: client !== null,
    fatal: Boolean(client?.isFatal),
    ready: Boolean(client?.isReady),
  });
  if (action.kind === "error") {
    if (client && session.selfId !== null) setStatus(action.message, "warn");
    else setLobbyError(action.message);
  } else if (action.kind === "reconnect-current") {
    client?.connect();
  } else if (action.kind === "enter-invite") {
    setLobbyError(null);
    runBackground(enterInvite(action.code, action.password));
  } else if (action.kind === "resume-saved") {
    runBackground(joinRoom(action.code));
  }
}

initQualityControls(ui, {
  onTogglePopover: (kind) => applyPopoverState(kind),
  onClosePopovers: () => applyPopoverState(null),
  onPresetChange: (name) => {
    captureController.setPreset(QUALITY_PRESETS[name]);
    if (mesh) runBackground(mesh.setPreset(QUALITY_PRESETS[name]));
  },
  onCodecChange: (name) => mesh?.setCodec(name),
  onDegradationChange: (name) => { if (mesh) runBackground(mesh.setDegradation(name)); },
  onToggleMuteAudio: () => share.toggleMuteAudio(),
  onShowPreview: () => tileView.showSelfPreview(),
});
syncMuteAudioButton(ui, share.capture);

const blocked = captureBlockedReason();
if (blocked) {
  setStatus(blocked, "error");
  ui.shareBtn.title = blocked;
}

bindAllDomEvents({
  controllers: { session, recentRooms, invite, popovers },
  views: { ui, tileView },
  state: {
    getClient: () => client,
    isSharing: () => share.capture !== null,
    isFocusedAndVisible,
    currentName,
  },
  actions: {
    runBackground,
    setStatus,
    setLobbyError,
    setLobbyNotice,
    showTransientRoomNotice,
    dismissTransientRoomNotice,
    togglePopover: (w) => applyPopoverState(w),
    closeAllPopovers: () => applyPopoverState(null),
    renderInviteMenu,
    renderJoinChip,
    renderRoster,
    scrubRoomUrl,
    startSharing: () => share.start(),
    stopSharing: () => share.stop(),
    enterInvite,
    joinRoom,
    leaveRoom,
    syncNameInputs,
    joinFromBootOrHash,
  },
});

renderForgetHostButtons(ui, session);
renderRecentRooms();
syncViewState();
joinFromBootOrHash(false);
