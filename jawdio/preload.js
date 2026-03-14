const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onTriggerSound: (callback) => ipcRenderer.on('trigger-sound', (_event, value) => callback(value)),
  registerHotkey: (key, filename) => ipcRenderer.send('register-hotkey', { key, filename }),
  clearHotkeys: () => ipcRenderer.send('clear-hotkeys'),
  sendWindowAction: (action) => ipcRenderer.send('window-controls', action),
  
  // NEW: Remote Server Controls
  startServer: (port) => ipcRenderer.invoke('start-server', port),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
});