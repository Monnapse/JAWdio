'use client';
import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { JAWDIO_VERSION, GITHUB_REPO } from '@/lib/version';

interface SoundFile { name: string; filename: string; category: string; }

interface AudioContextType {
  status: string; isHost: boolean; sounds: SoundFile[]; cableName: string; mics: MediaDeviceInfo[];
  micVolume: number; setMicVolume: (v: number) => void;
  soundVolume: number; setSoundVolume: (v: number) => void;
  activeMicId: string; hotkeys: Record<string, string>; setHotkeys: (h: Record<string, string>) => void;
  loadSounds: () => void; handleMicChange: (id: string) => void;
  playAudioLocally: (filename: string) => void; handleStopClick: () => void;
  handleButtonClick: (filename: string, isEditMode: boolean, setBindingTarget: (f: string) => void) => void;
  handleDeleteSound: (filename: string) => Promise<void>;
  hasUpdate: boolean; latestVersion: string;
  
  // NEW: Server States
  serverRunning: boolean; serverIp: string; serverPort: string;
  setServerPort: (p: string) => void; toggleServer: () => Promise<void>;
}

const AudioContext = createContext<AudioContextType | null>(null);

export const AudioProvider = ({ children }: { children: React.ReactNode }) => {
  const [status, setStatus] = useState('Active');
  const [isHost, setIsHost] = useState(false);
  const [sounds, setSounds] = useState<SoundFile[]>([]);
  const [cableName, setCableName] = useState('Scanning...');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micVolume, setMicVolume] = useState(1);
  const [soundVolume, setSoundVolume] = useState(1);
  const [activeMicId, setActiveMicId] = useState("none");
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({});
  const [hasUpdate, setHasUpdate] = useState(false);
  const [latestVersion, setLatestVersion] = useState("");

  // SERVER STATES
  const [serverRunning, setServerRunning] = useState(false);
  const [serverIp, setServerIp] = useState("127.0.0.1");
  const [serverPort, setServerPort] = useState("8080");

  const virtualCableIdRef = useRef<string | null>(null);
  const micAudioRef = useRef<HTMLAudioElement>(null);
  const activeSoundsRef = useRef<Set<HTMLAudioElement>>(new Set());

  // ... (Keep existing useEffects for Volume, loadSounds, checkUpdates)
  useEffect(() => { if (micAudioRef.current) micAudioRef.current.volume = micVolume; }, [micVolume]);
  useEffect(() => { activeSoundsRef.current.forEach(a => { a.volume = soundVolume; }); }, [soundVolume]);

  const loadSounds = async () => {
    try {
      const res = await fetch('/api/sounds');
      const data = await res.json();
      setSounds(Object.values(data.library).flat() as SoundFile[]);
    } catch (e) {}
  };

  useEffect(() => {
    const savedKeys = localStorage.getItem('jawdio-hotkeys');
    const savedPort = localStorage.getItem('jawdio-port') || "8080";
    setServerPort(savedPort);

    const isElectron = typeof window !== 'undefined' && window.electronAPI;
    
    if (isElectron) {
      setIsHost(true);
      if (savedKeys) {
        const parsed = JSON.parse(savedKeys);
        setHotkeys(parsed);
        window.electronAPI.clearHotkeys();
        Object.entries(parsed).forEach(([f, k]) => window.electronAPI.registerHotkey(k as string, f));
      }
      
      // Get initial server IP
      window.electronAPI.getServerStatus().then((s: any) => {
        setServerRunning(s.isRunning);
        setServerIp(s.ip);
      });

      setupAudioDevices();
      window.electronAPI.onTriggerSound((f: string) => f === '__STOP_ALL__' ? handleStopClickLocally() : playAudioLocally(f));
    }
    loadSounds();
  }, []);

  const toggleServer = async () => {
    if (!window.electronAPI) return;
    if (serverRunning) {
      await window.electronAPI.stopServer();
      setServerRunning(false);
    } else {
      localStorage.setItem('jawdio-port', serverPort);
      const res = await window.electronAPI.startServer(parseInt(serverPort));
      if (res.success) {
        setServerRunning(true);
        setServerIp(res.ip);
      } else {
        alert("Failed to start server: " + res.error);
      }
    }
  };

  const setupAudioDevices = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cable = devices.find(d => d.kind === 'audiooutput' && d.label.toLowerCase().includes('cable input'));
    if (cable) { setCableName(cable.label); virtualCableIdRef.current = cable.deviceId; }
    setMics(devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default'));
  };

  const handleMicChange = async (id: string) => { /* Keep existing */ };
  const playAudioLocally = async (filename: string) => { /* Keep existing */ };
  const handleStopClickLocally = () => { /* Keep existing */ };

  const handleStopClick = async () => {
    if (isHost) handleStopClickLocally();
    else try { await fetch(`http://${window.location.hostname}:${serverPort}/play/__STOP_ALL__`); } catch(e) {}
  };

  const handleButtonClick = async (filename: string, isEditMode: boolean, setBindingTarget: (f: string) => void) => {
    if (isEditMode) { if (isHost) setBindingTarget(filename); return; }
    if (isHost) {
      playAudioLocally(filename);
    } else {
      try {
        const safePath = filename.split('/').map(encodeURIComponent).join('/');
        await fetch(`http://${window.location.hostname}:${serverPort}/play/${safePath}`);
      } catch (err) { console.error(err); }
    }
  };

  const handleDeleteSound = async (filename: string) => {
    await fetch('/api/sounds', { method: 'DELETE', body: JSON.stringify({ filename }) });
    loadSounds();
  };

  return (
    <AudioContext.Provider value={{ 
      status, isHost, sounds, cableName, mics, micVolume, setMicVolume, soundVolume, setSoundVolume, 
      activeMicId, hotkeys, setHotkeys, loadSounds, handleMicChange, playAudioLocally, handleStopClick, 
      handleButtonClick, handleDeleteSound, hasUpdate, latestVersion,
      serverRunning, serverIp, serverPort, setServerPort, toggleServer // Exposed to UI
    }}>
      <audio ref={micAudioRef} className="hidden" />
      {children}
    </AudioContext.Provider>
  );
};

export const useAudio = () => {
  const c = useContext(AudioContext);
  if (!c) throw new Error("Audio Context Error");
  return c;
};