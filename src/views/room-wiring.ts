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
  ui: UiElements;
  session: SessionController;
  recentRooms: RecentRoomsController;
  invite: InviteController;
  tileCtrl: TileController;
  popovers: PopoverToastController;
  tileView: TileView;
  health: HealthPoller;
  peerLeftTimers: Map<PeerId, ReturnType<typeof setTimeout>>;
  chat: {
    onMessage: (msg: ChatMessage) => void;
    onRateLimited: (friendly: string) => void;
    syncReady: (ready: boolean) => void;
    onFreshWelcome: () => void;
  };
  getClient: () => SignalingClient | null;
  getMesh: () => Mesh | null;
  setMesh: (mesh: Mesh | null) => void;
  getCapture: () => CaptureResult | null;
  isFocusedAndVisible: () => boolean;
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
}

function handleInPlaceResume(
  ctx: RoomWiringContext,
  code: string,
  selfIdFromServer: PeerId,
  peers: PeerInfo[],
  room: RoomInfo,
  activeMesh: Mesh,
): void {
  const { session, tileCtrl, popovers, tileView } = ctx;
  session.isHost = room.host;
  session.roomLocked = room.locked;

  const prevMemberIds = new Set(session.members.keys());
  const prevMeshIds = new Set(activeMesh.memberIds());
  const welcomePeerIds = new Set(peers.map((p) => p.id));
  welcomePeerIds.delete(selfIdFromServer);
  for (const id of new Set([...prevMemberIds, ...prevMeshIds, ...activeMesh.peers()])) {
    if (!welcomePeerIds.has(id)) {
      ctx.teardownPeer(id);
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
  ctx.renderJoinChip();
  if (popovers.joinChipArrivals.length > 0) popovers.armJoinChipTimer(ctx.isFocusedAndVisible());

  const cap = ctx.getCapture();
  if (cap) {
    ctx.getClient()?.setSharing(true);
    if (!tileView.getVideo(SELF_TILE)) tileView.renderSelfPreview(cap.stream);
  }
  ctx.setStatus(session.connectedRoomStatusText(code), "info");
}

function handleFreshWelcome(
  ctx: RoomWiringContext,
  code: string,
  selfIdFromServer: PeerId,
  peers: PeerInfo[],
  room: RoomInfo,
): void {
  const { session, tileCtrl, popovers, tileView, health } = ctx;
  ctx.getMesh()?.close();
  health.clearAll();
  tileCtrl.clearOutboundStats();
  session.members.clear();
  tileCtrl.clearListening();
  popovers.resetRoom();
  ctx.chat.onFreshWelcome();
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
    (to, data) => ctx.getClient()?.signal(to, data),
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
        ctx.syncViewState();
      },
      onRemoteStreamGone: (peerId) => tileView.removeTile(peerId),
      onConnectionState: (peerId, state) => {
        if ((state === "failed" || state === "closed") && ctx.peerLeftTimers.has(peerId)) {
          ctx.teardownPeer(peerId);
        }
        if (state === "failed") console.warn(`[main] connection to ${peerId} failed`);
      },
    },
  );
  ctx.setMesh(newMesh);
  session.selfId = selfIdFromServer;
  for (const p of peers) {
    if (p.id === selfIdFromServer) continue;
    tileCtrl.setName(p.id, p.name);
    session.members.set(p.id, { name: p.name, sharing: p.sharing, host: p.host === true });
    newMesh.addMember(p.id, p.sharing);
  }
  ctx.setStatus(session.connectedRoomStatusText(code), "info");
  const cap = ctx.getCapture();
  if (cap) {
    ctx.getClient()?.setSharing(true);
    if (!tileView.getVideo(SELF_TILE)) tileView.renderSelfPreview(cap.stream);
    void newMesh.setCapture(cap).catch((err: unknown) => {
      if (ctx.getMesh() !== newMesh || ctx.getCapture() !== cap) return;
      console.error("[main] failed to reattach capture to peers", err);
      ctx.setStatus("Could not start sharing to peers. Screen capture stopped.", "error");
      void ctx.stopSharing();
    });
  }
}

export function buildSignalingHandlers(
  ctx: RoomWiringContext,
  code: string,
  activeGen: number,
  getLastPresentedHostToken: () => string | undefined,
): SignalingHandlers {
  const { ui, session, invite, tileCtrl, popovers, tileView, health } = ctx;
  let hasWelcomed = false;
  let pendingKickRotationName: string | null = null;
  const isStale = (): boolean => activeGen !== session.joinGeneration;

  return {
    onStatus: (status) => {
      if (isStale()) return;
      session.clearTransientNoticeState();
      if (status === "open") {
        ctx.setStatus(`In room ${code}`, "info");
      } else {
        pendingKickRotationName = null;
        session.clearPendingKicks();
        ctx.setStatus(`Connection ${status}…`, "warn");
      }
      ctx.chat.syncReady(Boolean(ctx.getClient()?.isReady));
      if (session.selfId !== null) ctx.renderInviteMenu();
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
      ctx.setLobbyError(null);
      ctx.scrubRoomUrl();

      for (const timer of ctx.peerLeftTimers.values()) clearTimeout(timer);
      ctx.peerLeftTimers.clear();
      session.clearPendingKicks();

      session.applyWelcomeCredentials(code, room, getLastPresentedHostToken());
      invite.hideIfRevealed();

      const currentMesh = ctx.getMesh();
      if (currentMesh !== null && session.selfId !== null && session.selfId === selfIdFromServer) {
        handleInPlaceResume(ctx, code, selfIdFromServer, peers, room, currentMesh);
      } else {
        handleFreshWelcome(ctx, code, selfIdFromServer, peers, room);
      }
      ctx.recentRooms.recordJoin({
        code,
        ...(room.password !== undefined ? { password: room.password } : {}),
        peerNames: [...session.members.values()].map((m) => m.name),
      });
      if (rejectedStoredHostToken) {
        ctx.showTransientRoomNotice("Joined as participant \u2014 another member is hosting this session.");
      }
      ctx.renderInviteMenu();
      ctx.syncViewState();
      ctx.chat.syncReady(Boolean(ctx.getClient()?.isReady));
      health.start();
      ctx.renderRoster();
    },

    onPeerJoined: (peer, replaces) => {
      if (isStale()) return;
      if (replaces && replaces !== peer.id) {
        ctx.teardownPeer(replaces);
        popovers.removeUnread(replaces);
      }
      const existingTimer = ctx.peerLeftTimers.get(peer.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        ctx.peerLeftTimers.delete(peer.id);
      }
      tileCtrl.setName(peer.id, peer.name);
      session.members.set(peer.id, { name: peer.name, sharing: peer.sharing, host: peer.host === true });
      ctx.recentRooms.updatePeers(
        code,
        [...session.members.values()].map((m) => m.name),
      );
      const activeMesh = ctx.getMesh();
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
        { replaces, isFocusedAndVisible: ctx.isFocusedAndVisible() },
      );
      ctx.setStatus(`${peer.name} joined room ${code}`, "info");
      ctx.renderRoster();
    },

    onPeerLeft: (id, kicked) => {
      if (isStale()) return;
      const kickedName = session.consumePendingKick(id);
      if (kickedName !== null && kicked && session.isHost) {
        pendingKickRotationName = kickedName;
        ctx.showTransientRoomNotice(`Removed ${kickedName}.`);
      }
      if (!kicked) popovers.recordDeparture(id);
      popovers.removeUnread(id);
      if (kicked || !ctx.getMesh()?.hasConnectedLink(id)) {
        ctx.teardownPeer(id);
        return;
      }
      const prev = ctx.peerLeftTimers.get(id);
      if (prev) clearTimeout(prev);
      ctx.peerLeftTimers.set(
        id,
        setTimeout(() => ctx.teardownPeer(id), RECONNECT_GRACE_MS),
      );
    },

    onSignal: (from, data) => {
      if (isStale()) return;
      void ctx.getMesh()?.handleSignal(from, data);
    },

    onPeerState: (id, sharing) => {
      if (isStale()) return;
      const prev = ctx.peerLeftTimers.get(id);
      if (prev) {
        clearTimeout(prev);
        ctx.peerLeftTimers.delete(id);
      }
      if (!sharing) tileView.removeTile(id);
      const m = session.members.get(id);
      if (m) m.sharing = sharing;
      ctx.getMesh()?.setMemberSharing(id, sharing);
      ctx.renderRoster();
    },

    onRoomState: (locked, password) => {
      if (isStale()) return;
      session.applyRoomState(locked, password);
      ctx.recentRooms.updatePassword(code, password, locked);
      if (locked) invite.onRoomLocked();
      ctx.renderRoster();
      ctx.renderInviteMenu();
    },

    onRoomPassword: (password, rejoinToken) => {
      if (isStale()) return;
      session.applyRoomPassword(code, password, rejoinToken);
      ctx.recentRooms.updatePassword(code, password, false);
      invite.completeRotate();
      if (password && pendingKickRotationName !== null && session.isHost) {
        const kickedName = pendingKickRotationName;
        pendingKickRotationName = null;
        ctx.showTransientRoomNotice(
          `Removed ${kickedName} \u2014 invite link rotated. Share the new link with Copy invite link.`,
        );
      }
      ctx.renderInviteMenu();
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
        ctx.recentRooms.updatePeers(
          code,
          [...session.members.values()].map((m) => m.name),
        );
      }
      tileView.updateTileLabel(id, name);
      ctx.renderRoster();
    },

    onHostPromoted: (hostId, hostToken, password) => {
      if (isStale()) return;
      session.applyHostPromoted(code, hostId, hostToken, password);
      ctx.renderRoster();
      ctx.renderInviteMenu();
    },

    onChat: (msg) => {
      if (isStale()) return;
      ctx.chat.onMessage(msg);
    },

    onError: (codeErr, message) => {
      if (isStale()) return;
      const activeClient = ctx.getClient();
      const classified = session.classifyError(code, codeErr, message, Boolean(activeClient?.isFatal));
      if (classified.severity === "fatal") {
        const lastHostToken = getLastPresentedHostToken();
        void ctx.stopSharing();
        const removedRecent = ctx.recentRooms.handleFatalError(code, codeErr);
        session.applyFatalErrorCleanup(code, codeErr, hasWelcomed, lastHostToken);
        if (codeErr === "bad-password" && lastHostToken !== undefined) {
          session.forgetCreatorHostToken(code, lastHostToken);
        }
        ctx.leaveRoom();
        const lobbyMsg =
          removedRecent && (codeErr === "kicked" || codeErr === "bad-password")
            ? `${classified.friendly} Removed ${code} from saved rooms.`
            : classified.friendly;
        ctx.setLobbyError(lobbyMsg);
        ctx.setStatus("", "info");
        return;
      }
      if (classified.clearPendingKicks) {
        session.clearPendingKicks();
        ctx.renderRoster();
      }
      if (classified.severity === "warn") ctx.setStatus(classified.friendly, "warn");
      else if (classified.severity === "error") ctx.setStatus(classified.friendly, "error");
      else if (codeErr === "chat-rate-limited") ctx.chat.onRateLimited(classified.friendly);
    },
  };
}
