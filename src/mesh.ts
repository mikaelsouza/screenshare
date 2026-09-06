/**
 * Full-mesh peer connection manager.
 *
 * In a room of N, every peer holds N-1 RTCPeerConnections and media flows directly
 * between browsers — the server sees signalling only, then goes quiet. That is the
 * whole point of the design, and it's why room size is capped at all: mesh upload cost
 * is linear in room size and borne entirely by the sharer's uplink. See MAX_ROOM_SIZE.
 */

import type { IceCandidateInit, PeerId, SignalData } from "@shared/protocol";
import type { CaptureResult, QualityPreset } from "./capture";
import {
  applyAudioEncoding,
  applyVideoEncoding,
  BitrateAdapter,
  type CodecName,
  mungeOpusSdp,
  preferCodec,
  tuneReceiverLatency,
} from "./quality";
import { parseCandidate } from "./stats";

export interface MeshOptions {
  iceServers: RTCIceServer[];
  preset: QualityPreset;
  codec: CodecName;
  /** Receive-side jitter buffer target, ms. 0 = lowest latency. */
  jitterBufferTargetMs: number;
  /** When true, forces WebRTC through TURN relay only to protect user IP address. */
  relayOnly?: boolean;
}

export interface MeshCallbacks {
  onRemoteStream(peerId: PeerId, stream: MediaStream): void;
  onRemoteStreamGone(peerId: PeerId): void;
  onConnectionState(peerId: PeerId, state: RTCPeerConnectionState): void;
}

/** Peer-to-peer control traffic. Deliberately NOT routed through the server. */
type ControlMessage = { c: "view"; want: boolean };

class PeerLink {
  readonly pc: RTCPeerConnection;
  /**
   * Perfect-negotiation role. Decided by comparing peer IDs so both sides
   * independently reach opposite conclusions with no extra round trip.
   */
  readonly polite: boolean;

  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;

  private control: RTCDataChannel | null = null;
  private remoteWantsVideo = true;
  /** What we last asked the far end for; flushed when the channel opens. */
  private desiredView: boolean | null = null;

  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  private adapter: BitrateAdapter | null = null;
  private remoteStream: MediaStream | null = null;

  constructor(
    readonly selfId: PeerId,
    readonly peerId: PeerId,
    private readonly opts: MeshOptions,
    private readonly send: (data: SignalData) => void,
    private readonly cb: MeshCallbacks,
  ) {
    this.polite = selfId < peerId;
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceTransportPolicy: opts.relayOnly ? "relay" : "all",
    });

    this.pc.onnegotiationneeded = () => void this.negotiate();
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        if (this.opts.relayOnly) {
          const parsed = parseCandidate(candidate);
          if (parsed && parsed.type !== "relay") return;
        }
        this.send({
          k: "ice",
          candidate: {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment,
          },
        });
      }
    };
    this.pc.onconnectionstatechange = () => {
      this.cb.onConnectionState(this.peerId, this.pc.connectionState);
    };
    this.pc.ontrack = (ev) => this.onTrack(ev);
    this.pc.ondatachannel = (ev) => {
      if (ev.channel.label === "control") this.bindControl(ev.channel);
    };

    // Exactly one side creates the control channel, or we'd get two.
    // Creating it also gives negotiation something to do, so the ICE connection
    // establishes immediately rather than waiting for someone to start sharing.
    if (!this.polite) {
      this.bindControl(this.pc.createDataChannel("control", { ordered: true }));
    }
  }

  // ---- negotiation -------------------------------------------------------

  private async negotiate(): Promise<void> {
    try {
      this.makingOffer = true;
      // Explicit createOffer (rather than the arg-less setLocalDescription) because
      // the Opus fmtp line has to be munged before the description is applied.
      const offer = await this.pc.createOffer();
      offer.sdp = mungeOpusSdp(offer.sdp ?? "");
      await this.pc.setLocalDescription(offer);
      const sdp = this.pc.localDescription?.sdp;
      if (sdp) this.send({ k: "offer", sdp });
    } catch (err) {
      console.error(`[mesh] negotiation failed with ${this.peerId}`, err);
    } finally {
      this.makingOffer = false;
    }
  }

  async handleSignal(data: SignalData): Promise<void> {
    if (data.k === "ice") return this.addIce(data.candidate);
    return this.applyDescription(data.k, data.sdp);
  }

  private async applyDescription(kind: "offer" | "answer", sdp: string): Promise<void> {
    // Standard perfect-negotiation glare handling. Both people hitting "share" at
    // the same instant is exactly the collision this prevents.
    const readyForOffer =
      !this.makingOffer &&
      (this.pc.signalingState === "stable" || this.isSettingRemoteAnswerPending);
    const offerCollision = kind === "offer" && !readyForOffer;

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    try {
      this.isSettingRemoteAnswerPending = kind === "answer";
      await this.pc.setRemoteDescription({ type: kind, sdp });
      this.isSettingRemoteAnswerPending = false;

      if (kind === "offer") {
        const answer = await this.pc.createAnswer();
        answer.sdp = mungeOpusSdp(answer.sdp ?? "");
        await this.pc.setLocalDescription(answer);
        const out = this.pc.localDescription?.sdp;
        if (out) this.send({ k: "answer", sdp: out });
      }
    } catch (err) {
      this.isSettingRemoteAnswerPending = false;
      console.error(`[mesh] setDescription(${kind}) failed for ${this.peerId}`, err);
    }
  }

  private async addIce(candidate: IceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // Expected when we deliberately dropped a colliding offer; the candidates
      // that belonged to it are meaningless. Only surface it otherwise.
      if (!this.ignoreOffer) console.warn(`[mesh] addIceCandidate ${this.peerId}`, err);
    }
  }

  // ---- media -------------------------------------------------------------

  private onTrack(ev: RTCTrackEvent): void {
    // Latency knob, applied per receiver as tracks arrive.
    tuneReceiverLatency(ev.receiver, this.opts.jitterBufferTargetMs);

    const stream = ev.streams[0] ?? new MediaStream([ev.track]);
    this.remoteStream = stream;
    this.cb.onRemoteStream(this.peerId, stream);

    ev.track.addEventListener("ended", () => {
      if (this.remoteStream === stream) {
        this.remoteStream = null;
        this.cb.onRemoteStreamGone(this.peerId);
      }
    });
  }

  /**
   * Re-apply encoder settings after a live quality change. The BitrateAdapter is
   * rebuilt because it captures the preset's ceiling as its recovery target — reusing
   * the old one would let it climb back to the previous preset's bitrate.
   */
  async reapplyEncoding(): Promise<void> {
    if (!this.videoSender) return;
    this.adapter?.stop();
    await applyVideoEncoding(this.videoSender, this.opts.preset);
    // applyVideoEncoding deliberately leaves `active` alone, so set it explicitly
    // in both directions rather than only pausing.
    await this.setSenderActive(this.remoteWantsVideo);
    this.adapter = new BitrateAdapter(this.videoSender, this.opts.preset);
    this.adapter.start();
  }

  async attachCapture(capture: CaptureResult): Promise<void> {
    await this.detachCapture();

    this.videoSender = this.pc.addTrack(capture.video, capture.stream);
    if (capture.audio) {
      this.audioSender = this.pc.addTrack(capture.audio, capture.stream);
      await applyAudioEncoding(this.audioSender);
    }

    const tx = this.pc.getTransceivers().find((t) => t.sender === this.videoSender);
    if (tx) preferCodec(tx, this.opts.codec);

    await applyVideoEncoding(this.videoSender, this.opts.preset);
    await this.setSenderActive(this.remoteWantsVideo);

    this.adapter = new BitrateAdapter(this.videoSender, this.opts.preset);
    this.adapter.start();
  }

  async detachCapture(): Promise<void> {
    this.adapter?.stop();
    this.adapter = null;
    for (const s of [this.videoSender, this.audioSender]) {
      if (s) {
        try {
          this.pc.removeTrack(s);
        } catch {
          /* connection may already be closing */
        }
      }
    }
    this.videoSender = null;
    this.audioSender = null;
  }

  /**
   * Tell the far end whether we're currently rendering their video.
   *
   * The request is remembered and flushed on channel open. Tiles below the fold
   * fire their IntersectionObserver immediately on join, while the control channel
   * is still "connecting" — dropping that first `want:false` left the far end
   * uploading full-bitrate video for a tile the viewer never scrolls to, for the
   * whole session.
   */
  requestRemoteVideo(want: boolean): void {
    this.desiredView = want;
    this.flushViewRequest();
  }

  private flushViewRequest(): void {
    if (this.desiredView === null || this.control?.readyState !== "open") return;
    const msg: ControlMessage = { c: "view", want: this.desiredView };
    try {
      this.control.send(JSON.stringify(msg));
    } catch (err) {
      console.warn(`[mesh] could not send view state to ${this.peerId}`, err);
    }
  }

  private bindControl(ch: RTCDataChannel): void {
    this.control = ch;
    ch.onopen = () => this.flushViewRequest();
    // The receiving side binds an already-open channel, so onopen will not fire.
    if (ch.readyState === "open") this.flushViewRequest();
    ch.onmessage = (ev) => {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ControlMessage;
      } catch {
        return;
      }
      if (msg.c === "view") {
        this.remoteWantsVideo = msg.want;
        void this.setSenderActive(msg.want);
      }
    };
  }

  /**
   * Send-side pausing. The largest single bandwidth lever available: in a full
   * 8-person room a lone sharer needs ~42 Mbps up, and not sending video that nobody
   * is looking at removes most of that. At this room size it is what keeps the mesh
   * viable on an ordinary home uplink.
   */
  private async setSenderActive(active: boolean): Promise<void> {
    if (!this.videoSender) return;
    const params = this.videoSender.getParameters();
    const e = params.encodings?.[0];
    if (!e || e.active === active) return;
    e.active = active;
    try {
      await this.videoSender.setParameters(params);
    } catch (err) {
      console.warn(`[mesh] setSenderActive ${this.peerId}`, err);
    }
  }

  close(): void {
    this.adapter?.stop();
    if (this.control) {
      this.control.onopen = null;
      this.control.onmessage = null;
      this.control.close();
    }
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}

export class Mesh {
  private readonly links = new Map<PeerId, PeerLink>();
  private capture: CaptureResult | null = null;

  constructor(
    private readonly selfId: PeerId,
    private readonly opts: MeshOptions,
    private readonly sendSignal: (to: PeerId, data: SignalData) => void,
    private readonly cb: MeshCallbacks,
  ) {}

  addPeer(peerId: PeerId): void {
    if (peerId === this.selfId || this.links.has(peerId)) return;
    const link = new PeerLink(
      this.selfId,
      peerId,
      this.opts,
      (data) => this.sendSignal(peerId, data),
      this.cb,
    );
    this.links.set(peerId, link);
    if (this.capture) void link.attachCapture(this.capture);
  }

  removePeer(peerId: PeerId): void {
    const link = this.links.get(peerId);
    if (!link) return;
    link.close();
    this.links.delete(peerId);
    this.cb.onRemoteStreamGone(peerId);
  }

  async handleSignal(from: PeerId, data: SignalData): Promise<void> {
    // A peer can signal before we've been told they joined; create on demand.
    if (!this.links.has(from)) this.addPeer(from);
    await this.links.get(from)?.handleSignal(data);
  }

  /** Start sharing to every peer, or pass null to stop. */
  async setCapture(capture: CaptureResult | null): Promise<void> {
    this.capture = capture;
    await Promise.all(
      [...this.links.values()].map((l) =>
        capture ? l.attachCapture(capture) : l.detachCapture(),
      ),
    );
  }

  setViewing(peerId: PeerId, viewing: boolean): void {
    this.links.get(peerId)?.requestRemoteVideo(viewing);
  }

  /**
   * Change quality for every peer without renegotiating. Codec changes cannot work
   * this way — setCodecPreferences only takes effect on the next offer — which is why
   * the UI applies codec on the next share instead.
   */
  async setPreset(preset: QualityPreset): Promise<void> {
    this.opts.preset = preset;
    await Promise.all([...this.links.values()].map((l) => l.reapplyEncoding()));
  }

  getConnection(peerId: PeerId): RTCPeerConnection | undefined {
    return this.links.get(peerId)?.pc;
  }

  peers(): PeerId[] {
    return [...this.links.keys()];
  }

  close(): void {
    for (const l of this.links.values()) l.close();
    this.links.clear();
  }
}
