import type { IpcRendererEvent } from "electron";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

interface FollowUpdatePayload {
  role: "lobby" | "game" | "waiting" | "ended";
  sourceId: string | null;
  title: string | null;
  profile: string;
}

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  version: process.versions["electron"] ?? "",
  // Game follow (see electron/follow). Returns an unsubscribe function.
  onFollowUpdate: (callback: (update: FollowUpdatePayload) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, update: FollowUpdatePayload): void => {
      callback(update);
    };
    ipcRenderer.on("follow:update", handler);
    return (): void => {
      ipcRenderer.removeListener("follow:update", handler);
    };
  },
  stopFollow: (): void => {
    ipcRenderer.send("follow:stop");
  },
  // Per-app & system audio capture (see electron/audio).
  startWindowAudio: (sourceId?: string): Promise<boolean> =>
    ipcRenderer.invoke("audio:start-window", sourceId) as Promise<boolean>,
  pickWindowAudio: (): Promise<{ ok: boolean; label: string | null }> =>
    ipcRenderer.invoke("audio:pick-window") as Promise<{ ok: boolean; label: string | null }>,
  startSystemAudio: (): Promise<boolean> =>
    ipcRenderer.invoke("audio:start-system") as Promise<boolean>,
  stopAudio: (): void => {
    ipcRenderer.send("audio:stop");
  },
  onAudioPcm: (callback: (pcm: Uint8Array) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, pcm: Uint8Array): void => {
      callback(pcm);
    };
    ipcRenderer.on("audio:pcm", handler);
    return (): void => {
      ipcRenderer.removeListener("audio:pcm", handler);
    };
  },
});
