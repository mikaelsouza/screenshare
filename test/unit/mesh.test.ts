import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalData } from "@shared/protocol";
import type { CaptureResult } from "@src/capture";
import {
  Mesh,
  type MeshCallbacks,
  type MeshOptions,
  keepRelayCandidatesOnly,
  parseControlMessage,
} from "@src/mesh";

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

describe("relay-only hardening", () => {
  const SDP_WITH_CANDIDATES = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=candidate:1 1 udp 2122260223 192.168.1.100 54321 typ host generation 0",
    "a=candidate:2 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 192.168.1.100 rport 54321",
    "a=candidate:3 1 udp 41885439 198.51.100.9 60000 typ relay raddr 203.0.113.7 rport 61000",
    "a=rtpmap:111 opus/48000/2",
    "",
  ].join("\r\n");

  it("strips every non-relay candidate line from SDP and keeps everything else", () => {
    const out = keepRelayCandidatesOnly(SDP_WITH_CANDIDATES);
    expect(out).not.toContain("192.168.1.100 54321 typ host");
    expect(out).not.toContain("typ srflx");
    expect(out).toContain("typ relay");
    expect(out).toContain("a=rtpmap:111 opus/48000/2");
    expect(out.endsWith("\r\n")).toBe(true);
  });

  let sent: SignalData[];
  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    sent = [];
  });

  function relayMesh(relayOnly: boolean): FakeRTCPeerConnection {
    const opts: MeshOptions = {
      iceServers: [{ urls: "turn:turn.example.com" }],
      preset: { label: "720p60", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 },
      codec: "h264",
      jitterBufferTargetMs: 0,
      relayOnly,
    };
    const mesh = new Mesh("alice", opts, (_to, data) => sent.push(data), {
      onRemoteStream: vi.fn(),
      onRemoteStreamGone: vi.fn(),
      onConnectionState: vi.fn(),
    });
    mesh.addPeer("bob");
    const pc = FakeRTCPeerConnection.instances[0]!;
    pc.createOffer = async () => ({ type: "offer", sdp: SDP_WITH_CANDIDATES });
    pc.createAnswer = async () => ({ type: "answer", sdp: SDP_WITH_CANDIDATES });
    return pc;
  }

  it("sends only relay candidates inside offers and answers in relay-only mode", async () => {
    const pc = relayMesh(true);
    pc.onnegotiationneeded?.();
    await new Promise((r) => setTimeout(r, 10));
    const offer = sent.find((d) => d.k === "offer");
    expect(offer && "sdp" in offer ? offer.sdp : "").not.toMatch(/typ (host|srflx)/);
  });

  it("leaves SDP untouched when relay-only is off", async () => {
    const pc = relayMesh(false);
    pc.onnegotiationneeded?.();
    await new Promise((r) => setTimeout(r, 10));
    const offer = sent.find((d) => d.k === "offer");
    expect(offer && "sdp" in offer ? offer.sdp : "").toContain("typ srflx");
  });

  it("drops a candidate it cannot classify instead of sending it", () => {
    const pc = relayMesh(true);
    pc.onicecandidate?.({ candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: 0 } as unknown as RTCIceCandidate });
    expect(sent.filter((d) => d.k === "ice")).toHaveLength(0);
  });

  it("closes data channels other than the control channel", () => {
    const pc = relayMesh(false);
    const stray = new FakeDataChannel("exfil");
    pc.ondatachannel?.({ channel: stray as unknown as RTCDataChannel });
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
    relayOnly: false,
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
});
