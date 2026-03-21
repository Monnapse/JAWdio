export {};

declare global {
  type WindowAction = "close" | "minimize" | "maximize";

  interface DesktopSource {
    id: string;
    name: string;
  }

  interface ElectronAPI {
    onTriggerSound: (callback: (filename: string) => void) => void;
    onEngineCommand: (callback: (command: string) => void) => void;
    registerHotkey: (key: string, filename: string) => void;
    clearHotkeys: () => void;
    sendWindowAction: (action: WindowAction) => void;
    getDesktopSources: () => Promise<DesktopSource[]>;
  }

  interface Window {
    electronAPI?: ElectronAPI;
    webkitAudioContext?: typeof AudioContext;
  }
}
