import type { IpcRendererEvent } from "electron";

declare function require(id: "electron"): typeof import("electron");

const { contextBridge, ipcRenderer } = require("electron");

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
  startWindowAudio: async (sourceId?: string): Promise<boolean> =>
    (await ipcRenderer.invoke("audio:start-window", sourceId)) === true,
  startSystemAudio: async (): Promise<boolean> =>
    (await ipcRenderer.invoke("audio:start-system")) === true,
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
