'use client';
import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { JAWDIO_VERSION, GITHUB_REPO } from '@/lib/version';

interface SoundFile { name: string; filename: string; category: string; }

interface AudioContextType {
  status: string; isHost: boolean; sounds: SoundFile[]; cableName: string; 
  mics: MediaDeviceInfo[]; outputs: MediaDeviceInfo[];
  micVolume: number; setMicVolume: (v: number) => void;
  soundVolume: number; setSoundVolume: (v: number) => void;
  activeMicId: string; hotkeys: Record<string, string>; setHotkeys: (h: Record<string, string>) => void;
  loadSounds: () => void; handleMicChange: (id: string) => void;
  playAudioLocally: (filename: string) => void; handleStopClick: () => void;
  handleButtonClick: (filename: string, isEditMode: boolean, setBindingTarget: (f: string) => void) => void;
  handleDeleteSound: (filename: string) => Promise<void>;
  hasUpdate: boolean; latestVersion: string;
  hearOwnSounds: boolean; setHearOwnSounds: (v: boolean) => void;
}

const AudioContext = createContext<AudioContextType | null>(null);

export const AudioProvider = ({ children }: { children: React.ReactNode }) => {
  const [status, setStatus] = useState('Active');
  const [isHost, setIsHost] = useState(false);
  const [sounds, setSounds] = useState<SoundFile[]>([]);
  const [cableName, setCableName] = useState('Scanning...');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [micVolume, setMicVolume] = useState(1);
  const [soundVolume, setSoundVolume] = useState(1);
  const [activeMicId, setActiveMicId] = useState("none");
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({});
  const [hasUpdate, setHasUpdate] = useState(false);
  const [latestVersion, setLatestVersion] = useState("");
  const [hearOwnSounds, setHearOwnSoundsState] = useState(false);

  const virtualCableIdRef = useRef<string | null>(null);
  const micAudioRef = useRef<HTMLAudioElement>(null);
  const activeSoundsRef = useRef<Set<HTMLAudioElement>>(new Set());
  
  const soundVolumeRef = useRef(soundVolume);
  const ipcRegisteredRef = useRef(false);
  const hearOwnSoundsRef = useRef(hearOwnSounds);

  const setHearOwnSounds = (val: boolean) => {
    setHearOwnSoundsState(val);
    localStorage.setItem('jawdio-hear-sounds', JSON.stringify(val));
  };

  useEffect(() => { soundVolumeRef.current = soundVolume; }, [soundVolume]);
  useEffect(() => { hearOwnSoundsRef.current = hearOwnSounds; }, [hearOwnSounds]);
  useEffect(() => { if (micAudioRef.current) micAudioRef.current.volume = micVolume; }, [micVolume]);
  useEffect(() => { activeSoundsRef.current.forEach(a => { a.volume = soundVolume; }); }, [soundVolume]);

  const loadSounds = async () => {
    try {
      const res = await fetch(`/api/sounds?t=${Date.now()}`); 
      const data = await res.json();
      setSounds(Object.values(data.library).flat() as SoundFile[]);
    } catch (e) {
      console.error("Failed to load sounds:", e);
    }
  };

  useEffect(() => {
    const checkUpdates = async () => {
      try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.tag_name) {
          const latest = data.tag_name.replace('v', '');
          if (latest !== JAWDIO_VERSION) {
            setLatestVersion(latest);
            setHasUpdate(true);
          }
        }
      } catch (error) {
        console.error("Update check failed:", error);
      }
    };
    checkUpdates();

    const savedKeys = localStorage.getItem('jawdio-hotkeys');
    const savedHearSounds = localStorage.getItem('jawdio-hear-sounds');
    if (savedHearSounds !== null) setHearOwnSoundsState(JSON.parse(savedHearSounds));

    const isElectron = typeof window !== 'undefined' && window.electronAPI;
    
    if (isElectron) {
      setIsHost(true);
      if (savedKeys) {
        const parsed = JSON.parse(savedKeys);
        setHotkeys(parsed);
        window.electronAPI.clearHotkeys();
        Object.entries(parsed).forEach(([f, k]) => window.electronAPI.registerHotkey(k as string, f));
      }

      setupAudioDevices();
      
      if (!ipcRegisteredRef.current) {
        ipcRegisteredRef.current = true;
        window.electronAPI.onTriggerSound((f: string) => f === '__STOP_ALL__' ? handleStopClickLocally() : playAudioLocally(f));
      }
    }
    loadSounds();
  }, []);

  const setupAudioDevices = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cable = devices.find(d => d.kind === 'audiooutput' && d.label.toLowerCase().includes('cable input'));
    if (cable) { setCableName(cable.label); virtualCableIdRef.current = cable.deviceId; }
    
    setMics(devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default'));
    setOutputs(devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default'));
  };

  const handleMicChange = async (id: string) => {
    setActiveMicId(id);
    if (id === 'none') {
      if (micAudioRef.current) micAudioRef.current.srcObject = null;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      if (micAudioRef.current) {
        micAudioRef.current.srcObject = stream;
        if (virtualCableIdRef.current && typeof (micAudioRef.current as any).setSinkId === 'function') {
          await (micAudioRef.current as any).setSinkId(virtualCableIdRef.current);
        }
        micAudioRef.current.play();
      }
    } catch (err) {
      console.error("Error connecting mic:", err);
    }
  };

  const playAudioLocally = async (filename: string) => {
    try {
      const safePath = filename.split('/').map(encodeURIComponent).join('/');
      const playPromises = [];

      // 1. ALWAYS play to the Virtual Cable Input
      const cableAudio = new Audio(`/sounds/${safePath}`);
      cableAudio.volume = soundVolumeRef.current;
      if (virtualCableIdRef.current && typeof (cableAudio as any).setSinkId === 'function') {
        await (cableAudio as any).setSinkId(virtualCableIdRef.current);
      }
      activeSoundsRef.current.add(cableAudio);
      cableAudio.onended = () => activeSoundsRef.current.delete(cableAudio);
      playPromises.push(cableAudio.play());

      // 2. Play locally ONLY if "Hear My Own Sounds" is ON
      if (hearOwnSoundsRef.current) {
        const localAudio = new Audio(`/sounds/${safePath}`);
        localAudio.volume = soundVolumeRef.current;
        // Bypassing setSinkId defaults to your primary desktop speakers
        activeSoundsRef.current.add(localAudio);
        localAudio.onended = () => activeSoundsRef.current.delete(localAudio);
        playPromises.push(localAudio.play());
      }

      await Promise.all(playPromises);
    } catch (error) {
      console.error("Error playing audio:", error);
    }
  };

  const handleStopClickLocally = () => {
    activeSoundsRef.current.forEach(audio => {
      audio.pause();
      audio.currentTime = 0;
    });
    activeSoundsRef.current.clear();
  };

  const handleStopClick = async () => {
    if (isHost) handleStopClickLocally();
    else try { await fetch(`http://${window.location.hostname}:8080/play/__STOP_ALL__`); } catch(e) {}
  };

  const handleButtonClick = async (filename: string, isEditMode: boolean, setBindingTarget: (f: string) => void) => {
    if (isEditMode) { if (isHost) setBindingTarget(filename); return; }
    if (isHost) {
      playAudioLocally(filename);
    } else {
      try {
        const safePath = filename.split('/').map(encodeURIComponent).join('/');
        await fetch(`http://${window.location.hostname}:8080/play/${safePath}`);
      } catch (err) { console.error(err); }
    }
  };

  const handleDeleteSound = async (filename: string) => {
    await fetch('/api/sounds', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }) });
    loadSounds();
  };

  return (
    <AudioContext.Provider value={{ 
      status, isHost, sounds, cableName, mics, outputs, micVolume, setMicVolume, soundVolume, setSoundVolume, 
      activeMicId, hotkeys, setHotkeys, loadSounds, handleMicChange, playAudioLocally, handleStopClick, 
      handleButtonClick, handleDeleteSound, hasUpdate, latestVersion, hearOwnSounds, setHearOwnSounds
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