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

/** Real control messages are ~25 bytes. Anything far larger is not ours. */
const MAX_CONTROL_MESSAGE_LENGTH = 256;

/**
 * Parse a control message from the far end, or null if it is not one.
 *
 * The far end is another browser in the room, not something we control, so the shape
 * is checked rather than cast: a `want` that is not a boolean would otherwise flow
 * straight into `encodings[0].active`.
 */
export function parseControlMessage(data: unknown): ControlMessage | null {
  if (typeof data !== "string" || data.length > MAX_CONTROL_MESSAGE_LENGTH) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  if (rec.c !== "view" || typeof rec.want !== "boolean") return null;
  return { c: "view", want: rec.want };
}

/**
 * Drop every ICE candidate line that is not a relay candidate.
 *
 * Relay-only mode already sets iceTransportPolicy "relay", which stops the browser
 * gathering anything else. This is the second lock on the same door: the SDP is what
 * the far end actually receives, so it is checked on the way out rather than trusted.
 */
export function keepRelayCandidatesOnly(sdp: string): string {
  return sdp
    .split("\r\n")
    .filter((line) => !line.startsWith("a=candidate:") || / typ relay(?: |$)/.test(line))
    .join("\r\n");
}

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
          // Fail closed: a candidate we cannot classify is not sent.
          const parsed = parseCandidate(candidate);
          if (!parsed || parsed.type !== "relay") return;
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
      // Only the one channel this app opens. Anything else the far end offers is closed.
      if (ev.channel.label === "control") this.bindControl(ev.channel);
      else ev.channel.close();
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
      if (sdp) this.send({ k: "offer", sdp: this.outgoingSdp(sdp) });
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
        if (out) this.send({ k: "answer", sdp: this.outgoingSdp(out) });
      }
    } catch (err) {
      this.isSettingRemoteAnswerPending = false;
      console.error(`[mesh] setDescription(${kind}) failed for ${this.peerId}`, err);
    }
  }

  /** The SDP as it leaves this browser: relay candidates only in relay-only mode. */
  private outgoingSdp(sdp: string): string {
    return this.opts.relayOnly ? keepRelayCandidatesOnly(sdp) : sdp;
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
    // Always open an audio sender, even while silent. A whole-screen share starts
    // with no audio and gets the game's audio from a second pick moments later, and
    // the user can swap sources mid-share. With the sender already negotiated, each
    // of those is a replaceTrack with no renegotiation. Tagging it with the video's
    // stream keeps the two in one MediaStream on the far end, so they play in sync.
    if (capture.audio) {
      this.audioSender = this.pc.addTrack(capture.audio, capture.stream);
    } else {
      this.audioSender = this.pc.addTransceiver("audio", {
        direction: "sendonly",
        streams: [capture.stream],
      }).sender;
    }
    await applyAudioEncoding(this.audioSender);

    const tx = this.pc.getTransceivers().find((t) => t.sender === this.videoSender);
    if (tx) preferCodec(tx, this.opts.codec);

    await applyVideoEncoding(this.videoSender, this.opts.preset);
    await this.setSenderActive(this.remoteWantsVideo);

    this.adapter = new BitrateAdapter(this.videoSender, this.opts.preset);
    this.adapter.start();
  }

  /** Swap the audio being sent without renegotiating. Null sends silence. */
  async replaceAudio(track: MediaStreamTrack | null): Promise<void> {
    await this.audioSender?.replaceTrack(track);
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
      const msg = parseControlMessage(ev.data);
      if (!msg) return;
      this.remoteWantsVideo = msg.want;
      void this.setSenderActive(msg.want);
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

  /**
   * Swap the shared audio for every peer. Also updates the capture itself, so a peer
   * who joins later is sent the current source rather than the original one.
   */
  async setAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    if (!this.capture) return;
    this.capture.audio = track;
    await Promise.all([...this.links.values()].map((l) => l.replaceAudio(track)));
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
