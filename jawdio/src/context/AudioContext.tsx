'use client';
import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
// THE FIX: Importing our version constants
import { JAWDIO_VERSION, GITHUB_REPO } from '@/lib/version';

interface SoundFile { name: string; filename: string; }

interface AudioContextType {
  status: string; isHost: boolean; sounds: SoundFile[]; cableName: string; mics: MediaDeviceInfo[];
  micVolume: number; setMicVolume: (v: number) => void;
  soundVolume: number; setSoundVolume: (v: number) => void;
  activeMicId: string; hotkeys: Record<string, string>; setHotkeys: (h: Record<string, string>) => void;
  loadSounds: () => void; handleMicChange: (id: string) => void;
  playAudioLocally: (filename: string) => void; handleStopClick: () => void;
  handleButtonClick: (filename: string, isEditMode: boolean, setBindingTarget: (f: string) => void) => void;
  handleDeleteSound: (filename: string) => Promise<void>;
  // THE FIX: Adding these to the interface
  hasUpdate: boolean;
  latestVersion: string;
}

const AudioContext = createContext<AudioContextType | null>(null);

export const AudioProvider = ({ children }: { children: React.ReactNode }) => {
  const [status, setStatus] = useState('System Ready');
  const [isHost, setIsHost] = useState(false);
  const [sounds, setSounds] = useState<SoundFile[]>([]);
  const [cableName, setCableName] = useState('Searching...');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micVolume, setMicVolume] = useState(1);
  const [soundVolume, setSoundVolume] = useState(1);
  const [activeMicId, setActiveMicId] = useState("none");
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({});
  
  // NEW: Update States
  const [hasUpdate, setHasUpdate] = useState(false);
  const [latestVersion, setLatestVersion] = useState("");

  const virtualCableIdRef = useRef<string | null>(null);
  const micAudioRef = useRef<HTMLAudioElement>(null);
  const activeSoundsRef = useRef<Set<HTMLAudioElement>>(new Set());

  // Volume listeners
  useEffect(() => { if (micAudioRef.current) micAudioRef.current.volume = micVolume; }, [micVolume]);
  useEffect(() => { activeSoundsRef.current.forEach(a => { a.volume = soundVolume; }); }, [soundVolume]);

  const loadSounds = () => {
    fetch('/api/sounds').then(res => res.json()).then(data => setSounds(data.sounds));
  };

  // THE FIX: Update checking logic
  const checkUpdates = async () => {
    try {
      const response = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/lib/version.ts`);
      const text = await response.text();
      const match = text.match(/JAWDIO_VERSION = "(.*?)"/);
      if (match && match[1]) {
        const remoteVersion = match[1];
        setLatestVersion(remoteVersion);
        if (remoteVersion !== JAWDIO_VERSION) setHasUpdate(true);
      }
    } catch (e) { console.error("Update check failed", e); }
  };

  useEffect(() => {
    loadSounds();
    checkUpdates();
    if (typeof window !== 'undefined' && window.electronAPI) {
      setIsHost(true);
      setupAudioDevices();
      window.electronAPI.onTriggerSound((f: string) => {
        if (f === '__STOP_ALL__') {
          activeSoundsRef.current.forEach(a => { a.pause(); a.currentTime = 0; });
          activeSoundsRef.current.clear();
        } else {
          playAudioLocally(f);
        }
      });
    }
  }, []);

  const setupAudioDevices = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cable = devices.find(d => d.kind === 'audiooutput' && d.label.toLowerCase().includes('cable input'));
    if (cable) { setCableName(cable.label); virtualCableIdRef.current = cable.deviceId; }
    setMics(devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default'));
  };

  const handleMicChange = async (id: string) => {
    setActiveMicId(id);
    if (micAudioRef.current?.srcObject) (micAudioRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    if (id === "none" || !virtualCableIdRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 } 
    });
    if (micAudioRef.current) {
      micAudioRef.current.srcObject = stream;
      await (micAudioRef.current as any).setSinkId(virtualCableIdRef.current);
      micAudioRef.current.play();
    }
  };

  const playAudioLocally = async (filename: string) => {
    if (!virtualCableIdRef.current) return;
    const audio = new Audio(`/sounds/${filename}`);
    audio.volume = soundVolume;
    activeSoundsRef.current.add(audio);
    await (audio as any).setSinkId(virtualCableIdRef.current);
    audio.play();
  };

  const handleStopClick = async () => {
    activeSoundsRef.current.forEach(a => { a.pause(); a.currentTime = 0; });
    activeSoundsRef.current.clear();
    if (!isHost) await fetch(`http://${window.location.hostname}:8080/play/__STOP_ALL__`);
  };

  const handleButtonClick = (filename: string, isEditMode: boolean, setBindingTarget: (f: string) => void) => {
    if (isEditMode) { setBindingTarget(filename); return; }
    playAudioLocally(filename);
  };

  const handleDeleteSound = async (filename: string) => {
    await fetch('/api/sounds', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }) });
    loadSounds();
  };

  return (
    <AudioContext.Provider value={{ 
      status, isHost, sounds, cableName, mics, micVolume, setMicVolume, soundVolume, setSoundVolume, 
      activeMicId, hotkeys, setHotkeys, loadSounds, handleMicChange, playAudioLocally, handleStopClick, 
      handleButtonClick, handleDeleteSound, hasUpdate, latestVersion 
    }}>
      <audio ref={micAudioRef} className="hidden" />
      {children}
    </AudioContext.Provider>
  );
};

export const useAudio = () => {
  const c = useContext(AudioContext);
  if (!c) throw new Error("useAudio error");
  return c;
};