import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalData } from "@shared/protocol";
import type { CaptureResult } from "@src/capture";
import { Mesh, type MeshCallbacks, type MeshOptions } from "@src/mesh";

class FakeDataChannel {
  readyState = "open";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(readonly label: string) {}

  send(data: string): void {
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

  constructor(readonly config: RTCConfiguration) {
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
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = { type: desc.type ?? "answer", sdp: desc.sdp ?? "" };
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  addTrack(track: MediaStreamTrack, ..._streams: MediaStream[]): RTCRtpSender {
    let params: Record<string, unknown> = { encodings: [{ active: true, maxBitrate: 5_000_000 }] };
    const sender = {
      track,
      getParameters: () => structuredClone(params),
      setParameters: async (p: Record<string, unknown>) => { params = structuredClone(p); },
      getStats: async () => new Map() as unknown as RTCStatsReport,
    } as unknown as RTCRtpSender;
    this.senders.push(sender);

    const transceiver = {
      sender,
      setCodecPreferences: vi.fn(),
    } as unknown as RTCRtpTransceiver;
    this.transceivers.push(transceiver);

    return sender;
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
    relayOnly: false,
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

  it("determines polite role based on peer IDs (selfId < peerId)", () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);

    // alice < bob -> alice is polite, bob is impolite.
    // The impolite side creates the control channel.
    mesh.addPeer("bob");
    const pc1 = FakeRTCPeerConnection.instances[0]!;
    expect(pc1.dataChannels.length).toBe(0); // polite side did not create

    // alice > aaron -> alice is impolite, creates control channel
    mesh.addPeer("aaron");
    const pc2 = FakeRTCPeerConnection.instances[1]!;
    expect(pc2.dataChannels.length).toBe(1);
    expect(pc2.dataChannels[0]?.label).toBe("control");
  });

  it("applies iceTransportPolicy 'relay' when relayOnly is true and filters non-relay candidates", () => {
    const relayOptions: MeshOptions = { ...defaultOptions, relayOnly: true };
    const mesh = new Mesh("alice", relayOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");

    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc.config.iceTransportPolicy).toBe("relay");

    // Simulate ICE candidate gathering
    const hostCandidate = {
      candidate: "candidate:1 1 udp 2122260223 192.168.1.100 54321 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    } as unknown as RTCIceCandidate;
    pc.onicecandidate?.({ candidate: hostCandidate });
    expect(sentSignals.length).toBe(0); // host candidate stripped!

    const relayCandidate = {
      candidate: "candidate:2 1 udp 41885439 198.51.100.9 60000 typ relay raddr 0.0.0.0 rport 0",
      sdpMid: "0",
      sdpMLineIndex: 0,
    } as unknown as RTCIceCandidate;
    pc.onicecandidate?.({ candidate: relayCandidate });
    expect(sentSignals.length).toBe(1);
    expect(sentSignals[0]?.data.k).toBe("ice");
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
    (endedHandler as (() => void) | undefined)?.();
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

  it("re-applies quality presets to all peers", async () => {
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");

    const videoTrack = { kind: "video" } as unknown as MediaStreamTrack;
    const capture: CaptureResult = {
      stream: { getTracks: () => [videoTrack] } as unknown as MediaStream,
      video: videoTrack,
      audio: null,
    };
    await mesh.setCapture(capture);

    const newPreset = { label: "1080p60", width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 };
    await mesh.setPreset(newPreset);
    expect(mesh.peers()).toEqual(["bob"]);
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
    ch.onmessage?.({ data: JSON.stringify({ c: "view", want: false }) });
  });

  it("binds control channel received via ondatachannel and handles negotiation failures", async () => {
    // alice < bob -> alice is polite, expects remote control channel via ondatachannel
    const mesh = new Mesh("alice", defaultOptions, (to, data) => sentSignals.push({ to, data }), callbacks);
    mesh.addPeer("bob");
    const pc = FakeRTCPeerConnection.instances[0]!;

    // Non-control channel should be ignored
    pc.ondatachannel?.({ channel: new FakeDataChannel("unrelated") as unknown as RTCDataChannel });

    // Control channel should be bound
    const remoteControl = new FakeDataChannel("control");
    pc.ondatachannel?.({ channel: remoteControl as unknown as RTCDataChannel });

    // Negotiation failure handling
    pc.createOffer = vi.fn().mockRejectedValue(new Error("offer creation failed"));
    pc.onnegotiationneeded?.();
    await new Promise((r) => setTimeout(r, 20));
  });
});
