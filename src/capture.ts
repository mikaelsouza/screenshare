/**
 * Screen capture. The defaults here are deliberately NOT the browser defaults:
 * getDisplayMedia is tuned for slide-sharing, and every audio constraint below is
 * turned *off* because they are voice-call processing that destroys game audio.
 */

export type QualityPresetName = "1080p60" | "1080p30" | "720p60" | "720p30";

export interface QualityPreset {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  /** Encoder ceiling in bits/sec. Applied in quality.ts, not here. */
  readonly maxBitrate: number;
}

export const QUALITY_PRESETS: Record<QualityPresetName, QualityPreset> = {
  "1080p60": { label: "1080p 60fps", width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
  "1080p30": { label: "1080p 30fps", width: 1920, height: 1080, frameRate: 30, maxBitrate: 6_000_000 },
  // The floor the project promises: 720p @ 6 Mbps.
  "720p60": { label: "720p 60fps", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 },
  "720p30": { label: "720p 30fps", width: 1280, height: 720, frameRate: 30, maxBitrate: 4_000_000 },
};

export const DEFAULT_PRESET: QualityPresetName = "1080p60";

/**
 * Chrome-only getDisplayMedia options that TypeScript's DOM lib doesn't model yet.
 * Unknown members are ignored by browsers, so passing them is safe.
 */
interface ChromeDisplayMediaOptions extends DisplayMediaStreamOptions {
  systemAudio?: "include" | "exclude";
  /** Chrome/Edge 141+. What audio to offer when a window is picked. A hint only. */
  windowAudio?: "window" | "system" | "exclude";
  selfBrowserSurface?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
}

/**
 * Where the shared audio should come from.
 *
 *  - "app": only the game's own audio. Picking a window asks Chrome for that window's
 *    audio; picking a whole screen offers no audio at all, and the app then asks for a
 *    second pick of the game window just for its sound (captureAudioOnly). This is the
 *    point of the project: viewers hear the game, never Discord or music.
 *  - "system": everything the PC plays.
 *  - "none": video only.
 */
export type AudioMode = "app" | "system" | "none";

export const AUDIO_MODES: readonly AudioMode[] = ["app", "system", "none"];
export const DEFAULT_AUDIO_MODE: AudioMode = "app";

export function isAudioMode(v: string | null): v is AudioMode {
  return v !== null && (AUDIO_MODES as readonly string[]).includes(v);
}

/** What picker #1 returned. Chrome reports it on the video track's settings. */
export type Surface = "monitor" | "window" | "browser" | "unknown";

export interface CaptureResult {
  stream: MediaStream;
  video: MediaStreamTrack;
  /**
   * The track currently being sent. Null when the user unticked "share audio", on a
   * platform that can't, or while a whole-screen share waits for an audio pick.
   * May be swapped mid-share for one from captureAudioOnly.
   */
  audio: MediaStreamTrack | null;
  surface?: Surface;
}

/** Audio borrowed from a second, audio-only pick. Its own stream must be stopped with it. */
export interface AudioSource {
  stream: MediaStream;
  track: MediaStreamTrack;
  kind: "window" | "system";
  /** The picked window's title when Chrome exposes one, for the UI. */
  label: string | null;
}

/**
 * macOS Chrome cannot capture system audio — only tab audio. There is no workaround.
 * Detect it so the UI can say so instead of looking broken.
 */
export function systemAudioSupport(): { supported: boolean; reason?: string } {
  const ua = navigator.userAgent;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";

  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    return {
      supported: false,
      reason:
        "On macOS, Chrome can only capture audio from a browser tab, not from a game or the system. " +
        "Your screen will share fine, but without game audio.",
    };
  }
  if (/Linux/i.test(platform) && !/Android/i.test(ua)) {
    return {
      supported: false,
      reason:
        "On Linux, screen capture goes through PipeWire and system audio is usually unavailable. " +
        "Video will work; audio probably won't.",
    };
  }
  if (!/Chrome|Chromium|Edg/i.test(ua)) {
    return {
      supported: false,
      reason: "System audio capture requires Chrome or Edge on Windows.",
    };
  }
  return { supported: true };
}

/** First Chromium version with the `windowAudio` option. */
export const WINDOW_AUDIO_MIN_CHROME = 141;

/**
 * Whether the browser understands `windowAudio`, which "app" mode depends on.
 * Older versions silently ignore the option and fall back to offering system audio.
 * Edge shares Chromium's version numbers, so the Chrome/NN token covers both.
 */
export function windowAudioSupport(): { supported: boolean; reason?: string } {
  const base = systemAudioSupport();
  if (!base.supported) return base;
  const major = Number(/Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent)?.[1] ?? NaN);
  if (!Number.isFinite(major) || major < WINDOW_AUDIO_MIN_CHROME) {
    return {
      supported: false,
      reason:
        `Sharing only a game's audio needs Chrome or Edge ${WINDOW_AUDIO_MIN_CHROME} or newer. ` +
        "Update your browser, or pick \"All system audio\".",
    };
  }
  return { supported: true };
}

/**
 * All three OFF. These are voice-call DSP: echo cancellation eats game audio as
 * "echo", noise suppression strips ambience, and AGC pumps the volume on every
 * explosion. They are the usual cause of "the audio sounds underwater".
 */
const GAME_AUDIO: MediaTrackConstraints = {
  channelCount: 2,
  sampleRate: 48000,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

function surfaceOf(track: MediaStreamTrack): Surface {
  const s = (track.getSettings?.() as MediaTrackSettings & { displaySurface?: string } | undefined)
    ?.displaySurface;
  return s === "monitor" || s === "window" || s === "browser" ? s : "unknown";
}

export async function captureScreen(
  preset: QualityPreset,
  mode: AudioMode,
): Promise<CaptureResult> {
  const options: ChromeDisplayMediaOptions = {
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate, max: preset.frameRate },
      // Open the picker on the Window tab. The goal is sharing one game window, and a
      // whole-screen share also shows notifications, chat pop-ups and every other
      // app. Only a starting point: the other tabs stay one click away.
      displaySurface: "window",
    } as MediaTrackConstraints,
    audio: mode === "none" ? false : GAME_AUDIO,
    // In "app" mode a whole-screen pick must not offer system audio: that is exactly
    // the mix of Discord and music this mode exists to keep out. The app asks for the
    // game's window separately instead.
    systemAudio: mode === "system" ? "include" : "exclude",
    windowAudio: mode === "app" ? "window" : mode === "system" ? "system" : "exclude",
    selfBrowserSurface: "exclude",
    monitorTypeSurfaces: "include",
    surfaceSwitching: "include",
  };

  const stream = await navigator.mediaDevices.getDisplayMedia(options);

  const video = stream.getVideoTracks()[0];
  if (!video) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("getDisplayMedia returned no video track");
  }
  const audio = stream.getAudioTracks()[0] ?? null;

  // Content hints materially change encoder behaviour.
  //  - "motion": trade per-frame sharpness for framerate. Correct for games.
  //    ("detail" is for text/slides and makes game footage stutter.)
  //  - "music": stop Opus applying speech-optimised coding to game audio.
  video.contentHint = "motion";
  if (audio) audio.contentHint = "music";

  return { stream, video, audio, surface: surfaceOf(video) };
}

/**
 * Chrome labels capture tracks either with the window title or with an opaque id
 * like "window:1234:0". Only the former is worth showing.
 */
function readableLabel(track: MediaStreamTrack | undefined): string | null {
  const label = track?.label?.trim();
  if (!label || /^(window|screen|web-contents-media-stream):/i.test(label)) return null;
  return label;
}

/**
 * Picker #2: capture audio only, to go with a whole-screen share.
 *
 * getDisplayMedia cannot be asked for audio alone, so this requests the smallest
 * video the browser will give and then leaves that track running but disabled.
 * Stopping it outright might end the capture, and the audio with it; Chrome does
 * not document either way, and a disabled 1 fps thumbnail costs next to nothing.
 *
 * Needs its own click: Chrome only opens a picker from a user gesture, and the
 * first picker has already used that click up.
 *
 * Resolves null when the user picked something without audio (or unticked it).
 */
export async function captureAudioOnly(kind: "window" | "system"): Promise<AudioSource | null> {
  const options: ChromeDisplayMediaOptions = {
    video: {
      width: { ideal: 320 },
      height: { ideal: 180 },
      frameRate: { ideal: 1, max: 1 },
      // Which picker tab opens first. It is a video constraint: at the top level of
      // the options, where it used to be, Chrome ignores it.
      displaySurface: kind === "window" ? "window" : "monitor",
    } as MediaTrackConstraints,
    audio: GAME_AUDIO,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    ...(kind === "window"
      ? {
          // Windows only: a tab or screen here would bring the wrong audio.
          monitorTypeSurfaces: "exclude" as const,
          windowAudio: "window" as const,
          systemAudio: "exclude" as const,
        }
      : {
          monitorTypeSurfaces: "include" as const,
          systemAudio: "include" as const,
        }),
  };

  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }
  const video = stream.getVideoTracks()[0];
  if (video) video.enabled = false;
  track.contentHint = "music";
  return { stream, track, kind, label: kind === "window" ? readableLabel(video) : null };
}

export function stopAudioSource(source: AudioSource): void {
  source.stream.getTracks().forEach((t) => t.stop());
}

/** Fires when the user clicks the browser's own "Stop sharing" bar. */
export function onCaptureEnded(result: CaptureResult, cb: () => void): () => void {
  const handler = () => cb();
  result.video.addEventListener("ended", handler);
  return () => result.video.removeEventListener("ended", handler);
}

export function stopCapture(result: CaptureResult): void {
  result.stream.getTracks().forEach((t) => t.stop());
}
