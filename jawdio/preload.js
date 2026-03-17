const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onTriggerSound: (callback) => ipcRenderer.on('trigger-sound', (_event, value) => callback(value)),
  onEngineCommand: (callback) => ipcRenderer.on('engine-command', (_event, cmd) => callback(cmd)),
  registerHotkey: (key, filename) => ipcRenderer.send('register-hotkey', { key, filename }),
  clearHotkeys: () => ipcRenderer.send('clear-hotkeys'),
  sendWindowAction: (action) => ipcRenderer.send('window-controls', action),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
});