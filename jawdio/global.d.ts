// global.d.ts
export {};

declare global {
  interface Window {
    electronAPI: {
      onTriggerSound: (callback: (filename: string) => void) => void;
      registerHotkey: (key: string, filename: string) => void;
      clearHotkeys: () => void;
      sendWindowAction: (action: 'close' | 'minimize' | 'maximize') => void;
      
      // Remote Server Controls
      startServer: (port: number) => Promise<{ success: boolean; ip: string; error?: string }>;
      stopServer: () => Promise<{ success: boolean }>;
      getServerStatus: () => Promise<{ isRunning: boolean; ip: string }>;
    };
  }
}