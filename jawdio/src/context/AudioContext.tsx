'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { detectInstalledCables, type DetectedCable } from '@/lib/audio-routing';
import { encodeWav } from '@/lib/audio';
import { buildMediaUrl } from '@/lib/media';
import { GITHUB_REPO, JAWDIO_VERSION } from '@/lib/version';

/**
 * Lazily-built, cached blob URL of a short 880Hz beep used by the Routing
 * page's Test buttons. Cached because rebuilding it every call is wasteful,
 * and using a cached URL means the browser's media stack handles the file
 * the same way it handles any other pad — a path we know plays reliably
 * across Electron versions where AudioContext.setSinkId may be partial.
 */
let cachedTestToneUrl: string | null = null;

const ensureTestToneUrl = async (): Promise<string | null> => {
  if (cachedTestToneUrl) return cachedTestToneUrl;

  try {
    const sampleRate = 48000;
    const durationSec = 0.45;
    const frameCount = Math.floor(sampleRate * durationSec);
    const OfflineCtor =
      (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext })
        .OfflineAudioContext;
    if (!OfflineCtor) return null;

    const offlineCtx = new OfflineCtor(1, frameCount, sampleRate);
    const oscillator = offlineCtx.createOscillator();
    oscillator.frequency.value = 880;
    const gain = offlineCtx.createGain();
    gain.gain.setValueAtTime(0, 0);
    gain.gain.linearRampToValueAtTime(0.4, 0.02);
    gain.gain.setValueAtTime(0.4, durationSec - 0.05);
    gain.gain.linearRampToValueAtTime(0, durationSec);
    oscillator.connect(gain).connect(offlineCtx.destination);
    oscillator.start(0);
    oscillator.stop(durationSec);

    const rendered = await offlineCtx.startRendering();
    const wav = encodeWav(rendered);
    cachedTestToneUrl = URL.createObjectURL(wav);
    return cachedTestToneUrl;
  } catch (error) {
    console.error('Failed to build test tone WAV:', error);
    return null;
  }
};

export interface SoundFile {
  name: string;
  filename: string;
  category: string;
  /** Optional file modification time (ms since epoch) — surfaced as "saved X ago". */
  createdAt?: number;
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
  detectedCables: DetectedCable[];
  applyRecommendedRouting: () => Promise<void>;
  testOutput: (sinkId: string | null) => Promise<boolean>;
  /** Human label that Windows reports as the current default output, if known. */
  defaultOutputLabel: string;
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
  const [detectedCables, setDetectedCables] = useState<DetectedCable[]>([]);
  const [defaultOutputLabel, setDefaultOutputLabel] = useState('');

  const libraryFingerprintRef = useRef('');
  const hearOwnSoundsRef = useRef(hearOwnSounds);
  const soundVolumeRef = useRef(soundVolume);
  const ipcRegisteredRef = useRef(false);
  const micBroadcastAudioRef = useRef<HTMLAudioElement>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const broadcastOutputIdRef = useRef<string | null>(null);
  const previewOutputIdRef = useRef<string | null>(null);
  const virtualCableIdRef = useRef<string | null>(null);
  // Long-lived AudioContext for the routing Test buttons. Created on the first
  // user gesture so Chromium's autoplay gate is satisfied.
  // Set of currently playing pad audio elements so we can stop them all
  // (e.g. Escape key / Stop All button) and update their volume mid-play.
  const activeSoundsRef = useRef<Set<HTMLAudioElement>>(new Set());

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

      // Surface what Windows reports as the system default output. Chromium
      // returns an extra entry with deviceId='default' whose label is prefixed
      // with "Default - " and matches the underlying device. If we can't find
      // it, fall back to an empty string so the UI says "Unknown".
      const defaultEntry = devices.find(
        (device) => device.kind === 'audiooutput' && device.deviceId === 'default',
      );
      const nextDefaultLabel = defaultEntry?.label
        ? defaultEntry.label.replace(/^default\s*[-:]\s*/i, '')
        : '';
      const selectedOutput = findPreferredOutput(audioOutputs, broadcastOutputIdRef.current);
      const nextOutputId = selectedOutput?.deviceId ?? '';

      // Preview output: respect the explicit "use Windows default" sentinel
      // stored in localStorage. Only auto-pick a physical output the very first
      // time the app runs (when localStorage has no saved value at all).
      const savedPreviewRaw = localStorage.getItem('jawdio-preview-output-id');
      let nextPreviewOutputId = '';

      if (savedPreviewRaw === '__default__') {
        // User explicitly picked "Use Windows default".
        nextPreviewOutputId = '';
      } else if (savedPreviewRaw) {
        // User pinned a specific device — try to honor it.
        const existing = audioOutputs.find(
          (device) => device.deviceId === savedPreviewRaw && device.deviceId !== nextOutputId,
        );
        nextPreviewOutputId = existing?.deviceId ?? '';
      } else if (previewOutputIdRef.current) {
        // In-memory choice (set during this session, not yet flushed).
        const existing = audioOutputs.find(
          (device) =>
            device.deviceId === previewOutputIdRef.current && device.deviceId !== nextOutputId,
        );
        nextPreviewOutputId = existing?.deviceId ?? '';
      } else {
        // First-ever run with no saved preference — default to Windows default
        // rather than auto-picking, since "default" is the most reliable choice
        // for users that haven't thought about routing yet.
        nextPreviewOutputId = '';
      }

      setMics(audioInputs);
      setOutputs(audioOutputs);
      setDetectedCables(detectInstalledCables(audioOutputs, audioInputs));
      setDefaultOutputLabel(nextDefaultLabel);
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
      // Empty value OR same device as the broadcast cable both mean "use the
      // Windows default output." We persist a sentinel so the next launch
      // doesn't auto-pick a physical device on top of the user's choice.
      if (!value || value === broadcastOutputIdRef.current) {
        previewOutputIdRef.current = null;
        setPreviewOutputIdState('');
        localStorage.setItem('jawdio-preview-output-id', '__default__');
        return;
      }

      try {
        const permittedOutputId = await requestAudioOutputAccess(value);
        const safeOutputId =
          permittedOutputId === broadcastOutputIdRef.current ? '' : permittedOutputId;

        previewOutputIdRef.current = safeOutputId || null;
        setPreviewOutputIdState(safeOutputId);

        if (safeOutputId) {
          localStorage.setItem('jawdio-preview-output-id', safeOutputId);
        } else {
          localStorage.setItem('jawdio-preview-output-id', '__default__');
        }
      } catch (error) {
        console.error('Failed to authorize preview output device:', error);
      }
    },
    [],
  );

  const applyRecommendedRouting = useCallback(async () => {
    // Re-enumerate so the call works even before setupAudioDevices has finished
    // its first run.
    let devices: MediaDeviceInfo[] = [];

    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (error) {
      console.error('Recommended routing failed during enumeration:', error);
      return;
    }

    const audioOutputs = devices.filter(
      (device) => device.kind === 'audiooutput' && device.deviceId !== 'default',
    );
    const audioInputs = devices.filter(
      (device) => device.kind === 'audioinput' && device.deviceId !== 'default',
    );

    const cables = detectInstalledCables(audioOutputs, audioInputs);
    const soundboardCable = cables.find((cable) => cable.laneId === 'soundboard');

    if (!soundboardCable) {
      // Nothing to apply — the Setup page will tell the user what's missing.
      return;
    }

    // Pick a physical output for local monitoring: any output that isn't a
    // known cable. That way the user actually hears the soundboard locally.
    const knownCableIds = new Set(cables.map((cable) => cable.inputDeviceId));
    const physicalOutput = audioOutputs.find(
      (device) => !knownCableIds.has(device.deviceId),
    );

    await setBroadcastOutputId(soundboardCable.inputDeviceId);

    if (physicalOutput) {
      await setPreviewOutputId(physicalOutput.deviceId);
    }

    setHearOwnSounds(true);
  }, [setBroadcastOutputId, setHearOwnSounds, setPreviewOutputId]);

  /**
   * Plays a brief 880Hz tone on the given output device using Web Audio. A
   * Plays the same path the soundboard's pads use — HTMLAudioElement plus
   * setSinkId — so the tone tracks the user's "Trim Preview Output" choice
   * even in Electron builds where AudioContext.setSinkId is unreliable. If
   * setSinkId for the chosen device fails (stale id, permission, OS hiccup),
   * we still call play() so the audio lands on the OS default rather than
   * being silently dropped.
   *
   * Pass `null` to play on the OS default. Returns true if play() resolved.
   */
  const testOutput = useCallback(async (sinkId: string | null): Promise<boolean> => {
    const url = await ensureTestToneUrl();
    if (!url) return false;

    const audio = new Audio(url);
    audio.volume = 0.55;

    if (sinkId) {
      const routed = await routeAudioElementToSink(audio as AudioElementWithSink, sinkId);
      if (!routed) {
        // Fall through to default — better to hear it on speakers than not
        // at all. The Settings page surfaces this via the diagnostic line.
        console.warn(`Test setSinkId(${sinkId}) failed; falling back to default.`);
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        resolve(ok);
      };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.play().catch((error) => {
        console.error('Test audio play() failed:', error);
        finish(false);
      });
    });
  }, [routeAudioElementToSink]);

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

  const playAudioLocally = useCallback(
    async (filename: string) => {
      /**
       * One copy of the pad per active route. Both paths use HTMLAudioElement
       * because that's what reliably plays compressed audio (MP3/WAV/OGG/M4A)
       * across Electron's Chromium versions. The Web Audio path proved flaky
       * on some Windows setups.
       *
       * `strict` means we won't fall back to the OS default if setSinkId
       * fails — used for the broadcast cable so audio doesn't leak to the
       * user's local speakers outside their OBS chain.
       */
      const playOnOutput = async (
        sinkId: string | undefined,
        strict: boolean,
        label: string,
      ) => {
        const audioElement = new Audio(buildMediaUrl('sounds', filename));
        const cleanup = () => {
          activeSoundsRef.current.delete(audioElement);
        };

        audioElement.preload = 'auto';
        audioElement.volume = soundVolumeRef.current;
        audioElement.onended = cleanup;
        audioElement.onerror = cleanup;

        const sinkAware = audioElement as AudioElementWithSink;

        if (sinkId) {
          const routed = await routeAudioElementToSink(sinkAware, sinkId);

          if (!routed) {
            console.warn(`[${label}] setSinkId failed for ${filename}.`);

            if (strict) {
              cleanup();
              return;
            }
            // Lenient: continue and play on the OS default device.
          }
        }

        activeSoundsRef.current.add(audioElement);

        try {
          await audioElement.play();
        } catch (error) {
          console.error(`[${label}] play() failed for ${filename}:`, error);
          cleanup();
        }
      };

      const tasks: Promise<void>[] = [];

      if (virtualCableIdRef.current) {
        tasks.push(playOnOutput(virtualCableIdRef.current, true, 'broadcast'));
      }

      if (hearOwnSoundsRef.current) {
        const previewSinkId =
          previewOutputIdRef.current && previewOutputIdRef.current !== virtualCableIdRef.current
            ? previewOutputIdRef.current
            : undefined;
        tasks.push(playOnOutput(previewSinkId, false, 'preview'));
      }

      if (tasks.length === 0) {
        console.warn('Playback skipped because no active route is available.');
        return;
      }

      await Promise.allSettled(tasks);
    },
    [routeAudioElementToSink],
  );

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

    if (savedPreviewOutputId === '__default__') {
      // Explicit "use Windows default" — leave the ref null so playback skips
      // setSinkId and inherits whatever Windows is routing audio to.
      previewOutputIdRef.current = null;
      setPreviewOutputIdState('');
    } else if (savedPreviewOutputId) {
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
        detectedCables,
        applyRecommendedRouting,
        testOutput,
        defaultOutputLabel,
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
