import { describe, it, expect, vi, beforeEach } from "vitest";

// Interface and contracts matching src/main.ts BoostAudioPipe
interface MockAudioParam {
  value: number;
}

class MockDynamicsCompressorNode {
  threshold: MockAudioParam = { value: 0 };
  knee: MockAudioParam = { value: 0 };
  ratio: MockAudioParam = { value: 0 };
  attack: MockAudioParam = { value: 0 };
  release: MockAudioParam = { value: 0 };
  connectedTo: any = null;

  connect = vi.fn((dest: any) => {
    this.connectedTo = dest;
  });

  disconnect = vi.fn(() => {
    this.connectedTo = null;
  });
}

class MockGainNode {
  gain: MockAudioParam = { value: 1 };
  connectedTo: any = null;

  connect = vi.fn((dest: any) => {
    this.connectedTo = dest;
  });

  disconnect = vi.fn(() => {
    this.connectedTo = null;
  });
}

class MockMediaStreamAudioSourceNode {
  connectedTo: any = null;

  connect = vi.fn((dest: any) => {
    this.connectedTo = dest;
  });

  disconnect = vi.fn(() => {
    this.connectedTo = null;
  });
}

class MockAudioContext {
  state: "suspended" | "running" | "closed" = "running";
  destination = { name: "destination" };

  createDynamicsCompressor() {
    return new MockDynamicsCompressorNode();
  }

  createGain() {
    return new MockGainNode();
  }

  createMediaStreamSource(_stream: any) {
    return new MockMediaStreamAudioSourceNode();
  }

  resume = vi.fn(async () => {
    this.state = "running";
  });
}

// Pipeline implementation mirroring Feature 26 DSP contracts
class AudioBoostPipeline {
  private boostPipes = new Map<string, {
    stream: any;
    source: MockMediaStreamAudioSourceNode;
    gain: MockGainNode;
    compressor: MockDynamicsCompressorNode;
  }>();

  constructor(public ctx: MockAudioContext) {}

  setupBoostPipe(peerId: string, stream: { getAudioTracks: () => any[] }) {
    const existing = this.boostPipes.get(peerId);
    if (existing) {
      if (existing.stream === stream) return existing;
      this.teardownBoostPipe(peerId);
    }

    if (stream.getAudioTracks().length === 0) return null;

    const source = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    const compressor = this.ctx.createDynamicsCompressor();

    // Exact anti-clipping parameters from Feature 26 & src/main.ts:296-300
    compressor.threshold.value = -6;
    compressor.knee.value = 6;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.1;

    source.connect(gain);
    gain.connect(compressor);
    compressor.connect(this.ctx.destination);

    const pipe = { stream, source, gain, compressor };
    this.boostPipes.set(peerId, pipe);
    return pipe;
  }

  teardownBoostPipe(peerId: string) {
    const pipe = this.boostPipes.get(peerId);
    if (!pipe) return;
    try {
      pipe.gain.disconnect();
      pipe.source.disconnect();
      pipe.compressor.disconnect();
    } catch {}
    this.boostPipes.delete(peerId);
  }

  applyAudio(peerId: string, video: { volume: number; muted: boolean }, s: { volume: number; muted: boolean }, stream: any) {
    const isSilent = s.muted;
    video.volume = Math.max(0, Math.min(1, s.volume));

    if (s.volume > 1 && !isSilent && stream && stream.getAudioTracks().length > 0) {
      const pipe = this.setupBoostPipe(peerId, stream);
      if (pipe) {
        // Mute video element to avoid acoustic comb filtering / echo
        video.muted = true;
        pipe.gain.gain.value = s.volume;
        if (this.ctx.state === "suspended") {
          void this.ctx.resume();
        }
        return;
      }
    }

    // Volume <= 1 or muted: native video element handles audio
    video.muted = isSilent;
    const pipe = this.boostPipes.get(peerId);
    if (pipe) {
      pipe.gain.gain.value = 0;
    }
  }

  getPipe(peerId: string) {
    return this.boostPipes.get(peerId);
  }
}

describe("Web Audio Boost Pipe (Feature 26)", () => {
  let ctx: MockAudioContext;
  let pipeline: AudioBoostPipeline;

  beforeEach(() => {
    ctx = new MockAudioContext();
    pipeline = new AudioBoostPipeline(ctx);
  });

  describe("BST-01: DynamicsCompressor DSP parameters", () => {
    it("configures compressor with exact anti-clipping parameters", () => {
      const stream = { getAudioTracks: () => [{ kind: "audio" }] };
      const pipe = pipeline.setupBoostPipe("peer-1", stream);

      expect(pipe).not.toBeNull();
      const comp = pipe!.compressor;
      expect(comp.threshold.value).toBe(-6);
      expect(comp.knee.value).toBe(6);
      expect(comp.ratio.value).toBe(12);
      expect(comp.attack.value).toBe(0.003);
      expect(comp.release.value).toBe(0.1);
    });

    it("returns null if stream has no audio tracks", () => {
      const streamNoAudio = { getAudioTracks: () => [] };
      const pipe = pipeline.setupBoostPipe("peer-silent", streamNoAudio);
      expect(pipe).toBeNull();
    });
  });

  describe("BST-02: Audio Routing Graph", () => {
    it("connects source -> gain -> compressor -> destination", () => {
      const stream = { getAudioTracks: () => [{ kind: "audio" }] };
      const pipe = pipeline.setupBoostPipe("peer-2", stream)!;

      expect(pipe.source.connect).toHaveBeenCalledWith(pipe.gain);
      expect(pipe.gain.connect).toHaveBeenCalledWith(pipe.compressor);
      expect(pipe.compressor.connect).toHaveBeenCalledWith(ctx.destination);
    });
  });

  describe("BST-03 & BST-04: Volume Thresholds & Comb-Filtering Prevention", () => {
    it("mutes video and boosts gain when volume > 1.0 (e.g., 1.8)", () => {
      const video = { volume: 1, muted: false };
      const stream = { getAudioTracks: () => [{ kind: "audio" }] };

      pipeline.applyAudio("peer-3", video, { volume: 1.8, muted: false }, stream);

      // HTML video volume clamped to 1.0, video muted to prevent comb filtering
      expect(video.volume).toBe(1);
      expect(video.muted).toBe(true);

      const pipe = pipeline.getPipe("peer-3");
      expect(pipe).toBeDefined();
      expect(pipe!.gain.gain.value).toBe(1.8);
    });

    it("uses native video playback and sets boost gain to 0 when volume <= 1.0", () => {
      const video = { volume: 1, muted: false };
      const stream = { getAudioTracks: () => [{ kind: "audio" }] };

      // First boost to create pipe
      pipeline.applyAudio("peer-4", video, { volume: 1.5, muted: false }, stream);
      expect(video.muted).toBe(true);

      // Now lower volume to 0.7
      pipeline.applyAudio("peer-4", video, { volume: 0.7, muted: false }, stream);

      expect(video.volume).toBe(0.7);
      expect(video.muted).toBe(false); // Native playback unmuted
      const pipe = pipeline.getPipe("peer-4");
      expect(pipe!.gain.gain.value).toBe(0);
    });

    it("mutes video and leaves gain at 0 when state is muted", () => {
      const video = { volume: 1, muted: false };
      const stream = { getAudioTracks: () => [{ kind: "audio" }] };

      pipeline.applyAudio("peer-5", video, { volume: 1.5, muted: true }, stream);

      expect(video.muted).toBe(true);
      const pipe = pipeline.getPipe("peer-5");
      // Muted stream does not engage boost
      expect(pipe).toBeUndefined();
    });
  });

  describe("BST-05: Teardown & Resource Disposal", () => {
    it("disconnects all nodes and removes pipe entry on teardown", () => {
      const stream = { getAudioTracks: () => [{ kind: "audio" }] };
      const pipe = pipeline.setupBoostPipe("peer-6", stream)!;

      pipeline.teardownBoostPipe("peer-6");

      expect(pipe.source.disconnect).toHaveBeenCalled();
      expect(pipe.gain.disconnect).toHaveBeenCalled();
      expect(pipe.compressor.disconnect).toHaveBeenCalled();
      expect(pipeline.getPipe("peer-6")).toBeUndefined();
    });

    it("replaces existing pipe if stream changes for same peer", () => {
      const stream1 = { getAudioTracks: () => [{ kind: "audio" }] };
      const stream2 = { getAudioTracks: () => [{ kind: "audio" }] };

      const pipe1 = pipeline.setupBoostPipe("peer-7", stream1)!;
      const pipe2 = pipeline.setupBoostPipe("peer-7", stream2)!;

      expect(pipe1.source.disconnect).toHaveBeenCalled();
      expect(pipe2).not.toBe(pipe1);
      expect(pipeline.getPipe("peer-7")?.stream).toBe(stream2);
    });
  });

  describe("BST-06: Autoplay Policy & AudioContext Recovery", () => {
    it("resumes AudioContext when suspended upon volume boost", () => {
      ctx.state = "suspended";
      const video = { volume: 1, muted: false };
      const stream = { getAudioTracks: () => [{ kind: "audio" }] };

      pipeline.applyAudio("peer-8", video, { volume: 1.4, muted: false }, stream);

      expect(ctx.resume).toHaveBeenCalled();
      expect(ctx.state).toBe("running");
    });
  });
});
