'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { GITHUB_REPO, JAWDIO_VERSION } from '@/lib/version';

interface SoundFile {
  name: string;
  filename: string;
  category: string;
}

interface AudioContextType {
  status: string;
  isHost: boolean;
  sounds: SoundFile[];
  cableName: string;
  mics: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  micVolume: number;
  setMicVolume: (value: number) => void;
  soundVolume: number;
  setSoundVolume: (value: number) => void;
  activeMicId: string;
  hotkeys: Record<string, string>;
  setHotkeys: (hotkeys: Record<string, string>) => void;
  loadSounds: () => Promise<void>;
  handleMicChange: (id: string) => Promise<void>;
  playAudioLocally: (filename: string) => Promise<void>;
  handleStopClick: () => Promise<void>;
  handleButtonClick: (
    filename: string,
    isEditMode: boolean,
    setBindingTarget: (filename: string) => void,
  ) => Promise<void>;
  handleDeleteSound: (filename: string) => Promise<void>;
  hasUpdate: boolean;
  latestVersion: string;
  hearOwnSounds: boolean;
  setHearOwnSounds: (value: boolean) => void;
}

type AudioElementWithSink = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

const AudioContext = createContext<AudioContextType | null>(null);

export const AudioProvider = ({ children }: { children: React.ReactNode }) => {
  const [status, setStatus] = useState('Standby');
  const [isHost, setIsHost] = useState(false);
  const [sounds, setSounds] = useState<SoundFile[]>([]);
  const [cableName, setCableName] = useState('Unavailable');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [micVolume, setMicVolume] = useState(1);
  const [soundVolume, setSoundVolume] = useState(0.9);
  const [activeMicId, setActiveMicId] = useState('none');
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({});
  const [hasUpdate, setHasUpdate] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');
  const [hearOwnSounds, setHearOwnSoundsState] = useState(false);

  const activeSoundsRef = useRef<Set<HTMLAudioElement>>(new Set());
  const hearOwnSoundsRef = useRef(hearOwnSounds);
  const soundVolumeRef = useRef(soundVolume);
  const ipcRegisteredRef = useRef(false);
  const micBroadcastAudioRef = useRef<HTMLAudioElement>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const virtualCableIdRef = useRef<string | null>(null);

  useEffect(() => {
    soundVolumeRef.current = soundVolume;
    activeSoundsRef.current.forEach((audioElement) => {
      audioElement.volume = soundVolume;
    });
  }, [soundVolume]);

  useEffect(() => {
    hearOwnSoundsRef.current = hearOwnSounds;
  }, [hearOwnSounds]);

  useEffect(() => {
    if (micBroadcastAudioRef.current) {
      micBroadcastAudioRef.current.volume = micVolume;
    }
  }, [micVolume]);

  const setHearOwnSounds = useCallback((value: boolean) => {
    setHearOwnSoundsState(value);
    localStorage.setItem('jawdio-hear-sounds', JSON.stringify(value));
  }, []);

  const loadSounds = useCallback(async () => {
    try {
      const response = await fetch(`/api/sounds?t=${Date.now()}`);

      if (!response.ok) {
        throw new Error(`Failed to load sounds: ${response.status}`);
      }

      const data = (await response.json()) as { library: Record<string, SoundFile[]> };
      setSounds(Object.values(data.library).flat());
    } catch (error) {
      console.error('Failed to load sounds:', error);
    }
  }, []);

  const resetAudioElement = useCallback((audioElement: HTMLAudioElement | null) => {
    if (!audioElement) {
      return;
    }

    audioElement.pause();
    audioElement.srcObject = null;
  }, []);

  const routeAudioElementToSink = useCallback(
    async (audioElement: AudioElementWithSink, sinkId: string) => {
      if (typeof audioElement.setSinkId !== 'function') {
        console.warn('Output device selection is unavailable. Blocking fallback to default audio.');
        return false;
      }

      try {
        await audioElement.setSinkId(sinkId);
        return true;
      } catch (error) {
        console.error('Failed to set audio output device:', error);
        return false;
      }
    },
    [],
  );

  const syncMicBroadcast = useCallback(async () => {
    const broadcastElement = micBroadcastAudioRef.current as AudioElementWithSink | null;
    const stream = micStreamRef.current;

    if (!broadcastElement) {
      return;
    }

    if (!stream || !virtualCableIdRef.current) {
      resetAudioElement(broadcastElement);
      return;
    }

    broadcastElement.srcObject = stream;

    const routedToCable = await routeAudioElementToSink(
      broadcastElement,
      virtualCableIdRef.current,
    );

    if (!routedToCable) {
      resetAudioElement(broadcastElement);
      return;
    }

    await broadcastElement.play().catch((error) => {
      console.error('Failed to start microphone broadcast routing:', error);
    });
  }, [resetAudioElement, routeAudioElementToSink]);

  const stopMicMonitoring = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;

    resetAudioElement(micBroadcastAudioRef.current);
  }, [resetAudioElement]);

  const setupAudioDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(
        (device) => device.kind === 'audioinput' && device.deviceId !== 'default',
      );
      const audioOutputs = devices.filter(
        (device) => device.kind === 'audiooutput' && device.deviceId !== 'default',
      );
      const virtualCable = audioOutputs.find((device) =>
        device.label.toLowerCase().includes('cable input'),
      );

      setMics(audioInputs);
      setOutputs(audioOutputs);
      setCableName(
        virtualCable?.label ?? audioOutputs[0]?.label ?? 'No virtual cable detected',
      );
      virtualCableIdRef.current = virtualCable?.deviceId ?? null;

      if (micStreamRef.current) {
        await syncMicBroadcast();
      }
    } catch (error) {
      console.error('Audio device scan failed:', error);
    }
  }, [syncMicBroadcast]);

  const handleMicChange = useCallback(
    async (id: string) => {
      setActiveMicId(id);
      stopMicMonitoring();

      if (id === 'none') {
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: id },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });

        micStreamRef.current = stream;
        await syncMicBroadcast();
      } catch (error) {
        console.error('Error connecting microphone:', error);
      }
    },
    [stopMicMonitoring, syncMicBroadcast],
  );

  const handleStopClickLocally = useCallback(() => {
    activeSoundsRef.current.forEach((audioElement) => {
      audioElement.pause();
      audioElement.currentTime = 0;
    });

    activeSoundsRef.current.clear();
  }, []);

  const playAudioLocally = useCallback(async (filename: string) => {
    const encodedPath = filename.split('/').map(encodeURIComponent).join('/');

    const playOnOutput = async (sinkId?: string) => {
      const audioElement = new Audio(`/sounds/${encodedPath}`);
      const cleanup = () => {
        activeSoundsRef.current.delete(audioElement);
      };

      audioElement.preload = 'auto';
      audioElement.volume = soundVolumeRef.current;
      audioElement.onended = cleanup;
      audioElement.onerror = cleanup;

      const sinkAwareAudioElement = audioElement as AudioElementWithSink;

      if (sinkId) {
        const routedToSink = await routeAudioElementToSink(sinkAwareAudioElement, sinkId);

        if (!routedToSink) {
          cleanup();
          return;
        }
      }

      activeSoundsRef.current.add(audioElement);
      await audioElement.play();
    };

    try {
      const playbackTasks: Promise<void>[] = [];

      if (virtualCableIdRef.current) {
        playbackTasks.push(playOnOutput(virtualCableIdRef.current));
      }

      if (hearOwnSoundsRef.current) {
        playbackTasks.push(playOnOutput());
      }

      if (playbackTasks.length === 0) {
        console.warn('Playback skipped because no active route is available.');
      }

      await Promise.allSettled(playbackTasks);
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  }, [routeAudioElementToSink]);

  const handleStopClick = useCallback(async () => {
    if (isHost) {
      handleStopClickLocally();
      return;
    }

    try {
      await fetch(`http://${window.location.hostname}:8080/play/__STOP_ALL__`);
    } catch (error) {
      console.error('Failed to stop remote audio:', error);
    }
  }, [handleStopClickLocally, isHost]);

  const handleButtonClick = useCallback(
    async (
      filename: string,
      isEditMode: boolean,
      setBindingTarget: (targetFilename: string) => void,
    ) => {
      if (isEditMode) {
        if (isHost) {
          setBindingTarget(filename);
        }

        return;
      }

      if (isHost) {
        await playAudioLocally(filename);
        return;
      }

      try {
        const safePath = filename.split('/').map(encodeURIComponent).join('/');
        await fetch(`http://${window.location.hostname}:8080/play/${safePath}`);
      } catch (error) {
        console.error('Remote playback failed:', error);
      }
    },
    [isHost, playAudioLocally],
  );

  const handleDeleteSound = useCallback(
    async (filename: string) => {
      const response = await fetch('/api/sounds', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });

      if (!response.ok) {
        throw new Error(`Failed to delete sound: ${response.status}`);
      }

      await loadSounds();
    },
    [loadSounds],
  );

  useEffect(() => {
    const checkUpdates = async () => {
      try {
        const response = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        );

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as { tag_name?: string };
        const latestTag = data.tag_name?.replace(/^v/, '');

        if (latestTag && latestTag !== JAWDIO_VERSION) {
          setLatestVersion(latestTag);
          setHasUpdate(true);
        }
      } catch (error) {
        console.error('Update check failed:', error);
      }
    };

    const savedHotkeys = localStorage.getItem('jawdio-hotkeys');
    const savedHearSounds = localStorage.getItem('jawdio-hear-sounds');

    if (savedHearSounds !== null) {
      setHearOwnSoundsState(JSON.parse(savedHearSounds));
    }

    if (savedHotkeys) {
      try {
        setHotkeys(JSON.parse(savedHotkeys) as Record<string, string>);
      } catch (error) {
        console.error('Failed to load saved hotkeys:', error);
      }
    }

    const electronAvailable = typeof window !== 'undefined' && Boolean(window.electronAPI);
    setIsHost(electronAvailable);
    setStatus(electronAvailable ? 'Host Console' : 'Remote Client');

    if (electronAvailable && window.electronAPI) {
      if (savedHotkeys) {
        const parsedHotkeys = JSON.parse(savedHotkeys) as Record<string, string>;
        window.electronAPI.clearHotkeys();
        Object.entries(parsedHotkeys).forEach(([filename, hotkey]) => {
          window.electronAPI?.registerHotkey(hotkey, filename);
        });
      }

      if (!ipcRegisteredRef.current) {
        ipcRegisteredRef.current = true;
        window.electronAPI.onTriggerSound((filename: string) => {
          if (filename === '__STOP_ALL__') {
            handleStopClickLocally();
            return;
          }

          void playAudioLocally(filename);
        });
      }
    }

    void checkUpdates();
    void loadSounds();
    void setupAudioDevices();

    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener?.('devicechange', setupAudioDevices);

    return () => {
      mediaDevices?.removeEventListener?.('devicechange', setupAudioDevices);
      stopMicMonitoring();
      handleStopClickLocally();
    };
  }, [
    handleStopClickLocally,
    loadSounds,
    playAudioLocally,
    setupAudioDevices,
    stopMicMonitoring,
  ]);

  return (
    <AudioContext.Provider
      value={{
        status,
        isHost,
        sounds,
        cableName,
        mics,
        outputs,
        micVolume,
        setMicVolume,
        soundVolume,
        setSoundVolume,
        activeMicId,
        hotkeys,
        setHotkeys,
        loadSounds,
        handleMicChange,
        playAudioLocally,
        handleStopClick,
        handleButtonClick,
        handleDeleteSound,
        hasUpdate,
        latestVersion,
        hearOwnSounds,
        setHearOwnSounds,
      }}
    >
      <audio ref={micBroadcastAudioRef} className="hidden" />
      {children}
    </AudioContext.Provider>
  );
};

export const useAudio = () => {
  const context = useContext(AudioContext);

  if (!context) {
    throw new Error('Audio Context Error');
  }

  return context;
};
