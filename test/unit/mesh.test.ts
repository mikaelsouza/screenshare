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

    await mesh.setCapture(null);
    expect(pc.senders.length).toBe(0);
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

  it("adds unknown member on setMemberSharing and retries offer on glare during createOffer", async () => {
    const signals: Array<{ to: string; data: SignalData }> = [];
    const mesh = new Mesh("alice", opts, (to, data) => signals.push({ to, data }), cb());
    mesh.setMemberSharing("bob", true);
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
});



