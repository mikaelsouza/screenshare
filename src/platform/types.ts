/**
 * The capture boundary between the web app and the desktop (Electron) app.
 *
 * Everything above this line (rooms, tiles, the mesh) is shared. Below it, the web
 * build uses the browser's own picker and the desktop build uses the Electron main
 * process, which can also follow a game from its lobby window to its game window.
 */

import type { AudioMode, AudioSource, CaptureResult, QualityPreset } from "../capture";

/**
 * Where a follow currently is. "lobby" and "game" are the two windows of a game
 * profile; "waiting" means neither is open and the grace period is running.
 */
type FollowRole = "lobby" | "game" | "waiting";

/** What the Electron main process sends while it follows a game. See electron/follow. */
export interface FollowUpdate {
  role: FollowRole | "ended";
  sourceId: string | null;
  title: string | null;
  /** The profile's display name, e.g. "League of Legends". */
  profile: string;
}

/** What the UI shows while a follow is active. */
export interface FollowState {
  role: FollowRole;
  profile: string;
  title: string | null;
}

/**
 * Exposed by electron/preload.cts. Every method beyond the flags is optional: the
 * desktop app loads the hosted site, so an older app can meet a newer page.
 */
export interface ElectronAPI {
  readonly isElectron: boolean;
  readonly platform: string;
  readonly version: string;
  onFollowUpdate?: (cb: (update: FollowUpdate) => void) => () => void;
  stopFollow?: () => void;
  startWindowAudio?: ((sourceId?: string) => Promise<boolean>) | undefined;
  pickWindowAudio?: (() => Promise<{ ok: boolean; label: string | null }>) | undefined;
  startSystemAudio?: (() => Promise<boolean>) | undefined;
  stopAudio?: (() => void) | undefined;
  onAudioPcm?: ((cb: (pcm: Uint8Array) => void) => () => void) | undefined;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI | undefined;
  }
}

/** Why a share ended by itself (as opposed to the user pressing Stop). */
export type EndReason = "source-closed" | "follow-ended";

export interface CaptureCallbacks {
  onEnded(reason: EndReason): void;
  /** The captured window changed. `stream` holds the new video and the same audio. */
  onVideoTrackSwapped(track: MediaStreamTrack, stream: MediaStream): void | Promise<void>;
  /** Null when no follow is active. */
  onFollowState(state: FollowState | null): void;
}

export interface CaptureController {
  readonly kind: "web" | "electron";
  /** Whether the desktop app has the WASAPI per-app audio bridge. */
  readonly hasPerAppAudio: boolean;
  /** Opens the picker. Rejects when the user cancels. */
  start(preset: QualityPreset, mode: AudioMode): Promise<CaptureResult>;
  /** Switch audio mid-share (either to a specific window or to all system audio). */
  captureAudioOnly(kind: "window" | "system"): Promise<AudioSource | null>;
  /** The preset to use for windows captured later in this share. */
  setPreset(preset: QualityPreset): void;
  stop(): void;
}

/**
 * Picks the audio track a share sends. The default keeps whatever came back with
 * the screen capture; per-app audio capture plugs in here.
 */
export type AudioSourceProvider = (capture: CaptureResult, mode: AudioMode) => Promise<MediaStreamTrack | null>;
