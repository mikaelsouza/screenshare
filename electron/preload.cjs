// @ts-nocheck
// 
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  version: process.versions.electron,
  // Game follow (see electron/follow). Returns an unsubscribe function.
  onFollowUpdate: (callback) => {
    const handler = (_event, update) => callback(update);
    ipcRenderer.on('follow:update', handler);
    return () => ipcRenderer.removeListener('follow:update', handler);
  },
  stopFollow: () => ipcRenderer.send('follow:stop'),
  // Per-app & system audio capture (see electron/audio).
  startWindowAudio: (sourceId) => ipcRenderer.invoke('audio:start-window', sourceId),
  pickWindowAudio: () => ipcRenderer.invoke('audio:pick-window'),
  startSystemAudio: () => ipcRenderer.invoke('audio:start-system'),
  stopAudio: () => ipcRenderer.send('audio:stop'),
  onAudioPcm: (callback) => {
    const handler = (_event, pcm) => callback(pcm);
    ipcRenderer.on('audio:pcm', handler);
    return () => ipcRenderer.removeListener('audio:pcm', handler);
  },
});
