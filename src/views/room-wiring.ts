import type { ChatMessage, PeerId, PeerInfo } from "@shared/protocol";
import { QUALITY_PRESETS, type CaptureResult } from "../capture";
import type { InviteController } from "../controllers/invite-controller";
import type { PopoverToastController } from "../controllers/popover-toast-controller";
import type { RecentRoomsController } from "../controllers/recent-rooms-controller";
import type { SessionController } from "../controllers/session-controller";
import { SELF_TILE, type TileController } from "../controllers/tile-controller";
import { Mesh } from "../mesh";
import type { SignalingClient, SignalingHandlers, RoomInfo } from "../signaling";
import type { UiElements } from "./dom";
import type { HealthPoller } from "./health-view";
import { currentCodec, currentDegradation, currentPreset } from "./quality-view";
import type { TileView } from "./tile-view";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
const RECONNECT_GRACE_MS = 8_000;

export interface RoomWiringContext {
  controllers: {
    session: SessionController;
    recentRooms: RecentRoomsController;
    invite: InviteController;
    tileCtrl: TileController;
    popovers: PopoverToastController;
  };
  views: {
    ui: UiElements;
    tileView: TileView;
    health: HealthPoller;
    chat: {
      onMessage: (msg: ChatMessage) => void;
      onRateLimited: (friendly: string) => void;
      syncReady: (ready: boolean) => void;
      onFreshWelcome: () => void;
    };
  };
  state: {
    peerLeftTimers: Map<PeerId, ReturnType<typeof setTimeout>>;
    getClient: () => SignalingClient | null;
    getMesh: () => Mesh | null;
    setMesh: (mesh: Mesh | null) => void;
    getCapture: () => CaptureResult | null;
    isFocusedAndVisible: () => boolean;
  };
  actions: {
    setStatus: (text: string, kind?: "info" | "warn" | "error") => void;
    setLobbyError: (message: string | null) => void;
    showTransientRoomNotice: (message: string) => void;
    scrubRoomUrl: () => void;
    teardownPeer: (peerId: PeerId) => void;
    renderInviteMenu: () => void;
    renderRoster: () => void;
    renderJoinChip: () => void;
    syncViewState: () => void;
    stopSharing: () => Promise<void>;
    leaveRoom: () => void;
  };
}

function handleInPlaceResume(
  ctx: RoomWiringContext,
  code: string,
  selfIdFromServer: PeerId,
  peers: PeerInfo[],
  room: RoomInfo,
  activeMesh: Mesh,
): void {
  const { session, tileCtrl, popovers } = ctx.controllers;
  const { tileView } = ctx.views;
  const { state, actions } = ctx;
  session.isHost = room.host;
  session.roomLocked = room.locked;

  const prevMemberIds = new Set(session.members.keys());
  const prevMeshIds = new Set(activeMesh.memberIds());
  const welcomePeerIds = new Set(peers.map((p) => p.id));
  welcomePeerIds.delete(selfIdFromServer);
  for (const id of new Set([...prevMemberIds, ...prevMeshIds, ...activeMesh.peers()])) {
    if (!welcomePeerIds.has(id)) {
      actions.teardownPeer(id);
      popovers.removeUnread(id);
    }
  }

  session.members.clear();
  for (const p of peers) {
    if (p.id === selfIdFromServer) continue;
    const wasKnown = prevMemberIds.has(p.id) || prevMeshIds.has(p.id);
    tileCtrl.setName(p.id, p.name);
    session.members.set(p.id, { name: p.name, sharing: p.sharing, host: p.host === true });
    if (tileView.getVideo(p.id)) {
      tileView.updateTileLabel(p.id, p.name);
      if (!p.sharing) tileView.removeTile(p.id);
    }
    if (!prevMeshIds.has(p.id)) activeMesh.addMember(p.id, p.sharing);
    else activeMesh.setMemberSharing(p.id, p.sharing);
    if (!wasKnown && !popovers.wasRecentDeparture(p.id)) {
      popovers.enqueueArrivalUnchecked({ id: p.id, name: p.name });
    }
  }
  actions.renderJoinChip();
  if (popovers.joinChipArrivals.length > 0) popovers.armJoinChipTimer(state.isFocusedAndVisible());

  const cap = state.getCapture();
  if (cap) {
    state.getClient()?.setSharing(true);
    if (!tileView.getVideo(SELF_TILE)) tileView.renderSelfPreview(cap.stream);
  }
  actions.setStatus(session.connectedRoomStatusText(code), "info");
}

function handleFreshWelcome(
  ctx: RoomWiringContext,
  code: string,
  selfIdFromServer: PeerId,
  peers: PeerInfo[],
  room: RoomInfo,
): void {
  const { session, tileCtrl, popovers } = ctx.controllers;
  const { tileView, health, chat } = ctx.views;
  const { state, actions } = ctx;
  state.getMesh()?.close();
  health.clearAll();
  tileCtrl.clearOutboundStats();
  session.members.clear();
  tileCtrl.clearListening();
  popovers.resetRoom();
  chat.onFreshWelcome();
  session.selfId = null;

  for (const id of tileView.videoPeerIds()) {
    if (id !== SELF_TILE) tileView.removeTile(id);
  }
  if (tileView.getVideo(SELF_TILE)) tileCtrl.setName(SELF_TILE, "You");
  session.isHost = room.host;
  session.roomLocked = room.locked;
  tileCtrl.resetWiredStreams();

  const newMesh = new Mesh(
    selfIdFromServer,
    {
      iceServers: ICE_SERVERS,
      preset: QUALITY_PRESETS[currentPreset()],
      codec: currentCodec(),
      degradation: currentDegradation(),
      jitterBufferTargetMs: 150,
    },
    (to, data) => state.getClient()?.signal(to, data),
    {
      onRemoteStream: (peerId, stream) => {
        if (session.members.get(peerId)?.sharing !== true) return;
        const video = tileView.tileFor(peerId);
        if (video.srcObject !== stream) video.srcObject = stream;
        if (tileCtrl.markStreamWired(stream)) {
          stream.addEventListener("addtrack", () => tileView.applyAudio(peerId));
          stream.addEventListener("removetrack", () => tileView.applyAudio(peerId));
        }
        tileView.applyAudio(peerId);
        tileView.startPlayback(video, peerId);
        actions.syncViewState();
      },
      onRemoteStreamGone: (peerId) => tileView.removeTile(peerId),
      onConnectionState: (peerId, connState) => {
        if ((connState === "failed" || connState === "closed") && state.peerLeftTimers.has(peerId)) {
          actions.teardownPeer(peerId);
        }
        if (connState === "failed") console.warn(`[main] connection to ${peerId} failed`);
      },
    },
  );
  state.setMesh(newMesh);
  session.selfId = selfIdFromServer;
  for (const p of peers) {
    if (p.id === selfIdFromServer) continue;
    tileCtrl.setName(p.id, p.name);
    session.members.set(p.id, { name: p.name, sharing: p.sharing, host: p.host === true });
    newMesh.addMember(p.id, p.sharing);
  }
  actions.setStatus(session.connectedRoomStatusText(code), "info");
  const cap = state.getCapture();
  if (cap) {
    state.getClient()?.setSharing(true);
    if (!tileView.getVideo(SELF_TILE)) tileView.renderSelfPreview(cap.stream);
    void newMesh.setCapture(cap).catch((err: unknown) => {
      if (state.getMesh() !== newMesh || state.getCapture() !== cap) return;
      console.error("[main] failed to reattach capture to peers", err);
      actions.setStatus("Could not start sharing to peers. Screen capture stopped.", "error");
      void actions.stopSharing();
    });
  }
}

export function buildSignalingHandlers(
  ctx: RoomWiringContext,
  code: string,
  activeGen: number,
  getLastPresentedHostToken: () => string | undefined,
): SignalingHandlers {
  const { session, recentRooms, invite, tileCtrl, popovers } = ctx.controllers;
  const { ui, tileView, health, chat } = ctx.views;
  const { state, actions } = ctx;
  let hasWelcomed = false;
  let pendingKickRotationName: string | null = null;
  const isStale = (): boolean => activeGen !== session.joinGeneration;

  return {
    onStatus: (status) => {
      if (isStale()) return;
      session.clearTransientNoticeState();
      if (status === "open") {
        actions.setStatus(`In room ${code}`, "info");
      } else {
        pendingKickRotationName = null;
        session.clearPendingKicks();
        actions.setStatus(`Connection ${status}…`, "warn");
      }
      chat.syncReady(Boolean(state.getClient()?.isReady));
      if (session.selfId !== null) actions.renderInviteMenu();
    },

    onWelcome: (selfIdFromServer, peers, room) => {
      if (isStale()) return;
      const wasFirstWelcome = !hasWelcomed;
      hasWelcomed = true;
      pendingKickRotationName = null;
      const rejectedStoredHostToken =
        !room.host && wasFirstWelcome && getLastPresentedHostToken() !== undefined;
      invite.cancelRotate();
      session.clearTransientNoticeState();
      ui.roomInput.value = "";
      actions.setLobbyError(null);
      actions.scrubRoomUrl();

      for (const timer of state.peerLeftTimers.values()) clearTimeout(timer);
      state.peerLeftTimers.clear();
      session.clearPendingKicks();

      session.applyWelcomeCredentials(code, room, getLastPresentedHostToken());
      invite.hideIfRevealed();

      const currentMesh = state.getMesh();
      if (currentMesh !== null && session.selfId !== null && session.selfId === selfIdFromServer) {
        handleInPlaceResume(ctx, code, selfIdFromServer, peers, room, currentMesh);
      } else {
        handleFreshWelcome(ctx, code, selfIdFromServer, peers, room);
      }
      recentRooms.recordJoin({
        code,
        ...(room.password !== undefined ? { password: room.password } : {}),
        peerNames: [...session.members.values()].map((m) => m.name),
      });
      if (rejectedStoredHostToken) {
        actions.showTransientRoomNotice("Joined as participant \u2014 another member is hosting this session.");
      }
      actions.renderInviteMenu();
      actions.syncViewState();
      chat.syncReady(Boolean(state.getClient()?.isReady));
      health.start();
      actions.renderRoster();
    },

    onPeerJoined: (peer, replaces) => {
      if (isStale()) return;
      if (replaces && replaces !== peer.id) {
        actions.teardownPeer(replaces);
        popovers.removeUnread(replaces);
      }
      const existingTimer = state.peerLeftTimers.get(peer.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        state.peerLeftTimers.delete(peer.id);
      }
      tileCtrl.setName(peer.id, peer.name);
      session.members.set(peer.id, { name: peer.name, sharing: peer.sharing, host: peer.host === true });
      recentRooms.updatePeers(
        code,
        [...session.members.values()].map((m) => m.name),
      );
      const activeMesh = state.getMesh();
      if (activeMesh) {
        if (activeMesh.memberIds().includes(peer.id)) {
          if (!peer.sharing) tileView.removeTile(peer.id);
          activeMesh.setMemberSharing(peer.id, peer.sharing);
        } else {
          activeMesh.addMember(peer.id, peer.sharing);
        }
      }
      popovers.recordArrival(
        { id: peer.id, name: peer.name },
        { replaces, isFocusedAndVisible: state.isFocusedAndVisible() },
      );
      actions.setStatus(`${peer.name} joined room ${code}`, "info");
      actions.renderRoster();
    },

    onPeerLeft: (id, kicked) => {
      if (isStale()) return;
      const kickedName = session.consumePendingKick(id);
      if (kickedName !== null && kicked && session.isHost) {
        pendingKickRotationName = kickedName;
        actions.showTransientRoomNotice(`Removed ${kickedName}.`);
      }
      if (!kicked) popovers.recordDeparture(id);
      popovers.removeUnread(id);
      if (kicked || !state.getMesh()?.hasConnectedLink(id)) {
        actions.teardownPeer(id);
        return;
      }
      const prev = state.peerLeftTimers.get(id);
      if (prev) clearTimeout(prev);
      state.peerLeftTimers.set(
        id,
        setTimeout(() => actions.teardownPeer(id), RECONNECT_GRACE_MS),
      );
    },

    onSignal: (from, data) => {
      if (isStale()) return;
      void state.getMesh()?.handleSignal(from, data);
    },

    onPeerState: (id, sharing) => {
      if (isStale()) return;
      const prev = state.peerLeftTimers.get(id);
      if (prev) {
        clearTimeout(prev);
        state.peerLeftTimers.delete(id);
      }
      if (!sharing) tileView.removeTile(id);
      const m = session.members.get(id);
      if (m) m.sharing = sharing;
      state.getMesh()?.setMemberSharing(id, sharing);
      actions.renderRoster();
    },

    onRoomState: (locked, password) => {
      if (isStale()) return;
      session.applyRoomState(locked, password);
      recentRooms.updatePassword(code, password, locked);
      if (locked) invite.onRoomLocked();
      actions.renderRoster();
      actions.renderInviteMenu();
    },

    onRoomPassword: (password, rejoinToken) => {
      if (isStale()) return;
      session.applyRoomPassword(code, password, rejoinToken);
      recentRooms.updatePassword(code, password, false);
      invite.completeRotate();
      if (password && pendingKickRotationName !== null && session.isHost) {
        const kickedName = pendingKickRotationName;
        pendingKickRotationName = null;
        actions.showTransientRoomNotice(
          `Removed ${kickedName} \u2014 invite link rotated. Share the new link with Copy invite link.`,
        );
      }
      actions.renderInviteMenu();
    },

    onPeerRenamed: (id, name) => {
      if (isStale()) return;
      tileCtrl.setName(id, name);
      const m = session.members.get(id);
      if (m) m.name = name;
      if (id === session.selfId) {
        ui.nameInput.value = name;
        ui.roomNameInput.value = name;
      } else {
        recentRooms.updatePeers(
          code,
          [...session.members.values()].map((m) => m.name),
        );
      }
      tileView.updateTileLabel(id, name);
      actions.renderRoster();
    },

    onHostPromoted: (hostId, hostToken, password) => {
      if (isStale()) return;
      session.applyHostPromoted(code, hostId, hostToken, password);
      actions.renderRoster();
      actions.renderInviteMenu();
    },

    onChat: (msg) => {
      if (isStale()) return;
      chat.onMessage(msg);
    },

    onError: (codeErr, message) => {
      if (isStale()) return;
      const activeClient = state.getClient();
      const classified = session.classifyError(code, codeErr, message, Boolean(activeClient?.isFatal));
      if (classified.severity === "fatal") {
        const lastHostToken = getLastPresentedHostToken();
        void actions.stopSharing();
        const removedRecent = recentRooms.handleFatalError(code, codeErr, lastHostToken);
        session.applyFatalErrorCleanup(code, codeErr, hasWelcomed, lastHostToken, codeErr !== "kicked");
        actions.leaveRoom();
        const lobbyMsg =
          removedRecent && (codeErr === "kicked" || codeErr === "bad-password")
            ? `${classified.friendly} Removed ${code} from saved rooms.`
            : classified.friendly;
        actions.setLobbyError(lobbyMsg);
        actions.setStatus("", "info");
        return;
      }
      if (classified.clearPendingKicks) {
        session.clearPendingKicks();
        actions.renderRoster();
      }
      if (classified.severity === "warn") actions.setStatus(classified.friendly, "warn");
      else if (classified.severity === "error") actions.setStatus(classified.friendly, "error");
      else if (codeErr === "chat-rate-limited") chat.onRateLimited(classified.friendly);
    },
  };
}
