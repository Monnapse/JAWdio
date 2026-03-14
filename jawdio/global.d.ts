export interface ElectronAPI {
  onTriggerSound: (callback: (filename: string) => void) => void;
  registerHotkey: (key: string, filename: string) => void;
  clearHotkeys: () => void;
  sendWindowAction: (action: 'close' | 'minimize' | 'maximize') => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}