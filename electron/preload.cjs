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
});
