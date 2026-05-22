const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onTriggerSound: (callback) => ipcRenderer.on('trigger-sound', (_event, value) => callback(value)),
  onEngineCommand: (callback) => ipcRenderer.on('engine-command', (_event, cmd) => callback(cmd)),
  onEngineCommandPayload: (callback) =>
    ipcRenderer.on('engine-command-payload', (_event, payload) => callback(payload)),
  onEnginePreviewRequest: (callback) =>
    ipcRenderer.on('engine-preview-request', (_event, payload) => callback(payload)),
  respondEnginePreview: (payload) => ipcRenderer.send('engine-preview-response', payload),
  publishEngineState: (snapshot) => ipcRenderer.send('engine-publish', snapshot),
  registerHotkey: (key, filename) => ipcRenderer.send('register-hotkey', { key, filename }),
  clearHotkeys: () => ipcRenderer.send('clear-hotkeys'),
  sendWindowAction: (action) => ipcRenderer.send('window-controls', action),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  getLanUrls: () => ipcRenderer.invoke('get-lan-urls'),
});