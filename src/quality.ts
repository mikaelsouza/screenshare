/**
 * Encoder / decoder tuning. This module is the difference between the app working
 * and not: Chrome caps screenshare at roughly 2.5 Mbps by default and buffers for
 * smoothness rather than latency. Everything here overrides that.
 */

import type { QualityPreset } from "./capture";

export type CodecName = "h264" | "av1";

/**
 * H.264 is the default *for gaming specifically*: it hits the hardware encoder
 * (NVENC / AMF / QuickSync) on essentially every gaming GPU, and WebRTC's H.264 has
 * no B-frames, which helps latency. AV1 is offered for modern GPUs (RTX 40+, RX 7000+,
 * Arc) with dedicated AV1 hardware encoders.
 */
export const DEFAULT_CODEC: CodecName = "h264";

const CODEC_MIME: Record<CodecName, string> = {
  h264: "video/H264",
  av1: "video/AV1",
};

export async function applyVideoEncoding(
  sender: RTCRtpSender,
  preset: QualityPreset,
): Promise<void> {
  const params = sender.getParameters();
  // getParameters() can return an empty encodings array before negotiation settles.
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  const e = params.encodings[0];
  if (!e) return;

  // Deliberately do NOT force active = true. Send-side pausing sets active = false
  // for peers who are not looking at this tile, and a live preset change calling
  // through here would silently resume uploading video nobody is watching —
  // defeating the largest bandwidth lever the room-size budget depends on.
  // Resuming is the explicit job of setSenderActive().
  params.degradationPreference = "maintain-framerate";
  e.maxBitrate = preset.maxBitrate;
  e.maxFramerate = preset.frameRate;
  e.scaleResolutionDownBy = 1;

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

/**
 * Initial video bandwidth estimate (kbps) injected into SDP via x-google-start-bitrate.
 *
 * Without this hint, Chromium's libwebrtc initializes a new peer connection's
 * send-side bandwidth estimator at kDefaultStartBitrateBps (300 kbps), which triggers
 * InitialFrameDropper on the first frames of a 1080p/1440p screen share.
 *
 * Only x-google-start-bitrate is set (never x-google-min-bitrate), so GCC remains
 * free to adapt downward on genuinely constrained links.
 */
export const DEFAULT_START_BITRATE_KBPS = 6000;

export function mungeVideoSdp(
  sdp: string,
  startBitrateKbps: number = DEFAULT_START_BITRATE_KBPS,
): string {
  const rtpmapRe = /^a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1)\/90000\b.*$/gim;
  const matches = [...sdp.matchAll(rtpmapRe)];
  if (matches.length === 0) return sdp;

  const wanted = `x-google-start-bitrate=${startBitrateKbps}`;
  const seenPts = new Set<string>();
  let out = sdp;

  for (const match of matches) {
    const raw = match[1];
    if (!raw) continue;
    const pt = String(Number(raw));
    if (Number(pt) > 127 || seenPts.has(pt)) continue;
    seenPts.add(pt);

    const fmtpRe = new RegExp(`^a=fmtp:${pt} (.*)$`, "gm");
    if (fmtpRe.test(out)) {
      out = out.replace(fmtpRe, (_full, existing: string) => {
        const keep = existing
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s && !/^x-google-start-bitrate=/i.test(s));
        return `a=fmtp:${pt} ${[...keep, wanted].join(";")}`;
      });
    } else {
      const lineRe = new RegExp(`^a=rtpmap:${pt} (?:VP8|VP9|H264|AV1)\\/90000\\b.*$`, "gim");
      out = out.replace(lineRe, (line) => `${line}\r\na=fmtp:${pt} ${wanted}`);
    }
  }

  return out;
}

export interface LinkHealth {
  rttMs: number | null;
  packetLossRatio: number | null;
  bitrate: number | null;
  framesPerSecond: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
}
