/**
 * Encoder / decoder tuning. This module is the difference between the app working
 * and not: Chrome caps screenshare at roughly 2.5 Mbps by default and buffers for
 * smoothness rather than latency. Everything here overrides that.
 */

import type { QualityPreset } from "./capture";

export type CodecName = "h264" | "vp9" | "av1" | "vp8";

/**
 * H.264 is the default *for gaming specifically*. VP9/AV1 compress better per bit,
 * but on most machines they encode in software and steal CPU from the game being
 * streamed. H.264 hits the hardware encoder (NVENC / AMF / QuickSync) on essentially
 * every gaming GPU, and WebRTC's H.264 has no B-frames, which helps latency.
 * Exposed as a toggle because the right answer is GPU-dependent and empirical.
 */
export const DEFAULT_CODEC: CodecName = "h264";

const CODEC_MIME: Record<CodecName, string> = {
  h264: "video/H264",
  vp9: "video/VP9",
  av1: "video/AV1",
  vp8: "video/VP8",
};

/** `degradationPreference` isn't in every TS DOM lib version. */
type SendParams = RTCRtpSendParameters & {
  degradationPreference?: "maintain-framerate" | "maintain-resolution" | "balanced";
};

export async function applyVideoEncoding(
  sender: RTCRtpSender,
  preset: QualityPreset,
  bitrateOverride?: number,
): Promise<void> {
  const params = sender.getParameters() as SendParams;
  // getParameters() can return an empty encodings array before negotiation settles.
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  const e = params.encodings[0];
  if (!e) return;

  // Deliberately do NOT force active = true. Send-side pausing sets active = false
  // for peers who are not looking at this tile, and a BitrateAdapter tick calling
  // through here would silently resume uploading video nobody is watching —
  // defeating the largest bandwidth lever the room-size budget depends on.
  // Resuming is the explicit job of setSenderActive().
  e.maxBitrate = bitrateOverride ?? preset.maxBitrate;
  e.maxFramerate = preset.frameRate;
  e.scaleResolutionDownBy = 1;

  // The single most important line for this use case: under constraint, drop
  // RESOLUTION before FRAMERATE. A soft 900p at 60fps is far more playable to watch
  // than a crisp 1080p at 20fps, and it encodes the latency-over-quality preference
  // directly into the encoder's own degradation policy.
  params.degradationPreference = "maintain-framerate";

  await sender.setParameters(params);
}

export async function applyAudioEncoding(sender: RTCRtpSender): Promise<void> {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  const e = params.encodings[0];
  if (!e) return;
  e.active = true;
  e.maxBitrate = 256_000;
  await sender.setParameters(params);
}

/**
 * Reorder the codec list so `preferred` is first. Falls back silently if the
 * browser doesn't offer it (e.g. no AV1 encoder present).
 */
export function preferCodec(transceiver: RTCRtpTransceiver, preferred: CodecName): void {
  if (typeof transceiver.setCodecPreferences !== "function") return;
  const caps = RTCRtpSender.getCapabilities("video");
  if (!caps?.codecs) return;

  const mime = CODEC_MIME[preferred].toLowerCase();
  const wanted = caps.codecs.filter((c) => c.mimeType.toLowerCase() === mime);
  if (wanted.length === 0) return;
  const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== mime);

  try {
    transceiver.setCodecPreferences([...wanted, ...rest]);
  } catch {
    // Some Chrome versions throw on unsupported orderings. Non-fatal.
  }
}

/**
 * Minimise the receive-side jitter buffer. This is a direct trade of smoothness
 * for latency — exactly the trade this project asked for. On a lossy link it can
 * look choppy, which is why it's a settable target rather than hardcoded to 0.
 */
export function tuneReceiverLatency(receiver: RTCRtpReceiver, targetMs = 0): void {
  const r = receiver as RTCRtpReceiver & {
    jitterBufferTarget?: number | null;
    playoutDelayHint?: number | null;
  };
  try {
    // Standards-track (Chrome 114+), in milliseconds.
    if ("jitterBufferTarget" in r) r.jitterBufferTarget = targetMs;
    // Older non-standard Chrome equivalent, in SECONDS.
    if ("playoutDelayHint" in r) r.playoutDelayHint = targetMs / 1000;
  } catch {
    // Read-only in some builds. Non-fatal.
  }
}

/**
 * Force stereo, high-bitrate, always-on Opus.
 *
 * None of this is reachable through setParameters() — the fmtp line is the only
 * control surface the browser exposes, so SDP munging is the standard and only
 * approach. Kept in one function so the ugliness is contained.
 *
 *   stereo=1 / sprop-stereo=1 -> actually send 2 channels (default is mono!)
 *   maxaveragebitrate         -> lift Opus off its ~32kbps voice default
 *   usedtx=0                  -> disable discontinuous transmission, which would
 *                                otherwise gate out quiet passages in games
 */
export function mungeOpusSdp(sdp: string): string {
  const rtpmap = sdp.match(/^a=rtpmap:(\d+) opus\/48000\/2/m);
  if (!rtpmap?.[1]) return sdp;
  const pt = rtpmap[1];

  const wanted = "stereo=1;sprop-stereo=1;maxaveragebitrate=256000;maxplaybackrate=48000;usedtx=0";
  const fmtpRe = new RegExp(`^a=fmtp:${pt} (.*)$`, "m");

  if (fmtpRe.test(sdp)) {
    return sdp.replace(fmtpRe, (_full, existing: string) => {
      // Drop any keys we're about to set, keep everything else the browser chose.
      const keep = existing
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s && !/^(stereo|sprop-stereo|maxaveragebitrate|maxplaybackrate|usedtx)=/.test(s));
      return `a=fmtp:${pt} ${[...keep, wanted].join(";")}`;
    });
  }
  return sdp.replace(rtpmap[0], `${rtpmap[0]}\r\na=fmtp:${pt} ${wanted}`);
}

export interface LinkHealth {
  rttMs: number | null;
  packetLossRatio: number | null;
  bitrate: number | null;
  framesPerSecond: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
}

/**
 * Per-peer adaptive bitrate. Because mesh connections are independent, one friend
 * on bad wifi degrades only their own stream — everyone else is untouched.
 * Backs off fast on sustained loss, recovers slowly.
 */
export class BitrateAdapter {
  private current: number;
  private consecutiveBad = 0;
  private consecutiveGood = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPacketsSent = 0;
  private lastPacketsLost = 0;
  private readonly sender: RTCRtpSender;
  private readonly preset: QualityPreset;
  private readonly floor: number;

  constructor(
    sender: RTCRtpSender,
    preset: QualityPreset,
    floor = 1_500_000,
  ) {
    this.sender = sender;
    this.preset = preset;
    this.floor = floor;
    this.current = preset.maxBitrate;
  }

  start(intervalMs = 3000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  get bitrate(): number {
    return this.current;
  }

  private async tick(): Promise<void> {
    const loss = await this.sampleLoss();
    if (loss === null) return;

    if (loss > 0.03) {
      this.consecutiveBad++;
      this.consecutiveGood = 0;
    } else {
      this.consecutiveGood++;
      this.consecutiveBad = 0;
    }

    let next = this.current;
    // Two bad samples in a row (~6s) before reacting, so a single blip doesn't
    // drop quality for everyone.
    if (this.consecutiveBad >= 2) {
      next = Math.max(this.floor, Math.round(this.current * 0.75));
      this.consecutiveBad = 0;
    } else if (this.consecutiveGood >= 5) {
      // Climb back much more slowly than we fell.
      next = Math.min(this.preset.maxBitrate, Math.round(this.current * 1.15));
      this.consecutiveGood = 0;
    }

    if (next !== this.current) {
      this.current = next;
      await applyVideoEncoding(this.sender, this.preset, next);
    }
  }

  private async sampleLoss(): Promise<number | null> {
    let stats: RTCStatsReport;
    try {
      stats = await this.sender.getStats();
    } catch {
      return null;
    }

    let packetsSent: number | null = null;
    let packetsLost: number | null = null;

    stats.forEach((r) => {
      const rec = r as unknown as Record<string, unknown>;
      if (rec["type"] === "outbound-rtp" && rec["kind"] === "video") {
        packetsSent = (rec["packetsSent"] as number) ?? null;
      }
      if (rec["type"] === "remote-inbound-rtp" && rec["kind"] === "video") {
        packetsLost = (rec["packetsLost"] as number) ?? null;
      }
    });

    if (packetsSent === null || packetsLost === null) return null;

    const dSent = packetsSent - this.lastPacketsSent;
    const dLost = packetsLost - this.lastPacketsLost;
    this.lastPacketsSent = packetsSent;
    this.lastPacketsLost = packetsLost;

    if (dSent <= 0) return null;
    return Math.max(0, dLost) / dSent;
  }
}
