export {};

declare global {
  type WindowAction = "close" | "minimize" | "maximize";

  interface DesktopSource {
    id: string;
    name: string;
  }

  interface LanUrl {
    label: string;
    url: string;
    ip: string;
    port: number;
  }

  interface ElectronAPI {
    onTriggerSound: (callback: (filename: string) => void) => void;
    onEngineCommand: (callback: (command: string) => void) => void;
    onEngineCommandPayload: (callback: (payload: unknown) => void) => void;
    onEnginePreviewRequest: (
      callback: (payload: { id: number; start: number; end: number }) => void,
    ) => void;
    respondEnginePreview: (payload: {
      id: number;
      bytes: Uint8Array | null;
    }) => void;
    publishEngineState: (snapshot: unknown) => void;
    registerHotkey: (key: string, filename: string) => void;
    clearHotkeys: () => void;
    sendWindowAction: (action: WindowAction) => void;
    getDesktopSources: () => Promise<DesktopSource[]>;
    getLanUrls: () => Promise<LanUrl[]>;
  }

  interface Window {
    electronAPI?: ElectronAPI;
    webkitAudioContext?: typeof AudioContext;
  }

  interface MediaDevices {
    selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
  }
}
