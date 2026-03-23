'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { buildMediaUrl } from '@/lib/media';
import { GITHUB_REPO, JAWDIO_VERSION } from '@/lib/version';

export interface SoundFile {
  name: string;
  filename: string;
  category: string;
}

export type SoundLibraryState = Record<string, SoundFile[]>;

interface AudioContextType {
  status: string;
  isHost: boolean;
  sounds: SoundFile[];
  soundLibrary: SoundLibraryState;
  cableName: string;
  mics: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  broadcastOutputId: string;
  setBroadcastOutputId: (value: string) => Promise<void>;
  previewOutputId: string;
  setPreviewOutputId: (value: string) => Promise<void>;
  micVolume: number;
  setMicVolume: (value: number) => void;
  soundVolume: number;
  setSoundVolume: (value: number) => void;
  activeMicId: string;
  hotkeys: Record<string, string>;
  setHotkeys: (hotkeys: Record<string, string>) => void;
  loadSounds: () => Promise<void>;
  refreshSoundLibrary: () => Promise<void>;
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

type MediaDevicesWithAudioOutputSelection = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};

const OUTPUT_MATCH_HINTS = [
  'voicemeeter aux input',
  'voicemeeter input',
  'cable input',
  'vb-audio',
];

const isVirtualOutput = (device: MediaDeviceInfo) =>
  OUTPUT_MATCH_HINTS.some((hint) => device.label.toLowerCase().includes(hint));

const requestAudioOutputAccess = async (deviceId: string) => {
  if (!deviceId) {
    return '';
  }

  const mediaDevices = navigator.mediaDevices as MediaDevicesWithAudioOutputSelection;

  if (typeof mediaDevices.selectAudioOutput !== 'function') {
    return deviceId;
  }

  try {
    const selectedDevice = await mediaDevices.selectAudioOutput({ deviceId });
    return selectedDevice.deviceId;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      const selectedDevice = await mediaDevices.selectAudioOutput();
      return selectedDevice.deviceId;
    }

    throw error;
  }
};

const findPreferredOutput = (
  audioOutputs: MediaDeviceInfo[],
  preferredId: string | null,
) => {
  if (preferredId) {
    const selectedOutput = audioOutputs.find((device) => device.deviceId === preferredId);

    if (selectedOutput) {
      return selectedOutput;
    }
  }

  for (const hint of OUTPUT_MATCH_HINTS) {
    const matchedOutput = audioOutputs.find((device) =>
      device.label.toLowerCase().includes(hint),
    );

    if (matchedOutput) {
      return matchedOutput;
    }
  }

  return null;
};

const findPreviewOutput = (
  audioOutputs: MediaDeviceInfo[],
  preferredId: string | null,
  broadcastOutputId: string | null,
) => {
  if (preferredId && preferredId !== broadcastOutputId) {
    const selectedOutput = audioOutputs.find((device) => device.deviceId === preferredId);

    if (selectedOutput) {
      return selectedOutput;
    }
  }

  const physicalOutput = audioOutputs.find(
    (device) => device.deviceId !== broadcastOutputId && !isVirtualOutput(device),
  );

  if (physicalOutput) {
    return physicalOutput;
  }

  return (
    audioOutputs.find((device) => device.deviceId !== broadcastOutputId) ?? null
  );
};

const AudioContext = createContext<AudioContextType | null>(null);

export const AudioProvider = ({ children }: { children: React.ReactNode }) => {
  const [status, setStatus] = useState('Standby');
  const [isHost, setIsHost] = useState(false);
  const [sounds, setSounds] = useState<SoundFile[]>([]);
  const [soundLibrary, setSoundLibrary] = useState<SoundLibraryState>({});
  const [cableName, setCableName] = useState('Unavailable');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [broadcastOutputId, setBroadcastOutputIdState] = useState('');
  const [previewOutputId, setPreviewOutputIdState] = useState('');
  const [micVolume, setMicVolume] = useState(1);
  const [soundVolume, setSoundVolume] = useState(0.9);
  const [activeMicId, setActiveMicId] = useState('none');
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({});
  const [hasUpdate, setHasUpdate] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');
  const [hearOwnSounds, setHearOwnSoundsState] = useState(false);

  const activeSoundsRef = useRef<Set<HTMLAudioElement>>(new Set());
  const libraryFingerprintRef = useRef('');
  const hearOwnSoundsRef = useRef(hearOwnSounds);
  const soundVolumeRef = useRef(soundVolume);
  const ipcRegisteredRef = useRef(false);
  const micBroadcastAudioRef = useRef<HTMLAudioElement>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const broadcastOutputIdRef = useRef<string | null>(null);
  const previewOutputIdRef = useRef<string | null>(null);
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

  const applySoundLibrary = useCallback((library: SoundLibraryState) => {
    libraryFingerprintRef.current = JSON.stringify(library);
    setSoundLibrary(library);
    setSounds(Object.values(library).flat());
  }, []);

  const refreshSoundLibrary = useCallback(async () => {
    try {
      const response = await fetch(`/api/sounds?t=${Date.now()}`);

      if (!response.ok) {
        throw new Error(`Failed to load sounds: ${response.status}`);
      }

      const data = (await response.json()) as { library: SoundLibraryState };
      const nextFingerprint = JSON.stringify(data.library);

      if (nextFingerprint === libraryFingerprintRef.current) {
        return;
      }

      applySoundLibrary(data.library);
    } catch (error) {
      console.error('Failed to load sounds:', error);
    }
  }, [applySoundLibrary]);

  const loadSounds = refreshSoundLibrary;

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
      const selectedOutput = findPreferredOutput(audioOutputs, broadcastOutputIdRef.current);
      const nextOutputId = selectedOutput?.deviceId ?? '';
      const selectedPreviewOutput = findPreviewOutput(
        audioOutputs,
        previewOutputIdRef.current,
        nextOutputId || null,
      );
      const nextPreviewOutputId = selectedPreviewOutput?.deviceId ?? '';

      setMics(audioInputs);
      setOutputs(audioOutputs);
      setCableName(selectedOutput?.label ?? 'Select a broadcast output');
      setBroadcastOutputIdState(nextOutputId);
      setPreviewOutputIdState(nextPreviewOutputId);
      broadcastOutputIdRef.current = nextOutputId || null;
      previewOutputIdRef.current = nextPreviewOutputId || null;
      virtualCableIdRef.current = selectedOutput?.deviceId ?? null;

      if (nextOutputId) {
        localStorage.setItem('jawdio-output-id', nextOutputId);
      } else {
        localStorage.removeItem('jawdio-output-id');
      }

      if (nextPreviewOutputId) {
        localStorage.setItem('jawdio-preview-output-id', nextPreviewOutputId);
      } else {
        localStorage.removeItem('jawdio-preview-output-id');
      }

      if (micStreamRef.current) {
        await syncMicBroadcast();
      }
    } catch (error) {
      console.error('Audio device scan failed:', error);
    }
  }, [syncMicBroadcast]);

  const setBroadcastOutputId = useCallback(
    async (value: string) => {
      if (!value) {
        broadcastOutputIdRef.current = null;
        localStorage.removeItem('jawdio-output-id');
        await setupAudioDevices();
        return;
      }

      try {
        const permittedOutputId = await requestAudioOutputAccess(value);
        broadcastOutputIdRef.current = permittedOutputId;
        localStorage.setItem('jawdio-output-id', permittedOutputId);
        await setupAudioDevices();
      } catch (error) {
        console.error('Failed to authorize broadcast output device:', error);
      }
    },
    [setupAudioDevices],
  );

  const setPreviewOutputId = useCallback(
    async (value: string) => {
      if (!value || value === broadcastOutputIdRef.current) {
        previewOutputIdRef.current = null;
        localStorage.removeItem('jawdio-preview-output-id');
        await setupAudioDevices();
        return;
      }

      try {
        const permittedOutputId = await requestAudioOutputAccess(value);
        const safeOutputId =
          permittedOutputId === broadcastOutputIdRef.current ? '' : permittedOutputId;

        previewOutputIdRef.current = safeOutputId || null;

        if (safeOutputId) {
          localStorage.setItem('jawdio-preview-output-id', safeOutputId);
        } else {
          localStorage.removeItem('jawdio-preview-output-id');
        }

        await setupAudioDevices();
      } catch (error) {
        console.error('Failed to authorize preview output device:', error);
      }
    },
    [setupAudioDevices],
  );

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
    const playOnOutput = async (sinkId?: string) => {
      const audioElement = new Audio(buildMediaUrl('sounds', filename));
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

      await refreshSoundLibrary();
    },
    [refreshSoundLibrary],
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
    const savedOutputId = localStorage.getItem('jawdio-output-id');
    const savedPreviewOutputId = localStorage.getItem('jawdio-preview-output-id');

    if (savedHearSounds !== null) {
      setHearOwnSoundsState(JSON.parse(savedHearSounds));
    }

    if (savedOutputId) {
      broadcastOutputIdRef.current = savedOutputId;
      setBroadcastOutputIdState(savedOutputId);
    }

    if (savedPreviewOutputId) {
      previewOutputIdRef.current = savedPreviewOutputId;
      setPreviewOutputIdState(savedPreviewOutputId);
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
    void refreshSoundLibrary();
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
    refreshSoundLibrary,
    playAudioLocally,
    setupAudioDevices,
    stopMicMonitoring,
  ]);

  useEffect(() => {
    const refreshVisibleLibrary = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }

      void refreshSoundLibrary();
    };

    const refreshTimer = window.setInterval(refreshVisibleLibrary, 2500);

    window.addEventListener('focus', refreshVisibleLibrary);
    document.addEventListener('visibilitychange', refreshVisibleLibrary);

    return () => {
      window.clearInterval(refreshTimer);
      window.removeEventListener('focus', refreshVisibleLibrary);
      document.removeEventListener('visibilitychange', refreshVisibleLibrary);
    };
  }, [refreshSoundLibrary]);

  return (
    <AudioContext.Provider
      value={{
        status,
        isHost,
        sounds,
        soundLibrary,
        cableName,
        mics,
        outputs,
        broadcastOutputId,
        setBroadcastOutputId,
        previewOutputId,
        setPreviewOutputId,
        micVolume,
        setMicVolume,
        soundVolume,
        setSoundVolume,
        activeMicId,
        hotkeys,
        setHotkeys,
        loadSounds,
        refreshSoundLibrary,
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
