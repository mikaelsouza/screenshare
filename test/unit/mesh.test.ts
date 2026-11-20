import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalData } from "@shared/protocol";
import type { CaptureResult } from "@src/capture";
import {
  Mesh,
  type MeshCallbacks,
  type MeshOptions,
  parseControlMessage,
} from "@src/mesh";

class FakeDataChannel {
  readyState = "open";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];

  readonly label: string;
  constructor(label: string) { this.label = label; }

  send: (data: string) => void = (data: string): void => {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = "closed";
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];

  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((ev: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel | RTCDataChannel }) => void) | null = null;

  connectionState: RTCPeerConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;

  senders: RTCRtpSender[] = [];
  transceivers: RTCRtpTransceiver[] = [];
  dataChannels: FakeDataChannel[] = [];
  addedCandidates: RTCIceCandidateInit[] = [];
  closed = false;

  readonly config: RTCConfiguration;
  constructor(config: RTCConfiguration) {
    this.config = config;
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(label: string): FakeDataChannel {
    const ch = new FakeDataChannel(label);
    this.dataChannels.push(ch);
    return ch;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n" };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { type: desc.type ?? "offer", sdp: desc.sdp ?? "" };
    this.signalingState = this.localDescription.type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = { type: desc.type ?? "answer", sdp: desc.sdp ?? "" };
    // An offer in have-local-offer is Chrome's implicit rollback: ours is dropped.
    this.signalingState = this.remoteDescription.type === "offer" ? "have-remote-offer" : "stable";
  }

  restartIceCalls = 0;
  restartIce(): void {
    this.restartIceCalls++;
  }

  setConfiguration = vi.fn((_config?: RTCConfiguration): void => {});

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  addTrack(track: MediaStreamTrack | null, ..._streams: MediaStream[]): RTCRtpSender {
    let params: Record<string, unknown> = { encodings: [{ active: true, maxBitrate: 5_000_000 }] };
    const sender = {
      track,
      getParameters: () => structuredClone(params),
      setParameters: async (p: Record<string, unknown>) => { params = structuredClone(p); },
      getStats: async () => new Map() as unknown as RTCStatsReport,
      replaceTrack: async (t: MediaStreamTrack | null) => { (sender as { track: unknown }).track = t; },
    } as unknown as RTCRtpSender;
    this.senders.push(sender);

    const transceiver = {
      sender,
      setCodecPreferences: vi.fn(),
    } as unknown as RTCRtpTransceiver;
    this.transceivers.push(transceiver);

    return sender;
  }

  addTransceiver(trackOrKind: MediaStreamTrack | string, _init?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    const sender = this.addTrack(typeof trackOrKind === "string" ? null : trackOrKind);
    return this.transceivers.find((t) => t.sender === sender)!;
  }

  removeTrack(sender: RTCRtpSender): void {
    const idx = this.senders.indexOf(sender);
    if (idx !== -1) this.senders.splice(idx, 1);
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return this.transceivers;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

describe("Mesh and PeerLink", () => {
  let callbacks: MeshCallbacks;
  let sentSignals: Array<{ to: string; data: SignalData }>;
  const defaultOptions: MeshOptions = {
    iceServers: [{ urls: "stun:stun.example.com" }],
    preset: { label: "720p60", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 },
    codec: "h264",
    jitterBufferTargetMs: 0,
  };

  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }),
    };

    sentSignals = [];
    callbacks = {
      onRemoteStream: vi.fn(),
      onRemoteStreamGone: vi.fn(),
      onConnectionState: vi.fn(),
    };
  });

  it("lets the initiator open the control channel, by id order only when both share", () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);

    // The initiator opens it whatever its politeness (alice < bob: alice is polite).
    mesh.addPeer("bob");
    const pc1 = FakeRTCPeerConnection.instances[0]!;
    expect(pc1.dataChannels.map((c) => c.label)).toEqual(["control"]);

    // Both sharing, so both may be initiating: only the impolite (larger id) side opens it.
    mesh.addMember("carol", true);
    mesh.addPeer("carol");
    expect(FakeRTCPeerConnection.instances[1]!.dataChannels).toHaveLength(0);
    mesh.addMember("aaron", true);
    mesh.addPeer("aaron");
    expect(FakeRTCPeerConnection.instances[2]!.dataChannels).toHaveLength(1);

    // The answering side never opens one.
    mesh.addPeer("zed", true);
    expect(FakeRTCPeerConnection.instances[3]!.dataChannels).toHaveLength(0);
  });

  it("negotiates offers and answers between peers", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addMember("bob", true);
    mesh.addPeer("bob");
    const pc = FakeRTCPeerConnection.instances[0]!;

    // negotiationneeded trigger
    pc.onnegotiationneeded?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(sentSignals.some((s) => s.to === "bob" && s.data.k === "offer")).toBe(true);

    // handle remote offer
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n" });
    expect(sentSignals.some((s) => s.to === "bob" && s.data.k === "answer")).toBe(true);

    // handle remote answer
    await mesh.handleSignal("bob", { k: "answer", sdp: "v=0\r\nm=audio 9 UDP/TLS/SAVPF 111\r\n" });
    expect(pc.remoteDescription?.type).toBe("answer");

    // handle ICE candidate
    await mesh.handleSignal("bob", {
      k: "ice",
      candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 1234 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    });
    expect(pc.addedCandidates.length).toBe(1);
  });

  it("handles track events and connection state changes", () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");
    const pc = FakeRTCPeerConnection.instances[0]!;

    // Connection state
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    expect(callbacks.onConnectionState).toHaveBeenCalledWith("bob", "connected");

    // Remote track
    let endedHandler: (() => void) | undefined;
    const mockTrack = {
      addEventListener: vi.fn((ev: string, fn: () => void) => {
        if (ev === "ended") endedHandler = fn;
      }),
    } as unknown as MediaStreamTrack;
    const mockStream = { getTracks: () => [mockTrack] } as unknown as MediaStream;
    pc.ontrack?.({
      track: mockTrack,
      streams: [mockStream],
      receiver: {} as unknown as RTCRtpReceiver,
    } as unknown as RTCTrackEvent);
    expect(callbacks.onRemoteStream).toHaveBeenCalledWith("bob", mockStream);

    // Track ended
    endedHandler?.();
    expect(callbacks.onRemoteStreamGone).toHaveBeenCalledWith("bob");
  });

  it("attaches and detaches screen capture to peers", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");
    const pc = FakeRTCPeerConnection.instances[0]!;

    const videoTrack = { kind: "video" } as unknown as MediaStreamTrack;
    const audioTrack = { kind: "audio" } as unknown as MediaStreamTrack;
    const capture: CaptureResult = {
      stream: { getTracks: () => [videoTrack, audioTrack] } as unknown as MediaStream,
      video: videoTrack,
      audio: audioTrack,
    };

    await mesh.setCapture(capture);
    expect(pc.senders.length).toBe(2);
    expect(pc.senders[0]?.track).toBe(videoTrack);
    expect(pc.senders[1]?.track).toBe(audioTrack);

    await mesh.setCapture(null);
    expect(pc.senders.length).toBe(2);
    expect(pc.senders[0]?.track).toBeNull();
    expect(pc.senders[1]?.track).toBeNull();
  });

  it("opens a silent audio sender and swaps audio in without renegotiating", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");
    const pc = FakeRTCPeerConnection.instances[0]!;

    const videoTrack = { kind: "video" } as unknown as MediaStreamTrack;
    const capture: CaptureResult = {
      stream: { getTracks: () => [videoTrack] } as unknown as MediaStream,
      video: videoTrack,
      audio: null,
    };
    await mesh.setCapture(capture);
    // Video plus an audio sender with nothing on it yet.
    expect(pc.senders.length).toBe(2);
    expect(pc.senders[1]!.track).toBeNull();

    const gameAudio = { kind: "audio" } as unknown as MediaStreamTrack;
    await mesh.setAudioTrack(gameAudio);
    expect(pc.senders.length).toBe(2);
    expect(pc.senders[1]!.track).toBe(gameAudio);
    // A peer joining later must get the current source, not the original silence.
    expect(capture.audio).toBe(gameAudio);

    mesh.addPeer("carol");
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const late = FakeRTCPeerConnection.instances[1]!;
    expect(late.senders.some((s) => s.track === gameAudio)).toBe(true);

    await mesh.setAudioTrack(null);
    expect(pc.senders[1]!.track).toBeNull();
  });

  it("swaps the video for every peer without renegotiating, and for late joiners", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");
    mesh.addPeer("carol");
    const [bob, carol] = FakeRTCPeerConnection.instances;

    const lobby = { kind: "video" } as unknown as MediaStreamTrack;
    const capture: CaptureResult = {
      stream: { getTracks: () => [lobby] } as unknown as MediaStream,
      video: lobby,
      audio: null,
    };
    await mesh.setCapture(capture);
    const bobVideo = bob!.senders[0]!;
    expect(bobVideo.track).toBe(lobby);

    const game = { kind: "video" } as unknown as MediaStreamTrack;
    await mesh.setVideoTrack(game);
    expect(capture.video).toBe(game);
    for (const pc of [bob!, carol!]) {
      expect(pc.senders).toHaveLength(2);
      expect(pc.senders[0]!.track).toBe(game);
    }
    // The same sender, so encoder settings carry over.
    expect(bob!.senders[0]).toBe(bobVideo);

    mesh.addPeer("dave");
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeRTCPeerConnection.instances[2]!.senders[0]!.track).toBe(game);
  });

  it("survives a swap racing a peer who just joined, and sends that peer the new window", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    const lobby = { kind: "video" } as unknown as MediaStreamTrack;
    await mesh.setCapture({ stream: { getTracks: () => [lobby] } as unknown as MediaStream, video: lobby, audio: null });
    // The new link attaches the capture asynchronously; the swap lands first.
    mesh.addPeer("dave");
    const game = { kind: "video" } as unknown as MediaStreamTrack;
    await expect(mesh.setVideoTrack(game)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeRTCPeerConnection.instances[0]!.senders[0]!.track).toBe(game);
  });

  it("ignores a video swap when not sharing", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");
    await mesh.setVideoTrack({ kind: "video" } as unknown as MediaStreamTrack);
    expect(FakeRTCPeerConnection.instances[0]!.senders).toHaveLength(0);
  });

  it("sends and handles view control messages via data channel", () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("aaron"); // alice is impolite, creates channel
    const pc = FakeRTCPeerConnection.instances[0]!;
    const ch = pc.dataChannels[0]!;

    mesh.setViewing("aaron", false);
    expect(ch.sent).toContain(JSON.stringify({ c: "view", want: false }));

    // Far end sends view request
    ch.onmessage?.({ data: JSON.stringify({ c: "view", want: true }) });
    expect(mesh.getConnection("aaron")).toBeDefined();
  });

  it("re-applies quality presets to all peers and preserves send-side pause state", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");
    mesh.addPeer("aaron"); // impolite: has control data channel

    // setPreset before sharing (when videoSender is null) is a safe no-op
    const preset30 = { label: "720p30", width: 1280, height: 720, frameRate: 30, maxBitrate: 4_000_000 };
    await mesh.setPreset(preset30);
    expect(FakeRTCPeerConnection.instances[0]!.senders).toHaveLength(0);

    const videoTrack = { kind: "video" } as unknown as MediaStreamTrack;
    const capture: CaptureResult = {
      stream: { getTracks: () => [videoTrack] } as unknown as MediaStream,
      video: videoTrack,
      audio: null,
    };
    await mesh.setCapture(capture);

    const bobSender = FakeRTCPeerConnection.instances[0]!.senders[0]!;
    const aaronPc = FakeRTCPeerConnection.instances[1]!;
    const aaronSender = aaronPc.senders[0]!;
    expect(bobSender.getParameters().encodings?.[0]?.maxBitrate).toBe(4_000_000);
    expect(bobSender.getParameters().encodings?.[0]?.maxFramerate).toBe(30);

    // Pause aaron via control channel, keep bob active
    aaronPc.dataChannels[0]!.onmessage?.({ data: JSON.stringify({ c: "view", want: false }) });
    expect(aaronSender.getParameters().encodings?.[0]?.active).toBe(false);

    const newPreset = { label: "1080p60", width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 };
    await mesh.setPreset(newPreset);
    expect(mesh.peers()).toEqual(["bob", "aaron"]);
    expect(bobSender.getParameters().encodings?.[0]?.maxBitrate).toBe(8_000_000);
    expect(bobSender.getParameters().encodings?.[0]?.maxFramerate).toBe(60);
    expect(bobSender.getParameters().encodings?.[0]?.active).toBe(true);
    expect(bobSender.getParameters().degradationPreference).toBe("maintain-framerate");
    expect(aaronSender.getParameters().encodings?.[0]?.maxBitrate).toBe(8_000_000);
    expect(aaronSender.getParameters().encodings?.[0]?.maxFramerate).toBe(60);
    expect(aaronSender.getParameters().encodings?.[0]?.active).toBe(false);
    expect(aaronSender.getParameters().degradationPreference).toBe("maintain-framerate");

    await mesh.setDegradation("clarity");
    expect(bobSender.getParameters().degradationPreference).toBe("maintain-framerate-and-resolution");
    expect(bobSender.getParameters().encodings?.[0]?.active).toBe(true);
    expect(aaronSender.getParameters().degradationPreference).toBe("maintain-framerate-and-resolution");
    expect(aaronSender.getParameters().encodings?.[0]?.active).toBe(false);

    // Late-joining viewer while clarity mode is active receives maintain-framerate-and-resolution on attachCapture
    mesh.addMember("charlie", false);
    await new Promise((r) => setTimeout(r, 0));
    const charlieSender = FakeRTCPeerConnection.instances[2]!.senders[0]!;
    expect(charlieSender.getParameters().degradationPreference).toBe(
      "maintain-framerate-and-resolution",
    );

    await mesh.setDegradation("framerate");
    expect(bobSender.getParameters().degradationPreference).toBe("maintain-framerate");
    expect(aaronSender.getParameters().degradationPreference).toBe("maintain-framerate");
    expect(charlieSender.getParameters().degradationPreference).toBe("maintain-framerate");

    // Starting capture when MeshOptions already specifies degradation: "clarity"
    const clarityMesh = new Mesh(
      "alice",
      { ...defaultOptions, degradation: "clarity" },
      (to, data) => sentSignals.push({ to, data }),
      callbacks,
    );
    clarityMesh.addMember("dave", false);
    await clarityMesh.setCapture(capture);
    const daveSender = FakeRTCPeerConnection.instances[3]!.senders[0]!;
    expect(daveSender.getParameters().degradationPreference).toBe(
      "maintain-framerate-and-resolution",
    );
  });

  it("handles offer collisions on impolite peer by ignoring colliding offer", async () => {
    // alice > aaron: alice is impolite (!polite)
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addMember("aaron", true);
    mesh.addPeer("aaron");
    const pc = FakeRTCPeerConnection.instances[0]!;

    // Simulate signaling state not stable (makingOffer or in-flight)
    pc.signalingState = "have-local-offer";
    await mesh.handleSignal("aaron", { k: "offer", sdp: "v=0\r\n" });

    // Should ignore offer and not send an answer
    expect(sentSignals.some((s) => s.to === "aaron" && s.data.k === "answer")).toBe(false);
  });

  it("handles errors gracefully in addIce and setDescription", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addMember("bob", true);
    mesh.addPeer("bob");
    const pc = FakeRTCPeerConnection.instances[0]!;

    pc.addIceCandidate = vi.fn().mockRejectedValue(new Error("invalid candidate"));
    await expect(
      mesh.handleSignal("bob", {
        k: "ice",
        candidate: { candidate: "bad", sdpMid: null, sdpMLineIndex: null },
      }),
    ).resolves.not.toThrow();

    pc.setRemoteDescription = vi.fn().mockRejectedValue(new Error("bad sdp"));
    await expect(
      mesh.handleSignal("bob", { k: "offer", sdp: "bad sdp" }),
    ).resolves.not.toThrow();
  });

  it("toggles sender active when view message is received over control channel", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("aaron");
    const pc = FakeRTCPeerConnection.instances[0]!;
    const ch = pc.dataChannels[0]!;

    const videoTrack = { kind: "video" } as unknown as MediaStreamTrack;
    const capture: CaptureResult = {
      stream: { getTracks: () => [videoTrack] } as unknown as MediaStream,
      video: videoTrack,
      audio: null,
    };
    await mesh.setCapture(capture);

    // Far end says they are NOT viewing tile
    ch.onmessage?.({ data: JSON.stringify({ c: "view", want: false }) });
    const sender = pc.senders[0]!;
    expect(sender.getParameters().encodings?.[0]?.active).toBe(false);

    // Far end says they are viewing tile again
    ch.onmessage?.({ data: JSON.stringify({ c: "view", want: true }) });
    expect(sender.getParameters().encodings?.[0]?.active).toBe(true);

    // Ignores malformed messages
    ch.onmessage?.({ data: "not json" });
  });

  it("manages peer lifecycle and closes all connections cleanly", () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");
    mesh.addPeer("charlie");
    mesh.addPeer("aaron"); // impolite: has control data channel
    expect(mesh.peers()).toEqual(["bob", "charlie", "aaron"]);

    mesh.removePeer("bob");
    expect(callbacks.onRemoteStreamGone).toHaveBeenCalledWith("bob");
    expect(mesh.peers()).toEqual(["charlie", "aaron"]);

    mesh.close();
    expect(mesh.peers().length).toBe(0);
  });

  it("handles errors gracefully in flushViewRequest and setSenderActive", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("aaron");
    const pc = FakeRTCPeerConnection.instances[0]!;
    const ch = pc.dataChannels[0]!;

    // Throw on ch.send
    ch.send = vi.fn().mockImplementation(() => {
      throw new Error("send failure");
    });
    mesh.setViewing("aaron", false);

    const videoTrack = { kind: "video" } as unknown as MediaStreamTrack;
    const capture: CaptureResult = {
      stream: { getTracks: () => [videoTrack] } as unknown as MediaStream,
      video: videoTrack,
      audio: null,
    };
    await mesh.setCapture(capture);

    // Throw on setParameters
    const sender = pc.senders[0]!;
    sender.setParameters = vi.fn().mockRejectedValue(new Error("setParameters failure"));
    expect(ch.send).toHaveBeenCalled();
    ch.onmessage?.({ data: JSON.stringify({ c: "view", want: false }) });
  });

  it("binds control channel received via ondatachannel and handles negotiation failures", async () => {
    // alice < bob -> alice is polite, expects remote control channel via ondatachannel
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");
    const pc = FakeRTCPeerConnection.instances[0]!;

    // Non-control channel should be ignored
    pc.ondatachannel?.({ channel: new FakeDataChannel("unrelated") });

    // Control channel should be bound
    const remoteControl = new FakeDataChannel("control");
    pc.ondatachannel?.({ channel: remoteControl });

    // Negotiation failure handling
    pc.createOffer = vi.fn().mockRejectedValue(new Error("offer creation failed"));
    expect(pc.dataChannels).toBeDefined();
    pc.onnegotiationneeded?.();
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe("channel hardening", () => {
  let sent: SignalData[];
  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    sent = [];
  });

  it("closes data channels other than the control channel", () => {
    const opts: MeshOptions = {
      iceServers: [{ urls: "stun:stun.example.com" }],
      preset: { label: "720p60", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 },
      codec: "h264",
      jitterBufferTargetMs: 0,
    };
    const mesh = new Mesh("alice", opts, (_to, data) => sent.push(data), {
      onRemoteStream: vi.fn(),
      onRemoteStreamGone: vi.fn(),
      onConnectionState: vi.fn(),
    });
    mesh.addPeer("bob");
    const pc = FakeRTCPeerConnection.instances[0]!;
    const stray = new FakeDataChannel("exfil");
    pc.ondatachannel?.({ channel: stray });
    expect(stray.readyState).toBe("closed");
  });
});

describe("parseControlMessage", () => {
  it("accepts a well-formed view message", () => {
    expect(parseControlMessage('{"c":"view","want":false}')).toEqual({ c: "view", want: false });
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a non-boolean want", '{"c":"view","want":"x"}'],
    ["an unknown type", '{"c":"other","want":true}'],
    ["invalid JSON", "not json"],
    ["an oversized payload", JSON.stringify({ c: "view", want: true, pad: "x".repeat(10_000) })],
  ])("rejects %s", (_name, raw) => {
    expect(parseControlMessage(raw)).toBeNull();
  });

  it("rejects binary payloads", () => {
    expect(parseControlMessage(new ArrayBuffer(8))).toBeNull();
  });
});

describe("Mesh connects only where someone is sharing", () => {
  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }),
    };
  });

  const opts: MeshOptions = {
    iceServers: [],
    preset: { label: "720p60", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 },
    codec: "h264",
    jitterBufferTargetMs: 0,
  };
  const cb = (): MeshCallbacks => ({ onRemoteStream: vi.fn(), onRemoteStreamGone: vi.fn(), onConnectionState: vi.fn() });
  const capture = (): CaptureResult => {
    const video = { kind: "video" } as unknown as MediaStreamTrack;
    return { stream: { getTracks: () => [video] } as unknown as MediaStream, video, audio: null };
  };

  it("creates no connection to members who are not sharing", () => {
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", false);
    mesh.addMember("carol", false);
    expect(mesh.peers()).toEqual([]);
    expect(FakeRTCPeerConnection.instances).toHaveLength(0);
  });

  it("leaves connecting to the sharer, and drops the link when they stop", async () => {
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", true);
    mesh.addMember("carol", false);
    // The sharer offers; a viewer starting its own link as well is what caused glare.
    expect(mesh.peers()).toEqual([]);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    expect(mesh.peers()).toEqual(["bob"]);
    // The answering side never opens the control channel; the sharer did.
    expect(FakeRTCPeerConnection.instances[0]?.dataChannels).toHaveLength(0);

    mesh.setMemberSharing("bob", false);
    expect(mesh.peers()).toEqual([]);
    expect(FakeRTCPeerConnection.instances[0]?.closed).toBe(true);
  });

  it("connects to everyone while we share, and back to sharers only afterwards", async () => {
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", false);
    mesh.addMember("carol", true);
    await mesh.handleSignal("carol", { k: "offer", sdp: "v=0\r\n" });
    expect(mesh.peers()).toEqual(["carol"]);

    await mesh.setCapture(capture());
    expect(mesh.peers().sort()).toEqual(["bob", "carol"]);
    // Every link carries exactly one video and one audio sender: no double attach.
    for (const pc of FakeRTCPeerConnection.instances) expect(pc.senders).toHaveLength(2);

    // A member joining mid-share is connected at once.
    mesh.addMember("dave", false);
    expect(mesh.peers()).toContain("dave");

    await mesh.setCapture(null);
    expect(mesh.peers()).toEqual(["carol"]);
  });

  it("ignores an offer from someone who is not sharing", async () => {
    // The server refuses these too; a viewer must never be able to make another
    // viewer connect to it and reveal their address.
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", false);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    expect(mesh.peers()).toEqual([]);
    expect(FakeRTCPeerConnection.instances).toHaveLength(0);
  });

  it("does not bring a closed link back for a late candidate or answer", async () => {
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", false);
    await mesh.setCapture(capture());
    await mesh.setCapture(null);
    expect(mesh.peers()).toEqual([]);
    await mesh.handleSignal("bob", { k: "ice", candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
    await mesh.handleSignal("bob", { k: "answer", sdp: "v=0\r\n" });
    expect(mesh.peers()).toEqual([]);
  });

  it("keeps the link to a sharer when we stop sharing ourselves", async () => {
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    await mesh.setCapture(capture());
    await mesh.setCapture(null);
    expect(mesh.peers()).toEqual(["bob"]);
    expect(FakeRTCPeerConnection.instances[0]?.closed).toBe(false);
  });

  it("removes a member's link when they leave", () => {
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", true);
    mesh.removeMember("bob");
    expect(mesh.peers()).toEqual([]);
  });
});

describe("negotiation recovery", () => {
  const opts: MeshOptions = {
    iceServers: [],
    preset: { label: "720p60", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 },
    codec: "h264",
    jitterBufferTargetMs: 0,
  };
  const cb = (): MeshCallbacks => ({ onRemoteStream: vi.fn(), onRemoteStreamGone: vi.fn(), onConnectionState: vi.fn() });
  const capture = (): CaptureResult => {
    const video = { kind: "video" } as unknown as MediaStreamTrack;
    return { stream: { getTracks: () => [video] } as unknown as MediaStream, video, audio: null };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }),
    };
  });

  it("offers again after losing a glare as the polite side", async () => {
    // "me" < "zed", so we are polite: their offer wins and ours is rolled back. What
    // ours carried still has to be offered, or our video to them never arrives.
    const sent: SignalData[] = [];
    const mesh = new Mesh("me", opts, (_to, d) => sent.push(d), cb());
    mesh.addMember("zed", true);
    await mesh.setCapture(capture());
    const pc = FakeRTCPeerConnection.instances[0]!;
    pc.signalingState = "have-local-offer"; // our offer is out
    await mesh.handleSignal("zed", { k: "offer", sdp: "v=0\r\n" });
    await flush();
    const kinds = sent.map((d) => d.k);
    expect(kinds).toContain("answer");
    expect(kinds.lastIndexOf("offer")).toBeGreaterThan(kinds.indexOf("answer"));
  });

  it("restarts ICE from the sharing side when a link fails, and only there", async () => {
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", false);
    await mesh.setCapture(capture());
    const sharerPc = FakeRTCPeerConnection.instances[0]!;
    sharerPc.connectionState = "failed";
    sharerPc.onconnectionstatechange?.();
    expect(sharerPc.restartIceCalls).toBe(1);

    const viewer = new Mesh("v", opts, () => {}, cb());
    viewer.addMember("s", true);
    await viewer.handleSignal("s", { k: "offer", sdp: "v=0\r\n" });
    const viewerPc = FakeRTCPeerConnection.instances[1]!;
    viewerPc.connectionState = "failed";
    viewerPc.onconnectionstatechange?.();
    expect(viewerPc.restartIceCalls).toBe(0);
  });

  it("does not tear down remote stream when an audio track ends, only when video ends", async () => {
    const callbacks = cb();
    const mesh = new Mesh("me", opts, () => {}, callbacks);
    mesh.addMember("streamer", true);
    await mesh.handleSignal("streamer", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;

    const audioListeners: Record<string, () => void> = {};
    const audioTrack = {
      kind: "audio",
      addEventListener: (ev: string, fn: () => void) => { audioListeners[ev] = fn; },
    } as unknown as MediaStreamTrack;

    const videoListeners: Record<string, () => void> = {};
    const videoTrack = {
      kind: "video",
      addEventListener: (ev: string, fn: () => void) => { videoListeners[ev] = fn; },
    } as unknown as MediaStreamTrack;

    const fakeStream = {
      id: "remote-stream",
      getTracks: () => [audioTrack, videoTrack],
    } as unknown as MediaStream;

    // Simulate video track arrival
    pc.ontrack?.({
      track: videoTrack,
      receiver: {} as unknown as RTCRtpReceiver,
      streams: [fakeStream],
    } as unknown as RTCTrackEvent);
    expect(callbacks.onRemoteStream).toHaveBeenCalledWith("streamer", fakeStream);

    // Simulate audio track arrival on same stream
    pc.ontrack?.({
      track: audioTrack,
      receiver: {} as unknown as RTCRtpReceiver,
      streams: [fakeStream],
    } as unknown as RTCTrackEvent);

    // Audio track ends -> onRemoteStreamGone should NOT be called
    audioListeners["ended"]?.();
    expect(callbacks.onRemoteStreamGone).not.toHaveBeenCalled();

    // Video track ends -> onRemoteStreamGone IS called
    videoListeners["ended"]?.();
    expect(callbacks.onRemoteStreamGone).toHaveBeenCalledWith("streamer");
  });

  it("applies jitterBufferTargetMs on incoming track receivers", async () => {
    const mesh = new Mesh("me", { ...opts, jitterBufferTargetMs: 150 }, () => {}, cb());
    mesh.addMember("streamer", false);
    await mesh.setCapture(capture());
    const pc = FakeRTCPeerConnection.instances[0]!;
    const receiver = {
      jitterBufferTarget: null,
      playoutDelayHint: null,
    } as unknown as RTCRtpReceiver;

    const fakeTrack = { kind: "video", addEventListener: () => {} } as unknown as MediaStreamTrack;
    pc.ontrack?.({
      track: fakeTrack,
      receiver,
      streams: [{ id: 'mock-stream' } as unknown as MediaStream],
    } as unknown as RTCTrackEvent);

    const r = receiver as unknown as { jitterBufferTarget: number; playoutDelayHint: number };
    expect(r.jitterBufferTarget).toBe(150);
    expect(r.playoutDelayHint).toBe(0.15);
  });

  it("ignores setMemberSharing and handleSignal for unknown non-members", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("me", opts, (to, data) => signals.push({ to, data }), cb());
    mesh.setMemberSharing("ghost", true);
    expect(mesh.memberIds()).toEqual([]);
    await mesh.handleSignal("ghost", { k: "offer", sdp: "v=0\r\n" });
    expect(mesh.peers()).toEqual([]);
    expect(FakeRTCPeerConnection.instances).toHaveLength(0);

    await mesh.setCapture(capture());
    mesh.setMemberSharing("ghost", false);
    expect(mesh.memberIds()).toEqual([]);
    expect(FakeRTCPeerConnection.instances).toHaveLength(0);
    await mesh.setCapture(null);
  });

  it("exposes memberIds matching room membership even without P2P links", () => {
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", false);
    mesh.addMember("carol", false);
    expect(mesh.peers()).toEqual([]);
    expect(mesh.memberIds()).toEqual(["bob", "carol"]);
    mesh.removeMember("bob");
    expect(mesh.memberIds()).toEqual(["carol"]);
  });

  it("retries offer on glare during createOffer when member exists", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("alice", opts, (to, data) => signals.push({ to, data }), cb());
    mesh.addMember("bob", true);
    await mesh.setCapture(capture());
    const [pc] = FakeRTCPeerConnection.instances;
    if (!pc) throw new Error("Expected peer connection");
    pc.onicecandidate?.({
      candidate: { candidate: "cand1", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "u1" } as RTCIceCandidate,
    });
    expect(signals.some((s) => s.data.k === "ice")).toBe(true);

    // Glare during createOffer where remote offer arrived & settled while createOffer was pending
    let resolveOffer!: (d: RTCSessionDescriptionInit) => void;
    let firstOffer = true;
    pc.createOffer = (): Promise<RTCSessionDescriptionInit> => {
      if (firstOffer) {
        firstOffer = false;
        return new Promise<RTCSessionDescriptionInit>((r) => {
          resolveOffer = r;
        });
      }
      return Promise.resolve({ type: "offer", sdp: "v=0\r\n" });
    };
    pc.onnegotiationneeded?.();
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    pc.signalingState = "stable";
    resolveOffer({ type: "offer", sdp: "v=0\r\n" });
    await new Promise((r) => setTimeout(r, 10));
  });

  it("exposes hasConnectedLink based on connectionState", async () => {
    const mesh = new Mesh("me", opts, () => {}, cb());
    mesh.addMember("bob", false);
    await mesh.setCapture(capture());
    const [pc] = FakeRTCPeerConnection.instances;
    if (!pc) throw new Error("Expected peer connection");

    expect(mesh.hasConnectedLink("bob")).toBe(false);
    pc.connectionState = "connecting";
    expect(mesh.hasConnectedLink("bob")).toBe(true);
    pc.connectionState = "connected";
    expect(mesh.hasConnectedLink("bob")).toBe(true);
    pc.connectionState = "disconnected";
    expect(mesh.hasConnectedLink("bob")).toBe(false);
  });

  it("supports live setCodec renegotiation and isPeerViewing inspection", async () => {
    const signals: Array<{ to: string; data: unknown }> = [];
    const mesh = new Mesh("me", { ...opts }, (to, data) => signals.push({ to, data }), cb());
    mesh.addMember("bob", false);
    expect(mesh.isPeerViewing("bob")).toBe(false);

    await mesh.setCapture(capture());
    expect(mesh.isPeerViewing("bob")).toBe(true);

    const [pc] = FakeRTCPeerConnection.instances;
    const ch = pc?.dataChannels[0];
    if (!pc || !ch) throw new Error("Expected peer connection and data channel");
    ch.onmessage?.({ data: JSON.stringify({ c: "view", want: false }) });
    expect(mesh.isPeerViewing("bob")).toBe(false);

    // Trigger and answer initial offer so signalingState is stable before live codec change
    pc.onnegotiationneeded?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pc.signalingState).toBe("have-local-offer");
    await mesh.handleSignal("bob", { k: "answer", sdp: "v=0\r\n" });

    // Live codec change updates preference and triggers renegotiation offer
    signals.length = 0;
    mesh.setCodec("av1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals.some((sig) => (sig.data as { k?: string }).k === "offer")).toBe(true);
  });

  it("flushes a queued setCodec renegotiation offer after an in-flight offer receives its answer", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("me", { ...opts }, (to, data) => signals.push({ to, data }), cb());
    mesh.addMember("bob", false);
    await mesh.setCapture(capture());

    const [pc] = FakeRTCPeerConnection.instances;
    if (!pc) throw new Error("Expected peer connection");
    // Trigger initial offer so signalingState becomes "have-local-offer"
    pc.onnegotiationneeded?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pc.signalingState).toBe("have-local-offer");
    signals.length = 0;

    // Change codec while the local offer is still awaiting an answer
    mesh.setCodec("av1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals.length).toBe(0);

    // Once the remote answer arrives and signaling returns to "stable", the queued offer is flushed
    await mesh.handleSignal("bob", { k: "answer", sdp: "v=0\r\n" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals.some((sig) => sig.data.k === "offer")).toBe(true);
  });

  it("defers onnegotiationneeded during attachCapture until codec preference and sender parameters are applied", async () => {
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => ({
        codecs: [{ mimeType: "video/VP8" }, { mimeType: "video/AV1" }],
      }),
    };

    const events: string[] = [];
    const signals: Array<{ to: string; data: SignalData }> = [];

    const addTransceiverSpy = vi
      .spyOn(FakeRTCPeerConnection.prototype, "addTransceiver")
      .mockImplementation(function (
        this: FakeRTCPeerConnection,
        trackOrKind: MediaStreamTrack | string,
      ): RTCRtpTransceiver {
        const sender = this.addTrack(typeof trackOrKind === "string" ? null : trackOrKind);
        const tx = this.transceivers.find((t) => t.sender === sender)!;
        const isVideo = typeof trackOrKind !== "string";
        tx.setCodecPreferences = vi.fn((codecs: readonly RTCRtpCodec[]) => {
          events.push(`setCodecPreferences:${codecs[0]?.mimeType ?? "none"}`);
        });
        const origSetParams = tx.sender.setParameters.bind(tx.sender);
        tx.sender.setParameters = async (p: RTCRtpSendParameters) => {
          await new Promise((r) => setTimeout(r, 5));
          events.push(`setParameters:${isVideo ? "video" : "audio"}`);
          return origSetParams(p);
        };
        // Simulate Chrome firing onnegotiationneeded on the microtask queue right after addTransceiver
        queueMicrotask(() => this.onnegotiationneeded?.());
        return tx;
      });

    const createOfferSpy = vi
      .spyOn(FakeRTCPeerConnection.prototype, "createOffer")
      .mockImplementation(async () => {
        events.push("createOffer");
        return {
          type: "offer",
          sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n",
        };
      });

    try {
      const mesh = new Mesh(
        "me",
        { ...opts, codec: "av1" },
        (to, data) => signals.push({ to, data }),
        cb(),
      );
      mesh.addMember("bob", false);
      await mesh.setCapture(capture());
      await new Promise((r) => setTimeout(r, 10));

      expect(events[0]).toBe("setCodecPreferences:video/AV1");
      const offerIdx = events.indexOf("createOffer");
      expect(offerIdx).toBeGreaterThan(events.indexOf("setCodecPreferences:video/AV1"));
      expect(offerIdx).toBeGreaterThan(events.indexOf("setParameters:video"));
      expect(offerIdx).toBeGreaterThan(events.indexOf("setParameters:audio"));
      expect(signals.some((s) => s.data.k === "offer")).toBe(true);
    } finally {
      addTransceiverSpy.mockRestore();
      createOfferSpy.mockRestore();
    }
  });

  it("munges x-google-start-bitrate into outgoing offers, outgoing answers, and incoming remote descriptions", async () => {
    const videoSdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "m=video 9 UDP/TLS/RTP/SAVPF 45",
      "a=rtpmap:45 AV1/90000",
      "a=fmtp:45 level-idx=5;profile=0;tier=0",
      "",
    ].join("\r\n");

    const createOfferSpy = vi
      .spyOn(FakeRTCPeerConnection.prototype, "createOffer")
      .mockResolvedValue({ type: "offer", sdp: videoSdp });
    const createAnswerSpy = vi
      .spyOn(FakeRTCPeerConnection.prototype, "createAnswer")
      .mockResolvedValue({ type: "answer", sdp: videoSdp });

    try {
      const signals: Array<{ to: string; data: SignalData }> = [];
      const mesh = new Mesh("me", { ...opts, codec: "av1" }, (to, data) => signals.push({ to, data }), cb());
      mesh.addMember("bob", true);
      await mesh.setCapture(capture());

      const [pc] = FakeRTCPeerConnection.instances;
      if (!pc) throw new Error("Expected peer connection");

      // Outgoing offer
      pc.onnegotiationneeded?.();
      await new Promise((r) => setTimeout(r, 10));
      const offerSig = signals.find((s) => s.data.k === "offer");
      expect(offerSig?.data.k).toBe("offer");
      if (offerSig?.data.k === "offer") {
        expect(offerSig.data.sdp).toContain("x-google-start-bitrate=6000");
      }

      // Incoming remote answer
      await mesh.handleSignal("bob", { k: "answer", sdp: videoSdp });
      expect(pc.remoteDescription?.sdp).toContain("x-google-start-bitrate=6000");

      // Incoming remote offer + outgoing answer
      signals.length = 0;
      await mesh.handleSignal("bob", { k: "offer", sdp: videoSdp });
      expect(pc.remoteDescription?.sdp).toContain("x-google-start-bitrate=6000");
      const answerSig = signals.find((s) => s.data.k === "answer");
      expect(answerSig?.data.k).toBe("answer");
      if (answerSig?.data.k === "answer") {
        expect(answerSig.data.sdp).toContain("x-google-start-bitrate=6000");
      }
    } finally {
      createOfferSpy.mockRestore();
      createAnswerSpy.mockRestore();
    }
  });

  it("suppresses setParameters rejections when link closes during attachCapture, while rethrowing errors on open links", async () => {
    let shouldCloseDuringSetParams = true;

    const addTransceiverSpy = vi
      .spyOn(FakeRTCPeerConnection.prototype, "addTransceiver")
      .mockImplementation(function (
        this: FakeRTCPeerConnection,
        trackOrKind: MediaStreamTrack | string,
      ): RTCRtpTransceiver {
        const sender = this.addTrack(typeof trackOrKind === "string" ? null : trackOrKind);
        const tx = this.transceivers.find((t) => t.sender === sender)!;
        tx.sender.setParameters = async () => {
          await Promise.resolve();
          if (shouldCloseDuringSetParams) {
            this.signalingState = "closed";
          }
          throw new Error("InvalidStateError: PeerConnection is closed");
        };
        return tx;
      });

    try {
      const mesh = new Mesh("me", opts, () => {}, cb());
      mesh.addMember("bob", false);

      // Case 1: link closes while setParameters is pending -> rejection is suppressed
      await expect(mesh.setCapture(capture())).resolves.toBeUndefined();

      // Case 2: link stays open and setParameters rejects -> rejection is propagated
      await mesh.setCapture(null);
      shouldCloseDuringSetParams = false;
      mesh.removeMember("bob");
      mesh.addMember("bob", false);
      await expect(mesh.setCapture(capture())).rejects.toThrow("InvalidStateError");
    } finally {
      addTransceiverSpy.mockRestore();
    }
  });

  // oxlint-disable-next-line vitest/warn-todo -- tracked deferred PR #49 audit item (#50)
  it.todo("rate-limits inbound DataChannel view control messages per peer to drop high-frequency floods");
  // oxlint-disable-next-line vitest/warn-todo -- tracked deferred PR #49 audit item (#50)
  it.todo("tears down active loopback audio capture deterministically if leaveRoom races an in-flight startShare");
});

describe("persistent sendonly transceivers", () => {
  const opts: MeshOptions = {
    iceServers: [],
    preset: { label: "720p60", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 },
    codec: "h264",
    jitterBufferTargetMs: 0,
  };
  const cb = (): MeshCallbacks => ({
    onRemoteStream: vi.fn(),
    onRemoteStreamGone: vi.fn(),
    onConnectionState: vi.fn(),
  });
  const makeCapture = (withAudio: boolean): CaptureResult => {
    const video = { kind: "video" } as unknown as MediaStreamTrack;
    const audio = withAudio ? ({ kind: "audio" } as unknown as MediaStreamTrack) : null;
    return {
      stream: { getTracks: () => (audio ? [video, audio] : [video]) } as unknown as MediaStream,
      video,
      audio,
    };
  };

  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }, { mimeType: "video/AV1" }] }),
    };
  });

  it("reuses persistent sendonly transceivers across share/unshare cycles without calling removeTrack or renegotiating", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("me", { ...opts }, (to, data) => signals.push({ to, data }), cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    const addTxSpy = vi.spyOn(pc, "addTransceiver");
    const removeTrackSpy = vi.spyOn(pc, "removeTrack");

    const c1 = makeCapture(true);
    await mesh.setCapture(c1);
    expect(addTxSpy).toHaveBeenCalledTimes(2);
    expect(pc.transceivers).toHaveLength(2);
    expect(pc.senders[0]?.track).toBe(c1.video);
    expect(pc.senders[1]?.track).toBe(c1.audio);

    // Clear initial signals before testing cycle 2
    signals.length = 0;
    await mesh.setCapture(null);
    expect(removeTrackSpy).not.toHaveBeenCalled();
    expect(pc.closed).toBe(false);
    expect(pc.transceivers).toHaveLength(2);
    expect(pc.senders[0]?.track).toBeNull();
    expect(pc.senders[1]?.track).toBeNull();

    // After stopping share on a mutual link, failed connection must NOT restartIce and reapplyEncoding is a no-op
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(pc.restartIceCalls).toBe(0);
    await mesh.setPreset({ label: "1080p60", width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 });
    expect(pc.senders[0]?.getParameters().encodings?.[0]?.maxBitrate).toBe(6_000_000);

    // Cycle 2: video+audio -> video-only clears audio track to null without adding transceivers or sending offers
    pc.connectionState = "connected";
    const c2 = makeCapture(false);
    await mesh.setCapture(c2);
    await new Promise((r) => setTimeout(r, 10));
    expect(addTxSpy).toHaveBeenCalledTimes(2);
    expect(removeTrackSpy).not.toHaveBeenCalled();
    expect(pc.transceivers).toHaveLength(2);
    expect(pc.senders[0]?.track).toBe(c2.video);
    expect(pc.senders[1]?.track).toBeNull();
    expect(pc.senders[0]?.getParameters().encodings?.[0]?.maxBitrate).toBe(8_000_000);
    expect(signals.some((s) => s.data.k === "offer")).toBe(false);

    // Once active again, failed connection DOES restartIce
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(pc.restartIceCalls).toBe(1);
  });

  it("defers codec renegotiation while idle and renegotiates when resuming with a different codec", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("me", { ...opts }, (to, data) => signals.push({ to, data }), cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;

    await mesh.setCapture(makeCapture(false));
    const setCodecSpy = vi.spyOn(pc.transceivers[0]!, "setCodecPreferences");
    setCodecSpy.mockClear();
    await mesh.setCapture(null);
    signals.length = 0;

    // Changing codec while not sharing must not trigger a spurious offer
    mesh.setCodec("av1");
    await new Promise((r) => setTimeout(r, 10));
    expect(setCodecSpy).not.toHaveBeenCalled();
    expect(signals.some((s) => s.data.k === "offer")).toBe(false);

    // Resuming capture detects codec drift, updates preferences, and sends a renegotiation offer
    await mesh.setCapture(makeCapture(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(setCodecSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(setCodecSpy.mock.calls[0]?.[0] ?? [])[0]?.mimeType).toBe("video/AV1");
    expect(signals.some((s) => s.data.k === "offer")).toBe(true);
  });

  it("re-emits retained remoteStream on false -> true setMemberSharing without duplicating true -> true", async () => {
    const callbacks = cb();
    const mesh = new Mesh("me", { ...opts }, () => {}, callbacks);
    mesh.addMember("bob", true);
    await mesh.setCapture(makeCapture(false));
    const pc = FakeRTCPeerConnection.instances[0]!;

    const videoTrack = { kind: "video", addEventListener: vi.fn() } as unknown as MediaStreamTrack;
    const remoteStream = { id: "bob-stream", getTracks: () => [videoTrack] } as unknown as MediaStream;
    pc.ontrack?.({
      track: videoTrack,
      receiver: {} as unknown as RTCRtpReceiver,
      streams: [remoteStream],
    } as unknown as RTCTrackEvent);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(1);

    // Duplicate true -> true must not re-emit
    mesh.setMemberSharing("bob", true);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(1);

    // Bob stops sharing while we still share -> link stays open, stream retained
    mesh.setMemberSharing("bob", false);
    expect(pc.closed).toBe(false);
    expect(mesh.peers()).toEqual(["bob"]);

    // Bob resumes sharing via replaceTrack (no new ontrack) -> retained stream is re-emitted
    mesh.setMemberSharing("bob", true);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(2);
    expect(callbacks.onRemoteStream).toHaveBeenLastCalledWith("bob", remoteStream);

    // When both stop sharing, link is closed
    await mesh.setCapture(null);
    mesh.setMemberSharing("bob", false);
    expect(pc.closed).toBe(true);
    expect(mesh.peers()).toEqual([]);
  });

  it("serializes rapid unawaited setCapture(s1) -> setCapture(null) -> setCapture(s2) cleanly", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;

    const s1 = makeCapture(true);
    const s2 = makeCapture(false);

    const p1 = mesh.setCapture(s1);
    const p2 = mesh.setCapture(null);
    const p3 = mesh.setCapture(s2);
    await Promise.all([p1, p2, p3]);

    expect(pc.transceivers).toHaveLength(2);
    expect(pc.senders[0]?.track).toBe(s2.video);
    expect(pc.senders[1]?.track).toBeNull();
  });

  it("suppresses replaceTrack rejection when link closes mid-operation", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    await mesh.setCapture(makeCapture(true));

    let rejectReplace!: (err: Error) => void;
    pc.senders[0]!.replaceTrack = () =>
      new Promise<void>((_res, rej) => {
        rejectReplace = rej;
      });

    const swapPromise = mesh.setVideoTrack({ kind: "video" } as unknown as MediaStreamTrack);
    await Promise.resolve();
    mesh.removePeer("bob");
    rejectReplace(new Error("InvalidStateError: closed"));
    await expect(swapPromise).resolves.toBeUndefined();
    expect(pc.closed).toBe(true);
  });
});

describe("adversarial persistent-transceiver & race probes", () => {
  const opts: MeshOptions = {
    iceServers: [],
    preset: { label: "720p60", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 },
    codec: "h264",
    jitterBufferTargetMs: 0,
  };
  const cb = (): MeshCallbacks => ({
    onRemoteStream: vi.fn(),
    onRemoteStreamGone: vi.fn(),
    onConnectionState: vi.fn(),
  });
  const makeCapture = (withAudio: boolean): CaptureResult => {
    const video = { kind: "video" } as unknown as MediaStreamTrack;
    const audio = withAudio ? ({ kind: "audio" } as unknown as MediaStreamTrack) : null;
    return {
      stream: { getTracks: () => (audio ? [video, audio] : [video]) } as unknown as MediaStream,
      video,
      audio,
    };
  };
  const deferred = <T = void>(): {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (err: unknown) => void;
  } => {
    let resolve!: (v: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }, { mimeType: "video/AV1" }] }),
    };
  });

  it("serializes rapid unawaited setCapture(s1) -> setVideoTrack(v2) -> setCapture(null) cleanly", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());
    mesh.addMember("bob", true);
    mesh.addMember("carol", false);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const bobPc = FakeRTCPeerConnection.instances[0]!;
    const removeTrackSpy = vi.spyOn(bobPc, "removeTrack");

    const s1 = makeCapture(true);
    const v2 = { kind: "video" } as unknown as MediaStreamTrack;

    const p1 = mesh.setCapture(s1);
    const p2 = mesh.setVideoTrack(v2);
    const p3 = mesh.setCapture(null);
    await Promise.all([p1, p2, p3]);

    // Viewer-only peer carol must be closed; mutual peer bob stays open with null tracks.
    expect(mesh.peers()).toEqual(["bob"]);
    expect(FakeRTCPeerConnection.instances[1]?.closed).toBe(true);
    expect(bobPc.closed).toBe(false);
    expect(removeTrackSpy).not.toHaveBeenCalled();
    expect(bobPc.senders[0]?.track ?? null).toBeNull();
    expect(bobPc.senders[1]?.track ?? null).toBeNull();
  });

  it("handles direct setCapture(s1) -> setCapture(s2) without null both unawaited and awaited", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("me", { ...opts }, (to, data) => signals.push({ to, data }), cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    const addTxSpy = vi.spyOn(pc, "addTransceiver");
    const removeTrackSpy = vi.spyOn(pc, "removeTrack");

    // Unawaited s1 -> s2 directly without null
    const s1 = makeCapture(true);
    const s2 = makeCapture(true);
    await Promise.all([mesh.setCapture(s1), mesh.setCapture(s2)]);
    expect(addTxSpy).toHaveBeenCalledTimes(2);
    expect(pc.transceivers).toHaveLength(2);
    expect(pc.senders[0]?.track).toBe(s2.video);
    expect(pc.senders[1]?.track).toBe(s2.audio);

    // Awaited direct s2 (V+A) -> s3 (V-only) -> s4 (V+A) without null
    signals.length = 0;
    const s3 = makeCapture(false);
    await mesh.setCapture(s3);
    expect(addTxSpy).toHaveBeenCalledTimes(2);
    expect(removeTrackSpy).not.toHaveBeenCalled();
    expect(pc.senders[0]?.track).toBe(s3.video);
    expect(pc.senders[1]?.track).toBeNull();

    const s4 = makeCapture(true);
    await mesh.setCapture(s4);
    await new Promise((r) => setTimeout(r, 10));
    expect(addTxSpy).toHaveBeenCalledTimes(2);
    expect(removeTrackSpy).not.toHaveBeenCalled();
    expect(pc.senders[0]?.track).toBe(s4.video);
    expect(pc.senders[1]?.track).toBe(s4.audio);
    expect(signals.some((s) => s.data.k === "offer")).toBe(false);
  });

  it("transitions video+audio -> video-only -> video+audio and video-only -> video+audio on an open mutual link", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("me", { ...opts }, (to, data) => signals.push({ to, data }), cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    const addTxSpy = vi.spyOn(pc, "addTransceiver");
    const removeTrackSpy = vi.spyOn(pc, "removeTrack");

    // Start video-only, stop, then resume with video+audio, stop, video-only, stop, video+audio
    const c1 = makeCapture(false);
    await mesh.setCapture(c1);
    expect(pc.senders[0]?.track).toBe(c1.video);
    expect(pc.senders[1]?.track).toBeNull();
    signals.length = 0;

    await mesh.setCapture(null);
    const c2 = makeCapture(true);
    await mesh.setCapture(c2);
    expect(pc.senders[0]?.track).toBe(c2.video);
    expect(pc.senders[1]?.track).toBe(c2.audio);

    await mesh.setCapture(null);
    const c3 = makeCapture(false);
    await mesh.setCapture(c3);
    expect(pc.senders[0]?.track).toBe(c3.video);
    expect(pc.senders[1]?.track).toBeNull();

    await mesh.setCapture(null);
    const c4 = makeCapture(true);
    await mesh.setCapture(c4);
    await new Promise((r) => setTimeout(r, 10));

    expect(addTxSpy).toHaveBeenCalledTimes(2);
    expect(removeTrackSpy).not.toHaveBeenCalled();
    expect(pc.transceivers).toHaveLength(2);
    expect(pc.senders[0]?.track).toBe(c4.video);
    expect(pc.senders[1]?.track).toBe(c4.audio);
    expect(signals.some((s) => s.data.k === "offer")).toBe(false);
  });

  it("suppresses rejections when removeMember / removePeer / close races mid-replaceTrack and mid-detachCapture", async () => {
    // Case 1: removeMember mid-replaceTrack during cycle-2 attachCapture
    const mesh1 = new Mesh("me", { ...opts }, () => {}, cb());
    mesh1.addMember("bob", true);
    await mesh1.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc1 = FakeRTCPeerConnection.instances[0]!;
    await mesh1.setCapture(makeCapture(true));
    await mesh1.setCapture(null);

    const replaceGate = deferred();
    pc1.senders[0]!.replaceTrack = () => replaceGate.promise;
    const attachPromise = mesh1.setCapture(makeCapture(true));
    await Promise.resolve();
    mesh1.removeMember("bob");
    replaceGate.reject(new Error("InvalidStateError: closed during reattach"));
    await expect(attachPromise).resolves.toBeUndefined();
    expect(pc1.closed).toBe(true);

    // Case 2: mesh.close() mid-setAudioTrack
    const mesh2 = new Mesh("me", { ...opts }, () => {}, cb());
    mesh2.addMember("bob", true);
    await mesh2.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc2 = FakeRTCPeerConnection.instances[1]!;
    await mesh2.setCapture(makeCapture(true));

    const audioGate = deferred();
    pc2.senders[1]!.replaceTrack = () => audioGate.promise;
    const audioPromise = mesh2.setAudioTrack({ kind: "audio" } as unknown as MediaStreamTrack);
    await Promise.resolve();
    mesh2.close();
    audioGate.reject(new Error("InvalidStateError: closed during audio swap"));
    await expect(audioPromise).resolves.toBeUndefined();
    expect(pc2.closed).toBe(true);

    // Case 3: setMemberSharing(false) closing link mid-detachCapture
    const mesh3 = new Mesh("me", { ...opts }, () => {}, cb());
    mesh3.addMember("bob", true);
    await mesh3.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc3 = FakeRTCPeerConnection.instances[2]!;
    await mesh3.setCapture(makeCapture(true));

    const detachGate = deferred();
    pc3.senders[0]!.replaceTrack = () => detachGate.promise;
    const detachPromise = mesh3.setCapture(null);
    await Promise.resolve();
    mesh3.setMemberSharing("bob", false);
    detachGate.reject(new Error("InvalidStateError: closed during detach"));
    await expect(detachPromise).resolves.toBeUndefined();
    expect(pc3.closed).toBe(true);
    expect(mesh3.peers()).toEqual([]);
  });

  it("suppresses setParameters rejection when link closes mid-applyVideoEncoding during setPreset", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    await mesh.setCapture(makeCapture(false));

    const setParamsGate = deferred();
    pc.senders[0]!.setParameters = () => setParamsGate.promise;

    const presetPromise = mesh.setPreset({
      label: "1080p60",
      width: 1920,
      height: 1080,
      frameRate: 60,
      maxBitrate: 8_000_000,
    });
    await Promise.resolve();
    mesh.removeMember("bob");
    setParamsGate.reject(new Error("InvalidStateError: PeerConnection is closed"));

    await expect(presetPromise).resolves.toBeUndefined();
    expect(pc.closed).toBe(true);
  });

  it("applies setPreset and setDegradation called while attachCapture is mid-applyInitialEncodings", async () => {
    const setParamsGate = deferred();
    let intercepted = false;
    const addTxSpy = vi
      .spyOn(FakeRTCPeerConnection.prototype, "addTransceiver")
      .mockImplementation(function (
        this: FakeRTCPeerConnection,
        trackOrKind: MediaStreamTrack | string,
      ): RTCRtpTransceiver {
        const sender = this.addTrack(typeof trackOrKind === "string" ? null : trackOrKind);
        const tx = this.transceivers.find((t) => t.sender === sender)!;
        if (typeof trackOrKind !== "string" && !intercepted) {
          intercepted = true;
          const origSetParams = tx.sender.setParameters.bind(tx.sender);
          let first = true;
          tx.sender.setParameters = async (p: RTCRtpSendParameters) => {
            if (first) {
              first = false;
              await setParamsGate.promise;
            }
            return origSetParams(p);
          };
        }
        return tx;
      });

    try {
      const mesh = new Mesh("me", { ...opts }, () => {}, cb());
      mesh.addMember("bob", false);

      const attachPromise = mesh.setCapture(makeCapture(false));
      // Let runAttachCapture enter applyInitialEncodings and pause at video setParameters
      await new Promise((r) => setTimeout(r, 0));

      const presetPromise = mesh.setPreset({
        label: "1080p60",
        width: 1920,
        height: 1080,
        frameRate: 60,
        maxBitrate: 8_000_000,
      });
      const degradationPromise = mesh.setDegradation("clarity");

      setParamsGate.resolve();
      await Promise.all([attachPromise, presetPromise, degradationPromise]);

      const sender = FakeRTCPeerConnection.instances[0]!.senders[0]!;
      expect(sender.getParameters().encodings?.[0]?.maxBitrate).toBe(8_000_000);
      expect(sender.getParameters().degradationPreference).toBe("maintain-framerate-and-resolution");
    } finally {
      addTxSpy.mockRestore();
    }
  });

  it("handles setCodec before first share, mid-attachCapture, on idle round-trip, and while signaling is non-stable", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("me", { ...opts }, (to, data) => signals.push({ to, data }), cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;

    // 1. Change codec while idle before first share -> first addTransceiver uses AV1 directly
    mesh.setCodec("av1");
    await mesh.setCapture(makeCapture(false));
    const setCodecSpy = vi.spyOn(pc.transceivers[0]!, "setCodecPreferences");
    expect(setCodecSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(setCodecSpy.mock.calls[0]?.[0] ?? [])[0]?.mimeType).toBe("video/AV1");
    setCodecSpy.mockClear();

    // 2. Idle round-trip av1 -> h264 -> av1 must NOT trigger spurious renegotiation on resume
    await mesh.setCapture(null);
    signals.length = 0;
    mesh.setCodec("h264");
    mesh.setCodec("av1");
    await mesh.setCapture(makeCapture(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(setCodecSpy).not.toHaveBeenCalled();
    expect(signals.some((s) => s.data.k === "offer")).toBe(false);

    // 3. Mid-attachCapture codec change is detected by syncCodecIfChanged and triggers renegotiation
    await mesh.setCapture(null);
    const paramsGate = deferred();
    const origSetParams = pc.senders[0]!.setParameters.bind(pc.senders[0]!);
    let blockOnce = true;
    pc.senders[0]!.setParameters = async (p: RTCRtpSendParameters) => {
      if (blockOnce) {
        blockOnce = false;
        await paramsGate.promise;
      }
      return origSetParams(p);
    };

    signals.length = 0;
    const attachPromise = mesh.setCapture(makeCapture(false));
    await new Promise((r) => setTimeout(r, 0));
    mesh.setCodec("h264");
    paramsGate.resolve();
    await attachPromise;
    await new Promise((r) => setTimeout(r, 10));
    expect(setCodecSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(setCodecSpy.mock.calls[0]?.[0] ?? [])[0]?.mimeType).toBe("video/H264");
    expect(signals.some((s) => s.data.k === "offer")).toBe(true);

    // 4. Idle codec drift resumed while signalingState === "have-local-offer" flushes offer after remote answer
    await mesh.handleSignal("bob", { k: "answer", sdp: "v=0\r\n" });
    await mesh.setCapture(null);
    setCodecSpy.mockClear();
    signals.length = 0;
    mesh.setCodec("av1");
    pc.signalingState = "have-local-offer";
    await mesh.setCapture(makeCapture(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(setCodecSpy).toHaveBeenCalledTimes(1);
    expect(signals.some((s) => s.data.k === "offer")).toBe(false);

    await mesh.handleSignal("bob", { k: "answer", sdp: "v=0\r\n" });
    await new Promise((r) => setTimeout(r, 10));
    expect(signals.some((s) => s.data.k === "offer")).toBe(true);
  });

  it("does not emit a deferred renegotiation offer after removePeer races a live setCodec", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("me", { ...opts }, (to, data) => signals.push({ to, data }), cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    await mesh.setCapture(makeCapture(false));
    signals.length = 0;

    mesh.setCodec("av1");
    mesh.removePeer("bob");
    await new Promise((r) => setTimeout(r, 15));

    expect(signals.some((s) => s.data.k === "offer")).toBe(false);
  });

  it("enforces setMemberSharing transitions, video/audio ended retention, and zero open PCs when nobody shares", async () => {
    const callbacks = cb();
    const mesh = new Mesh("me", { ...opts }, () => {}, callbacks);
    mesh.addMember("bob", true);
    await mesh.setCapture(makeCapture(false));
    const pc = FakeRTCPeerConnection.instances[0]!;

    const videoListeners: Record<string, () => void> = {};
    const audioListeners: Record<string, () => void> = {};
    const videoTrack = {
      kind: "video",
      addEventListener: (ev: string, fn: () => void) => { videoListeners[ev] = fn; },
    } as unknown as MediaStreamTrack;
    const audioTrack = {
      kind: "audio",
      addEventListener: (ev: string, fn: () => void) => { audioListeners[ev] = fn; },
    } as unknown as MediaStreamTrack;
    const remoteStream = { id: "bob-stream", getTracks: () => [videoTrack, audioTrack] } as unknown as MediaStream;

    pc.ontrack?.({ track: videoTrack, receiver: {} as unknown as RTCRtpReceiver, streams: [remoteStream] } as unknown as RTCTrackEvent);
    pc.ontrack?.({ track: audioTrack, receiver: {} as unknown as RTCRtpReceiver, streams: [remoteStream] } as unknown as RTCTrackEvent);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(2);

    // Audio ended must NOT clear retained remoteStream
    audioListeners["ended"]?.();
    expect(callbacks.onRemoteStreamGone).not.toHaveBeenCalled();

    // false -> false is a no-op; false -> true re-emits retained stream once
    mesh.setMemberSharing("bob", false);
    mesh.setMemberSharing("bob", false);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(2);
    mesh.setMemberSharing("bob", true);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(3);
    mesh.setMemberSharing("bob", true);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(3);

    // Video ended clears remoteStream -> subsequent false -> true must NOT re-emit dead stream
    videoListeners["ended"]?.();
    expect(callbacks.onRemoteStreamGone).toHaveBeenCalledTimes(1);
    mesh.setMemberSharing("bob", false);
    mesh.setMemberSharing("bob", true);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(3);

    // When both stop sharing, zero open RTCPeerConnections remain and late ended does not double-fire
    await mesh.setCapture(null);
    mesh.setMemberSharing("bob", false);
    expect(mesh.peers()).toEqual([]);
    expect(FakeRTCPeerConnection.instances.every((inst) => inst.closed)).toBe(true);
    videoListeners["ended"]?.();
    expect(callbacks.onRemoteStreamGone).toHaveBeenCalledTimes(2);
  });

  it("preserves video remoteStream teardown when audio arrives on a separate MediaStream", async () => {
    const callbacks = cb();
    const mesh = new Mesh("me", { ...opts }, () => {}, callbacks);
    mesh.addMember("bob", true);
    await mesh.setCapture(makeCapture(false));
    const pc = FakeRTCPeerConnection.instances[0]!;

    const videoListeners: Record<string, () => void> = {};
    const videoTrack = {
      kind: "video",
      addEventListener: (ev: string, fn: () => void) => { videoListeners[ev] = fn; },
    } as unknown as MediaStreamTrack;
    const audioTrack = {
      kind: "audio",
      addEventListener: vi.fn(),
    } as unknown as MediaStreamTrack;
    const videoStream = { id: "video-only", getTracks: () => [videoTrack] } as unknown as MediaStream;
    const audioStream = { id: "audio-only", getTracks: () => [audioTrack] } as unknown as MediaStream;

    pc.ontrack?.({ track: videoTrack, receiver: {} as unknown as RTCRtpReceiver, streams: [videoStream] } as unknown as RTCTrackEvent);
    pc.ontrack?.({ track: audioTrack, receiver: {} as unknown as RTCRtpReceiver, streams: [audioStream] } as unknown as RTCTrackEvent);

    // Video ended must still tear down the remote stream and prevent re-emitting an audio-only stream
    videoListeners["ended"]?.();
    expect(callbacks.onRemoteStreamGone).toHaveBeenCalledWith("bob");

    const callsBefore = vi.mocked(callbacks.onRemoteStream).mock.calls.length;
    mesh.setMemberSharing("bob", false);
    mesh.setMemberSharing("bob", true);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(callsBefore);
  });

  it("restricts ICE restart on connectionState failed strictly to active sending phases on a mutual link", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;

    // 1. Viewer-only before sharing: no restart
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(pc.restartIceCalls).toBe(0);

    // 2. Mid-attachCapture (before isSending flips): no restart
    const paramsGate = deferred();
    const addTxSpy = vi
      .spyOn(pc, "addTransceiver")
      .mockImplementation(function (
        this: FakeRTCPeerConnection,
        trackOrKind: MediaStreamTrack | string,
      ): RTCRtpTransceiver {
        const sender = this.addTrack(typeof trackOrKind === "string" ? null : trackOrKind);
        const tx = this.transceivers.find((t) => t.sender === sender)!;
        if (typeof trackOrKind !== "string") {
          const origSetParams = tx.sender.setParameters.bind(tx.sender);
          let once = true;
          tx.sender.setParameters = async (p: RTCRtpSendParameters) => {
            if (once) {
              once = false;
              await paramsGate.promise;
            }
            return origSetParams(p);
          };
        }
        return tx;
      });

    const attachPromise = mesh.setCapture(makeCapture(true));
    await new Promise((r) => setTimeout(r, 0));
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(pc.restartIceCalls).toBe(0);

    // Completing attachCapture while connectionState is already failed immediately recovers via restartIce
    paramsGate.resolve();
    await attachPromise;
    addTxSpy.mockRestore();
    expect(pc.restartIceCalls).toBe(1);

    // 3. Actively sharing: restarts ICE on subsequent failures
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(pc.restartIceCalls).toBe(2);

    // 4. Immediately upon setCapture(null) even while detachCapture is still pending: no restart
    const detachGate = deferred();
    const origReplace = pc.senders[0]!.replaceTrack.bind(pc.senders[0]!);
    pc.senders[0]!.replaceTrack = async (t: MediaStreamTrack | null) => {
      await detachGate.promise;
      return origReplace(t);
    };
    const detachPromise = mesh.setCapture(null);
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(pc.restartIceCalls).toBe(2);

    detachGate.resolve();
    await detachPromise;

    // 5. Resumed share (cycle 2): restarts ICE again
    pc.senders[0]!.replaceTrack = origReplace;
    pc.connectionState = "connected";
    await mesh.setCapture(makeCapture(false));
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(pc.restartIceCalls).toBe(3);
  });

  it("does not poison mediaQueue after open-link rejections in attachCapture, replaceVideo, or replaceAudio", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    const origAddTx = pc.addTransceiver.bind(pc);
    const addTxSpy = vi.spyOn(pc, "addTransceiver");

    // 1. Fail initial attachCapture via setParameters on an open link -> must reject, not poison queue
    let failFirstParams = true;
    addTxSpy.mockImplementation((trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) => {
      const tx = origAddTx(trackOrKind, init);
      if (typeof trackOrKind !== "string") {
        const origSetParams = tx.sender.setParameters.bind(tx.sender);
        tx.sender.setParameters = async (p: RTCRtpSendParameters) => {
          if (failFirstParams) {
            failFirstParams = false;
            throw new Error("Transient setParameters failure");
          }
          return origSetParams(p);
        };
      }
      return tx;
    });

    await expect(mesh.setCapture(makeCapture(true))).rejects.toThrow("Transient setParameters failure");

    // Subsequent attachCapture must succeed and reuse the 2 transceivers already created
    const c1 = makeCapture(true);
    await expect(mesh.setCapture(c1)).resolves.toBeUndefined();
    expect(pc.transceivers).toHaveLength(2);
    expect(pc.senders[0]?.track).toBe(c1.video);
    expect(pc.senders[1]?.track).toBe(c1.audio);

    // 2. Fail replaceVideo on an open link -> must reject, not poison queue
    const origVideoReplace = pc.senders[0]!.replaceTrack.bind(pc.senders[0]!);
    pc.senders[0]!.replaceTrack = async () => {
      throw new Error("Video replaceTrack boom");
    };
    await expect(mesh.setVideoTrack({ kind: "video" } as unknown as MediaStreamTrack)).rejects.toThrow(
      "Video replaceTrack boom",
    );

    pc.senders[0]!.replaceTrack = origVideoReplace;
    const v2 = { kind: "video" } as unknown as MediaStreamTrack;
    await expect(mesh.setVideoTrack(v2)).resolves.toBeUndefined();
    expect(pc.senders[0]?.track).toBe(v2);

    // 3. Fail replaceAudio on an open link -> must reject, not poison queue
    const origAudioReplace = pc.senders[1]!.replaceTrack.bind(pc.senders[1]!);
    pc.senders[1]!.replaceTrack = async () => {
      throw new Error("Audio replaceTrack boom");
    };
    await expect(mesh.setAudioTrack({ kind: "audio" } as unknown as MediaStreamTrack)).rejects.toThrow(
      "Audio replaceTrack boom",
    );

    pc.senders[1]!.replaceTrack = origAudioReplace;
    const a2 = { kind: "audio" } as unknown as MediaStreamTrack;
    await expect(mesh.setAudioTrack(a2)).resolves.toBeUndefined();
    expect(pc.senders[1]?.track).toBe(a2);

    // 4. Subsequent detachCapture still runs cleanly
    await expect(mesh.setCapture(null)).resolves.toBeUndefined();
    expect(pc.senders[0]?.track).toBeNull();
    expect(pc.senders[1]?.track).toBeNull();
  });

  it("still executes queued detachCapture before a replacement attach even if the replacement fails", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;

    const capA = makeCapture(true);
    await mesh.setCapture(capA);
    expect(pc.senders[0]?.track).toBe(capA.video);

    // Hold mediaQueue with an in-flight replaceVideo so setCapture(null) and setCapture(B) queue behind it
    const gate = deferred();
    const origReplace = pc.senders[0]!.replaceTrack.bind(pc.senders[0]!);
    const capB = makeCapture(true);
    pc.senders[0]!.replaceTrack = async (t: MediaStreamTrack | null) => {
      if (t === capB.video) throw new Error("Replacement track incompatible");
      if (t !== null) await gate.promise;
      return origReplace(t);
    };

    const pSwap = mesh.setVideoTrack({ kind: "video" } as unknown as MediaStreamTrack);
    const pDetach = mesh.setCapture(null);
    const pReplace = mesh.setCapture(capB);

    gate.resolve();
    await pSwap;
    await pDetach;
    await expect(pReplace).rejects.toThrow("Replacement track incompatible");

    // Capture A must NOT still be attached on the sender after setCapture(null)
    expect(pc.senders[0]?.track).toBeNull();
  });

  it("resolves setCapture(null) even if a closed link's pending replaceTrack(null) never settles", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;

    await mesh.setCapture(makeCapture(true));

    // Simulate WebRTC aborting replaceTrack(null) on close without ever settling its promise
    pc.senders[0]!.replaceTrack = () => new Promise<void>(() => {});
    pc.senders[1]!.replaceTrack = () => new Promise<void>(() => {});

    const detachPromise = mesh.setCapture(null);
    await new Promise((r) => setTimeout(r, 0));

    // Peer disconnects while detachCapture is awaiting the never-settling replaceTrack(null)
    mesh.removeMember("bob");
    await expect(detachPromise).resolves.toBeUndefined();
  });

  it("resolves setCapture(null) on peer removal even when queued behind a stalled setVideoTrack replacement", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;

    await mesh.setCapture(makeCapture(true));

    // Simulate a stalled video swap whose replaceTrack never settles when the peer closes
    pc.senders[0]!.replaceTrack = () => new Promise<void>(() => {});
    const swapPromise = mesh.setVideoTrack({ kind: "video" } as unknown as MediaStreamTrack);
    void swapPromise.catch(() => {});

    const detachPromise = mesh.setCapture(null);
    await new Promise((r) => setTimeout(r, 0));

    mesh.removeMember("bob");
    await expect(detachPromise).resolves.toBeUndefined();
  });

  it("enforces defensive Mesh guards for selfId, unknown peers, non-offer signals, and non-control channels", async () => {
    const mesh = new Mesh("me", { ...opts }, () => {}, cb());

    // addMember(selfId) is a no-op
    mesh.addMember("me", true);
    expect(FakeRTCPeerConnection.instances).toHaveLength(0);

    // handleSignal from unknown member is ignored
    await mesh.handleSignal("ghost", { k: "offer", sdp: "v=0\r\n" });
    expect(FakeRTCPeerConnection.instances).toHaveLength(0);

    // Non-offer signal (answer/ice) from a known sharing member with no open link is ignored
    mesh.addMember("bob", true);
    await mesh.handleSignal("bob", { k: "answer", sdp: "v=0\r\n" });
    await mesh.handleSignal("bob", { k: "ice", candidate: { candidate: "cand", sdpMid: "0", sdpMLineIndex: 0 } });
    expect(FakeRTCPeerConnection.instances).toHaveLength(0);

    // Unknown peer queries and setViewing/setAudioTrack without capture do not throw
    expect(mesh.getConnection("ghost")).toBeUndefined();
    expect(mesh.hasConnectedLink("ghost")).toBe(false);
    expect(() => mesh.setViewing("ghost", true)).not.toThrow();
    await expect(mesh.setAudioTrack({ kind: "audio" } as unknown as MediaStreamTrack)).resolves.toBeUndefined();

    // Non-control data channel is ignored when received on an open link
    await mesh.handleSignal("bob", { k: "offer", sdp: "v=0\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    const otherChannel = new FakeDataChannel("other");
    pc.ondatachannel?.({ channel: otherChannel });
    mesh.setViewing("bob", false);
    expect(otherChannel.sent).toHaveLength(0);

    // Non-matching setMemberSharing(true) on a member without a link does not throw
    mesh.addMember("carol", false);
    expect(() => mesh.setMemberSharing("carol", true)).not.toThrow();
  });

  it("defers local offers during applyingOffer and avoids calling setLocalDescription on stale colliding offers", async () => {
    const sent: SignalData[] = [];
    const mesh = new Mesh("alice", { ...opts }, (_to, data) => sent.push(data), cb());
    mesh.addMember("zoe", true);
    // zoe > alice so alice is polite
    let resolveRemoteDesc!: () => void;
    const remoteDescGate = new Promise<void>((resolve) => {
      resolveRemoteDesc = resolve;
    });

    await mesh.handleSignal("zoe", { k: "offer", sdp: "v=0\r\nm=video 9\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    sent.length = 0;

    // Simulate attachCapture while a new remote offer is in-flight in setRemoteDescription
    const origSetRemote = pc.setRemoteDescription.bind(pc);
    let gatedOnce = false;
    pc.setRemoteDescription = async (desc: RTCSessionDescriptionInit) => {
      if (!gatedOnce) {
        gatedOnce = true;
        await remoteDescGate;
      }
      await origSetRemote(desc);
    };

    let setLocalCalls = 0;
    const origSetLocal = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = async (desc?: RTCSessionDescriptionInit) => {
      if (desc?.type === "offer") setLocalCalls++;
      return desc ? origSetLocal(desc) : Promise.resolve();
    };

    const incomingOffer = mesh.handleSignal("zoe", { k: "offer", sdp: "v=0\r\nm=video 9\r\n" });
    // Trigger onnegotiationneeded while applyingOffer is true
    pc.onnegotiationneeded?.();
    await mesh.setCapture(makeCapture(false));
    expect(setLocalCalls).toBe(0);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      resolveRemoteDesc();
      await incomingOffer;
      await new Promise((r) => setTimeout(r, 15));
      expect(setLocalCalls).toBeGreaterThanOrEqual(1);
      expect(sent.some((m) => m.k === "offer")).toBe(true);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("defers non-stable negotiate calls and retries cleanly when a remote offer supersedes createOffer or setLocalDescription", async () => {
    const sent: SignalData[] = [];
    const mesh = new Mesh("alice", { ...opts }, (_to, data) => sent.push(data), cb());
    mesh.addMember("zoe", true);
    await mesh.handleSignal("zoe", { k: "offer", sdp: "v=0\r\nm=video 9\r\n" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    sent.length = 0;

    // 1. Non-stable signalingState defers negotiate without invoking createOffer
    let createCalls = 0;
    const origCreate = pc.createOffer.bind(pc);
    pc.createOffer = async () => {
      createCalls++;
      return origCreate();
    };
    pc.signalingState = "have-remote-offer";
    pc.onnegotiationneeded?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(createCalls).toBe(0);
    pc.signalingState = "stable";

    // 2. Remote offer lands mid-createOffer -> local offer aborted, answer sent, then local offer retried
    let resolveCreate!: (d: RTCSessionDescriptionInit) => void;
    const createGate = new Promise<RTCSessionDescriptionInit>((r) => { resolveCreate = r; });
    pc.createOffer = () => {
      createCalls++;
      return createCalls === 1 ? createGate : origCreate();
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      pc.onnegotiationneeded?.();
      await new Promise((r) => setTimeout(r, 0));
      const raceOffer = mesh.handleSignal("zoe", { k: "offer", sdp: "v=0\r\nm=video 9\r\n" });
      resolveCreate({ type: "offer", sdp: "v=0\r\nm=stale 9\r\n" });
      await raceOffer;
      await new Promise((r) => setTimeout(r, 15));
      expect(sent.some((m) => m.k === "answer")).toBe(true);
      expect(sent.some((m) => m.k === "offer")).toBe(true);
      expect(errSpy).not.toHaveBeenCalled();

      // Acknowledge the outgoing offer so FakeRTCPeerConnection returns to stable
      await mesh.handleSignal("zoe", { k: "answer", sdp: "v=0\r\nm=video 9\r\n" });

      // 3. Reject setLocalDescription after signalingState changes -> handled as superseded retry, not console.error
      sent.length = 0;
      const origSetLocal = pc.setLocalDescription.bind(pc);
      let failOnce = true;
      pc.setLocalDescription = async (desc?: RTCSessionDescriptionInit) => {
        if (failOnce && desc?.type === "offer") {
          failOnce = false;
          pc.signalingState = "have-remote-offer";
          throw new DOMException("m-line order mismatch", "InvalidAccessError");
        }
        return desc ? origSetLocal(desc) : Promise.resolve();
      };
      pc.onnegotiationneeded?.();
      await new Promise((r) => setTimeout(r, 10));
      expect(errSpy).not.toHaveBeenCalled();
      expect(failOnce).toBe(false);
      await mesh.handleSignal("zoe", { k: "offer", sdp: "v=0\r\nm=video 9\r\n" });
      await new Promise((r) => setTimeout(r, 15));
      expect(sent.some((m) => m.k === "offer")).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

