'use client';

import {
  AlertTriangle,
  CircleDot,
  Cpu,
  KeyRound,
  Mic,
  Pause,
  Play,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Volume2,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useAudio } from '@/context/AudioContext';
import { createAudioContext, encodeWav } from '@/lib/audio';
import { buildMediaUrl } from '@/lib/media';

/**
 * AutoClipper — runs an always-listening mic engine with a rolling buffer and
 * fires "clip worthy" detection on two parallel signals:
 *
 *   1. Acoustic: average volume over the last N seconds crosses a low
 *      threshold. Lightweight; runs entirely client-side using the existing
 *      AnalyserNode.
 *
 *   2. Semantic (optional): periodically sends the rolling transcript window
 *      to an LLM with a "should this be clipped and where?" prompt. Only
 *      fires when the user has supplied an OpenAI key.
 *
 * When either trigger fires we pull the matching audio from the in-memory
 * ring buffer, trim around Deepgram word timestamps when available, then POST
 * the final WAV to /api/upload so the soundboard library picks it up.
 *
 * Independent of ClipWorkbench's engine — opens its own getUserMedia stream
 * and its own Deepgram socket so the two pages don't fight over the mic.
 */

interface AudioChunk {
  blob: Blob;
  /** Engine-elapsed seconds at which this chunk was committed. */
  capturedAt: number;
}

interface VolumeSample {
  level: number;
  capturedAt: number;
}

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

interface RecentClip {
  id: string;
  title: string;
  filename: string;
  /** Path-qualified filename inside the soundboard library (e.g. "Drops/foo.wav"). */
  fullFilename: string;
  savedAt: number;
  durationSec: number;
  source: 'acoustic' | 'semantic' | 'manual';
  transcript: string;
}

/**
 * Trigger fired but the clip hasn't been committed yet — held in memory so
 * the user can preview / rename / save / discard before it lands on disk.
 */
interface PendingClip {
  id: string;
  title: string;
  durationSec: number;
  source: RecentClip['source'];
  transcript: string;
  category: string;
  blob: Blob;
  createdAt: number;
}

const BUFFER_SECONDS = 30;
const RECORDER_TIMESLICE_MS = 250;
const VOLUME_SAMPLE_INTERVAL_MS = 100;
const DETECTION_TICK_MS = 250;
const TRANSCRIPT_SAMPLE_RATE = 16000;

const DEFAULT_VOLUME_THRESHOLD = 15;
const LEGACY_DEFAULT_VOLUME_THRESHOLD = 70;
const MIN_VOLUME_THRESHOLD = 5;
const MAX_VOLUME_THRESHOLD = 120;
const DEFAULT_SUSTAIN_SECONDS = 0.6;
const DEFAULT_COOLDOWN_SECONDS = 10;
const DEFAULT_CLIP_DURATION_SECONDS = 6;
const SEMANTIC_INTERVAL_SECONDS = 12;
const SEMANTIC_WINDOW_SECONDS = 20;
// Smart-cut tuning. The silence threshold is a fraction of the user's
// volume threshold so it adapts when they tweak the trigger. The silence
// hold time is user-controlled via the "Sentence sensitivity" slider.
// Lead/tail padding gives the clip a tiny bit of headroom on each side so
// words aren't shaved at the consonants.
const SILENCE_THRESHOLD_RATIO = 0.55;
const DEFAULT_SILENCE_HOLD_SECONDS = 0.45;
const LEAD_PADDING_SECONDS = 0.15;
const TAIL_PADDING_SECONDS = 0.3;
const MIN_CLIP_SECONDS = 0.6;
const SHORT_LEVEL_WINDOW_SECONDS = 0.25;
const PUBLIC_DEEPGRAM_API_KEY =
  process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY?.trim() ?? '';

const formatRelative = (ms: number, now: number) => {
  const delta = Math.max(0, now - ms);
  const seconds = Math.round(delta / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
};

const sanitizeFilename = (value: string) =>
  value
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'auto_clip';

const TITLE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'but',
  'for',
  'from',
  'got',
  'had',
  'has',
  'have',
  'her',
  'him',
  'his',
  'how',
  'just',
  'like',
  'not',
  'our',
  'out',
  'she',
  'that',
  'the',
  'then',
  'they',
  'this',
  'was',
  'were',
  'what',
  'when',
  'with',
  'you',
  'your',
]);

const titleCaseWord = (word: string) =>
  word.length <= 2
    ? word.toUpperCase()
    : `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;

const buildFallbackClipTitle = (transcript: string) => {
  const words = transcript
    .replace(/'/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const meaningfulWords = words.filter(
    (word) => !TITLE_STOP_WORDS.has(word.toLowerCase()) && word.length > 2,
  );
  const titleWords = (meaningfulWords.length >= 2 ? meaningfulWords : words).slice(0, 3);

  return titleWords.map(titleCaseWord).join(' ');
};

const convertAudioBufferToLinear16 = (
  buffer: AudioBuffer,
  targetSampleRate: number,
): ArrayBuffer => {
  const sourceSamples = buffer.getChannelData(0);
  const ratio = buffer.sampleRate / targetSampleRate;
  const outputLength = Math.floor(sourceSamples.length / ratio);
  const output = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = Math.floor(index * ratio);
    const sample = Math.max(-1, Math.min(1, sourceSamples[sourceIndex] ?? 0));
    output[index] = sample < 0 ? sample * 32768 : sample * 32767;
  }

  return output.buffer;
};

interface DeepgramMessage {
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      words?: Array<{ word: string; punctuated_word?: string; start: number; end: number }>;
    }>;
  };
}

interface AutoClipperAiRequest {
  mode: 'title' | 'semantic';
  transcript: string;
  openAiKey?: string;
  clipDurationSeconds?: number;
}

interface AutoClipperAiResponse {
  title?: string;
  clipWorthy?: boolean;
  startOffsetSec?: number;
  endOffsetSec?: number;
  error?: string;
}

interface AutoClipperAiConfigResponse {
  configured?: boolean;
}

const requestAutoClipperAi = async (
  payload: AutoClipperAiRequest,
): Promise<AutoClipperAiResponse> => {
  const response = await fetch('/api/auto-clipper/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      openAiKey: payload.openAiKey?.trim() || undefined,
    }),
  });
  const json = (await response.json().catch(() => null)) as
    | AutoClipperAiResponse
    | null;

  if (!response.ok) {
    throw new Error(json?.error ?? `AI request failed (${response.status}).`);
  }

  return json ?? {};
};

export default function AutoClipper() {
  const {
    isHost,
    loadSounds,
    mics,
    outputs,
    previewOutputId,
    soundLibrary,
    defaultOutputLabel,
    testOutput,
  } = useAudio();

  // Resolve the label of whichever device a preview *would* play on right
  // now, so the user can see at a glance where audio is being sent.
  const previewDeviceLabel = useMemo(() => {
    if (!previewOutputId) {
      return defaultOutputLabel
        ? `Windows default → ${defaultOutputLabel}`
        : 'Windows default';
    }
    const match = outputs.find((output) => output.deviceId === previewOutputId);
    return match?.label ?? 'Unknown device';
  }, [defaultOutputLabel, outputs, previewOutputId]);

  const [previewRouteStatus, setPreviewRouteStatus] = useState<string>('');

  // --- Mutable engine refs -------------------------------------------------
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const transcriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptSilenceRef = useRef<GainNode | null>(null);
  const transcriptSocketRef = useRef<WebSocket | null>(null);

  const headerChunkRef = useRef<Blob | null>(null);
  const chunksRef = useRef<AudioChunk[]>([]);
  const volumeHistoryRef = useRef<VolumeSample[]>([]);
  const transcriptWordsRef = useRef<TranscriptWord[]>([]);
  const engineStartedAtRef = useRef<number | null>(null);
  const transcriptOffsetRef = useRef<number>(0);
  const triggerCooldownUntilRef = useRef<number>(0);
  const lastSemanticCheckRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);
  const detectionIntervalRef = useRef<number | null>(null);

  // --- React state --------------------------------------------------------
  const [isEngineRunning, setIsEngineRunning] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>(
    'Idle. Start the engine to begin monitoring.',
  );
  const [transcriptStatus, setTranscriptStatus] = useState<
    'disabled' | 'connecting' | 'live' | 'unavailable'
  >('disabled');
  const [currentVolume, setCurrentVolume] = useState(0);
  const [recentClips, setRecentClips] = useState<RecentClip[]>([]);
  const [pendingClips, setPendingClips] = useState<PendingClip[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selectedMicId, setSelectedMicId] = useState('none');
  // Counts up forever per engine session so fallback names are unique and
  // legible ("Loud moment 3" instead of timestamp gibberish).
  const triggerCountRef = useRef(0);
  // Smart-cut state machine. While `phase === 'capturing'`, the engine keeps
  // monitoring volume after the trigger crossed the threshold; it only
  // finalizes the clip when audio has been quiet for `SILENCE_HOLD_SECONDS`
  // or the max clip duration has elapsed. That makes cuts land on word
  // boundaries instead of mid-syllable.
  const captureStateRef = useRef<
    | { phase: 'idle' }
    | { phase: 'capturing'; startedAt: number; lastLoudAt: number }
  >({ phase: 'idle' });
  // Audio element + blob URL used for one-at-a-time clip previewing.
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewBlobUrlRef = useRef<string | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);

  // Manual trim editor — set when the user taps Trim on a pending clip.
  // Holds the decoded AudioBuffer + downsampled peaks for the waveform plus
  // the in-progress selection range in buffer seconds.
  interface TrimSession {
    pendingId: string;
    duration: number;
    sampleRate: number;
    channelCount: number;
    channelData: Float32Array[];
    peaks: number[]; // flat [min, max, min, max, ...]
    bucketCount: number;
    selectionStart: number;
    selectionEnd: number;
    title: string;
    category: string;
    transcript: string;
    durationSec: number;
    source: PendingClip['source'];
  }
  const [trimSession, setTrimSession] = useState<TrimSession | null>(null);
  const [trimPreviewing, setTrimPreviewing] = useState(false);
  const trimCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const trimPointerAnchorRef = useRef<number | null>(null);
  const trimDragModeRef = useRef<
    | { kind: 'paint'; anchorSec: number }
    | { kind: 'resize-start'; otherEdge: number }
    | { kind: 'resize-end'; otherEdge: number }
    | { kind: 'move'; offsetStart: number; offsetEnd: number }
    | null
  >(null);
  const trimAudioRef = useRef<HTMLAudioElement | null>(null);
  const trimBlobUrlRef = useRef<string | null>(null);

  // Detection settings
  const [volumeThreshold, setVolumeThreshold] = useState(DEFAULT_VOLUME_THRESHOLD);
  const [sustainSeconds, setSustainSeconds] = useState(DEFAULT_SUSTAIN_SECONDS);
  const [cooldownSeconds, setCooldownSeconds] = useState(DEFAULT_COOLDOWN_SECONDS);
  const [clipDurationSeconds, setClipDurationSeconds] = useState(
    DEFAULT_CLIP_DURATION_SECONDS,
  );
  const [silenceHoldSeconds, setSilenceHoldSeconds] = useState(
    DEFAULT_SILENCE_HOLD_SECONDS,
  );
  const [acousticEnabled, setAcousticEnabled] = useState(true);
  const [semanticEnabled, setSemanticEnabled] = useState(false);
  const [llmNamingEnabled, setLlmNamingEnabled] = useState(false);
  // Off by default — every trigger drops the clip into a Pending list for the
  // user to preview / rename / discard. Flip on for hands-free streaming.
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [openAiKey, setOpenAiKey] = useState('');
  const [hasServerOpenAiKey, setHasServerOpenAiKey] = useState(false);
  const [deepgramKey, setDeepgramKey] = useState('');
  const [clipCategory, setClipCategory] = useState('Uncategorized');

  // Refs that mirror state so the detection loop can read current values
  // without re-binding on every render.
  const settingsRef = useRef({
    volumeThreshold,
    sustainSeconds,
    cooldownSeconds,
    clipDurationSeconds,
    silenceHoldSeconds,
    acousticEnabled,
    semanticEnabled,
    llmNamingEnabled,
    autoSaveEnabled,
    openAiKey,
    hasServerOpenAiKey,
    clipCategory,
  });

  useEffect(() => {
    settingsRef.current = {
      volumeThreshold,
      sustainSeconds,
      cooldownSeconds,
      clipDurationSeconds,
      silenceHoldSeconds,
      acousticEnabled,
      semanticEnabled,
      llmNamingEnabled,
      autoSaveEnabled,
      openAiKey,
      hasServerOpenAiKey,
      clipCategory,
    };
  }, [
    acousticEnabled,
    autoSaveEnabled,
    clipCategory,
    clipDurationSeconds,
    cooldownSeconds,
    hasServerOpenAiKey,
    llmNamingEnabled,
    openAiKey,
    semanticEnabled,
    silenceHoldSeconds,
    sustainSeconds,
    volumeThreshold,
  ]);

  // --- Settings persistence ----------------------------------------------
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('auto-clipper-settings');
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<typeof settingsRef.current>;
        if (typeof parsed.volumeThreshold === 'number') {
          const restoredThreshold =
            parsed.volumeThreshold === LEGACY_DEFAULT_VOLUME_THRESHOLD
              ? DEFAULT_VOLUME_THRESHOLD
              : parsed.volumeThreshold;
          setVolumeThreshold(
            Math.min(
              MAX_VOLUME_THRESHOLD,
              Math.max(MIN_VOLUME_THRESHOLD, restoredThreshold),
            ),
          );
        }
        if (typeof parsed.sustainSeconds === 'number') setSustainSeconds(parsed.sustainSeconds);
        if (typeof parsed.cooldownSeconds === 'number') setCooldownSeconds(parsed.cooldownSeconds);
        if (typeof parsed.clipDurationSeconds === 'number')
          setClipDurationSeconds(parsed.clipDurationSeconds);
        if (typeof parsed.silenceHoldSeconds === 'number')
          setSilenceHoldSeconds(parsed.silenceHoldSeconds);
        if (typeof parsed.acousticEnabled === 'boolean') setAcousticEnabled(parsed.acousticEnabled);
        if (typeof parsed.semanticEnabled === 'boolean') setSemanticEnabled(parsed.semanticEnabled);
        if (typeof parsed.llmNamingEnabled === 'boolean')
          setLlmNamingEnabled(parsed.llmNamingEnabled);
        if (typeof parsed.autoSaveEnabled === 'boolean')
          setAutoSaveEnabled(parsed.autoSaveEnabled);
        if (typeof parsed.clipCategory === 'string') setClipCategory(parsed.clipCategory);
      }

      const storedOpenAi = window.localStorage.getItem('openai-key') ?? '';
      setOpenAiKey(storedOpenAi);
      const storedDeepgram = window.localStorage.getItem('deepgram-key') ?? '';
      setDeepgramKey(storedDeepgram || PUBLIC_DEEPGRAM_API_KEY);
    } catch (error) {
      console.warn('AutoClipper failed to restore settings:', error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadOpenAiConfig = async () => {
      try {
        const response = await fetch('/api/auto-clipper/ai');
        if (!response.ok) return;
        const json = (await response.json()) as AutoClipperAiConfigResponse;
        if (!cancelled) setHasServerOpenAiKey(Boolean(json.configured));
      } catch (error) {
        console.warn('AutoClipper could not read OpenAI config:', error);
      }
    };

    void loadOpenAiConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        'auto-clipper-settings',
        JSON.stringify({
          volumeThreshold,
          sustainSeconds,
          cooldownSeconds,
          clipDurationSeconds,
          silenceHoldSeconds,
          acousticEnabled,
          semanticEnabled,
          llmNamingEnabled,
          autoSaveEnabled,
          clipCategory,
        }),
      );
    } catch {}
  }, [
    acousticEnabled,
    autoSaveEnabled,
    clipCategory,
    clipDurationSeconds,
    cooldownSeconds,
    llmNamingEnabled,
    semanticEnabled,
    silenceHoldSeconds,
    sustainSeconds,
    volumeThreshold,
  ]);

  // Keep the relative-time labels under recent clips fresh.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const categoryOptions = useMemo(() => {
    const keys = Object.keys(soundLibrary);
    const ordered = keys.includes('Uncategorized') ? keys : ['Uncategorized', ...keys];
    ordered.sort((a, b) =>
      a === 'Uncategorized' ? -1 : b === 'Uncategorized' ? 1 : a.localeCompare(b),
    );
    return ordered;
  }, [soundLibrary]);

  // --- Helpers ------------------------------------------------------------

  /**
   * Stitch the rolling chunks that overlap with [startSec, endSec] into a
   * single decoded WAV. We always include the WebM header chunk first; the
   * MediaRecorder format depends on it being present at the front for the
   * decoder to read the stream.
   */
  const renderClipRange = useCallback(
    async (
      startElapsedSec: number,
      endElapsedSec: number,
    ): Promise<Blob | null> => {
      const header = headerChunkRef.current;
      if (!header) return null;

      // MediaRecorder needs the original first chunk (the header) to decode
      // anything that follows. We always include the whole rolling buffer
      // because WebM chunks past the first aren't independently seekable —
      // trying to splice from a midpoint produces garbage. Decode the whole
      // thing, then slice the resulting AudioBuffer.
      const allChunks = chunksRef.current;
      if (allChunks.length === 0) return null;

      const combined = new Blob(
        [header, ...allChunks.map((chunk) => chunk.blob)],
        { type: 'audio/webm' },
      );

      const audioContext = createAudioContext();
      try {
        const arrayBuffer = await combined.arrayBuffer();
        const decoded = await audioContext.decodeAudioData(arrayBuffer);

        // The decoded buffer ends at the wall-clock time of the most-recent
        // chunk; the start corresponds to that minus the buffer's own
        // duration. Map engine-elapsed seconds onto buffer-relative seconds
        // using this anchor.
        const lastCapturedAt = allChunks[allChunks.length - 1].capturedAt;
        const bufferEnd = lastCapturedAt;
        const bufferStart = Math.max(0, bufferEnd - decoded.duration);

        const sliceStartSec = Math.max(0, startElapsedSec - bufferStart);
        const sliceEndSec = Math.min(
          decoded.duration,
          Math.max(sliceStartSec + 0.05, endElapsedSec - bufferStart),
        );

        if (sliceEndSec - sliceStartSec < 0.05) {
          console.warn('Clip range fell outside the decoded buffer', {
            startElapsedSec,
            endElapsedSec,
            bufferStart,
            bufferEnd,
            decodedDuration: decoded.duration,
          });
          return null;
        }

        // Manually slice the AudioBuffer rather than going through
        // sliceAndExportAudio (which would re-decode our re-encoded WAV). This
        // keeps quality stable and the resulting WAV is exactly the right
        // number of samples — no padding, no truncation.
        const sampleRate = decoded.sampleRate;
        const startSample = Math.floor(sliceStartSec * sampleRate);
        const endSample = Math.min(
          decoded.length,
          Math.floor(sliceEndSec * sampleRate),
        );
        const frameCount = Math.max(1, endSample - startSample);

        const channelCount = decoded.numberOfChannels;
        const sliceBuffer = audioContext.createBuffer(
          channelCount,
          frameCount,
          sampleRate,
        );

        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
          const source = decoded.getChannelData(channelIndex);
          const destination = sliceBuffer.getChannelData(channelIndex);
          for (let i = 0; i < frameCount; i += 1) {
            destination[i] = source[startSample + i] ?? 0;
          }
        }

        return encodeWav(sliceBuffer);
      } catch (error) {
        console.error('Failed to render clip range:', error);
        return null;
      } finally {
        if (audioContext.state !== 'closed') {
          await audioContext.close().catch(() => undefined);
        }
      }
    },
    [],
  );

  /**
   * Build a 2-3 word title using either an LLM call (if enabled and a key is
   * present) or a heuristic that grabs the most prominent words from the
   * provided transcript snippet.
   */
  const generateClipTitle = useCallback(
    async (transcript: string): Promise<string> => {
      const trimmed = transcript.trim();
      const settings = settingsRef.current;
      const hasOpenAiKey =
        settings.openAiKey.trim().length > 0 || settings.hasServerOpenAiKey;

      if (settings.llmNamingEnabled && hasOpenAiKey && trimmed) {
        try {
          const json = await requestAutoClipperAi({
            mode: 'title',
            transcript: trimmed,
            openAiKey: settings.openAiKey,
          });

          if (json.title) {
            return json.title;
          }
        } catch (error) {
          console.warn('LLM naming failed, falling back to transcript words:', error);
        }
      }

      if (trimmed) {
        const fallbackTitle = buildFallbackClipTitle(trimmed);
        if (fallbackTitle) return fallbackTitle;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
      return `Auto clip ${stamp}`;
    },
    [],
  );

  /**
   * Upload an already-rendered WAV to the soundboard library, return the
   * full path-qualified filename so previews can play it back.
   */
  const uploadClipBlob = useCallback(
    async (blob: Blob, title: string, category: string): Promise<string | null> => {
      const safe = sanitizeFilename(title);
      const filename = `${safe}_${Date.now()}.wav`;
      const file = new File([blob], filename, { type: 'audio/wav' });
      const formData = new FormData();
      formData.append('file', file);
      formData.append('category', category || 'Uncategorized');

      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!response.ok) {
        const err = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? 'Upload failed.');
      }

      const fullFilename =
        category && category !== 'Uncategorized' ? `${category}/${filename}` : filename;
      await loadSounds();
      return fullFilename;
    },
    [loadSounds],
  );

  /**
   * Triggered when either acoustic or semantic detection fires. Renders the
   * slice from the rolling buffer, asks for a name (LLM or fallback), then
   * either uploads it immediately (autoSave mode) or stores it in the
   * pending-review list with the WAV blob held in memory.
   */
  const extractAndSaveClip = useCallback(
    async (
      startElapsedSec: number,
      endElapsedSec: number,
      source: RecentClip['source'],
    ) => {
      const settings = settingsRef.current;
      // Arm cooldown immediately so detection loops don't double-fire while
      // the async work is in flight.
      triggerCooldownUntilRef.current =
        performance.now() + settings.cooldownSeconds * 1000;
      triggerCountRef.current += 1;
      const triggerNumber = triggerCountRef.current;

      const wordsInRequestedRange = transcriptWordsRef.current.filter(
        (word) => word.end >= startElapsedSec && word.start <= endElapsedSec,
      );
      let clipStartSec = startElapsedSec;
      let clipEndSec = endElapsedSec;

      if (wordsInRequestedRange.length > 0) {
        const firstWord = wordsInRequestedRange[0];
        const lastWord = wordsInRequestedRange[wordsInRequestedRange.length - 1];
        const candidateStart = Math.max(0, firstWord.start - 0.25);
        const candidateEnd = Math.min(endElapsedSec, lastWord.end + 0.35);

        if (candidateEnd - candidateStart >= 0.5) {
          clipStartSec = candidateStart;
          clipEndSec = candidateEnd;
        }
      }

      const trimmedSec = Math.max(0.5, clipEndSec - clipStartSec);

      // Widen the transcript lookup by ±1s so words that ended just before
      // the trigger or that Deepgram returned slightly late still count.
      const lookupStart = clipStartSec - 1;
      const lookupEnd = clipEndSec + 1;
      let transcriptInRange = transcriptWordsRef.current
        .filter((word) => word.end >= lookupStart && word.start <= lookupEnd)
        .map((word) => word.word)
        .join(' ');

      // If still empty, salvage the most-recent words from the transcript so
      // the LLM has *something* to work with for naming.
      if (!transcriptInRange) {
        transcriptInRange = transcriptWordsRef.current
          .slice(-12)
          .map((word) => word.word)
          .join(' ');
      }

      try {
        const wav = await renderClipRange(clipStartSec, clipEndSec);
        if (!wav) {
          setStatusMessage('Clip skipped — buffer too short to slice yet.');
          return;
        }

        let titleRaw = await generateClipTitle(transcriptInRange);
        // Replace the timestamp-fallback name with a friendlier counter-based
        // name. The original fallback ("Auto clip HH-MM-SS") only fires when
        // there's no transcript at all — that happens when Deepgram isn't
        // wired up. Counter-based names are more readable.
        if (/^Auto clip \d{2}-\d{2}-\d{2}$/.test(titleRaw)) {
          if (source === 'acoustic') titleRaw = `Loud moment ${triggerNumber}`;
          else if (source === 'manual') titleRaw = `Saved take ${triggerNumber}`;
          else titleRaw = `Auto clip ${triggerNumber}`;
        }

        const clipId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        if (settings.autoSaveEnabled) {
          const fullFilename = await uploadClipBlob(
            wav,
            titleRaw,
            settings.clipCategory || 'Uncategorized',
          );

          if (!fullFilename) return;

          const clip: RecentClip = {
            id: clipId,
            title: titleRaw,
            filename: fullFilename.split('/').pop() ?? '',
            fullFilename,
            savedAt: Date.now(),
            durationSec: trimmedSec,
            source,
            transcript: transcriptInRange,
          };
          setRecentClips((current) => [clip, ...current].slice(0, 20));
          setStatusMessage(`Saved "${titleRaw}" (${trimmedSec.toFixed(1)}s).`);
        } else {
          // Hold the clip in memory for review.
          const pending: PendingClip = {
            id: clipId,
            title: titleRaw,
            durationSec: trimmedSec,
            source,
            transcript: transcriptInRange,
            category: settings.clipCategory || 'Uncategorized',
            blob: wav,
            createdAt: Date.now(),
          };
          setPendingClips((current) => [pending, ...current].slice(0, 12));
          setStatusMessage(
            `Captured "${titleRaw}" — review it below to save or discard.`,
          );
        }
      } catch (error) {
        console.error('Auto-clip extraction failed:', error);
        setStatusMessage(
          `Auto-clip failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    },
    [generateClipTitle, renderClipRange, uploadClipBlob],
  );

  // --- Preview helpers ---------------------------------------------------

  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.onended = null;
      previewAudioRef.current.onerror = null;
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    if (previewBlobUrlRef.current) {
      URL.revokeObjectURL(previewBlobUrlRef.current);
      previewBlobUrlRef.current = null;
    }
    setPreviewingId(null);
  }, []);

  const playClipPreview = useCallback(
    async (
      clipId: string,
      src: { kind: 'blob'; blob: Blob } | { kind: 'file'; path: string },
    ) => {
      if (previewingId === clipId) {
        stopPreview();
        return;
      }

      stopPreview();

      const url =
        src.kind === 'blob' ? URL.createObjectURL(src.blob) : buildMediaUrl('sounds', src.path);
      if (src.kind === 'blob') previewBlobUrlRef.current = url;

      const audio = new Audio(url);
      audio.onended = stopPreview;
      audio.onerror = () => {
        console.error('Auto-clip preview failed for', clipId);
        stopPreview();
      };
      previewAudioRef.current = audio;
      setPreviewingId(clipId);

      // Route the preview through the user's "Trim Preview Output" so it
      // plays on their headphones rather than whatever Windows happens to
      // have as default (which is often the broadcast cable for streamers).
      // If setSinkId fails for the chosen device, we still call play() so
      // the preview lands on default rather than being silently dropped.
      type AudioElementWithSink = HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
        sinkId?: string;
      };
      const sinkAware = audio as AudioElementWithSink;
      let routedTo = previewDeviceLabel;
      let routeOk = true;

      if (previewOutputId && typeof sinkAware.setSinkId === 'function') {
        try {
          await sinkAware.setSinkId(previewOutputId);
          console.info(
            `[AutoClipper preview] setSinkId(${previewOutputId}) succeeded → ${routedTo}`,
          );
        } catch (error) {
          routeOk = false;
          routedTo = `${previewDeviceLabel} (setSinkId failed → falling back to default)`;
          console.warn(
            `[AutoClipper preview] setSinkId(${previewOutputId}) failed:`,
            error,
          );
        }
      } else if (!previewOutputId) {
        console.info(
          `[AutoClipper preview] No Preview Output pinned, playing on Audio element default (${routedTo})`,
        );
      }

      setPreviewRouteStatus(
        `Playing on: ${routedTo}${routeOk ? '' : ''}. ` +
          'If you can\'t hear it, change Trim Preview Output in Settings → Routing.',
      );

      audio.play().catch((error) => {
        console.error('Auto-clip preview play() rejected:', error);
        setPreviewRouteStatus(
          `Playback was rejected by the browser: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
        stopPreview();
      });
    },
    [previewDeviceLabel, previewOutputId, previewingId, stopPreview],
  );

  // --- Pending clip controls --------------------------------------------

  const renamePendingClip = useCallback((id: string, nextTitle: string) => {
    setPendingClips((current) =>
      current.map((clip) => (clip.id === id ? { ...clip, title: nextTitle } : clip)),
    );
  }, []);

  const commitPendingClip = useCallback(
    async (id: string) => {
      const target = pendingClips.find((clip) => clip.id === id);
      if (!target) return;

      // If this clip is currently being previewed, stop first so the blob URL
      // gets revoked before we drop the reference.
      if (previewingId === id) stopPreview();

      try {
        const fullFilename = await uploadClipBlob(target.blob, target.title, target.category);
        if (!fullFilename) return;

        const clip: RecentClip = {
          id: `saved-${target.id}`,
          title: target.title,
          filename: fullFilename.split('/').pop() ?? '',
          fullFilename,
          savedAt: Date.now(),
          durationSec: target.durationSec,
          source: target.source,
          transcript: target.transcript,
        };
        setRecentClips((current) => [clip, ...current].slice(0, 20));
        setPendingClips((current) => current.filter((c) => c.id !== id));
        setStatusMessage(`Saved "${target.title}".`);
      } catch (error) {
        console.error('Failed to save pending clip:', error);
        setStatusMessage(
          `Save failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    },
    [pendingClips, previewingId, stopPreview, uploadClipBlob],
  );

  const discardPendingClip = useCallback(
    (id: string) => {
      if (previewingId === id) stopPreview();
      setPendingClips((current) => current.filter((c) => c.id !== id));
    },
    [previewingId, stopPreview],
  );

  const discardAllPending = useCallback(() => {
    if (previewingId) stopPreview();
    setPendingClips([]);
  }, [previewingId, stopPreview]);

  // --- Manual trim editor ------------------------------------------------

  const stopTrimPreview = useCallback(() => {
    if (trimAudioRef.current) {
      trimAudioRef.current.onended = null;
      trimAudioRef.current.onerror = null;
      trimAudioRef.current.pause();
      trimAudioRef.current = null;
    }
    if (trimBlobUrlRef.current) {
      URL.revokeObjectURL(trimBlobUrlRef.current);
      trimBlobUrlRef.current = null;
    }
    setTrimPreviewing(false);
  }, []);

  const openTrim = useCallback(
    async (pending: PendingClip) => {
      // Stop any other preview audio so it doesn't fight the editor.
      stopPreview();
      stopTrimPreview();

      try {
        const ctx = createAudioContext();
        const arrayBuffer = await pending.blob.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        if (ctx.state !== 'closed') await ctx.close().catch(() => undefined);

        // Downsample to ~720 (min, max) pairs across the canvas — dense enough
        // to render every word's shape, cheap enough to redraw on every drag
        // frame without stuttering.
        const bucketCount = Math.min(720, decoded.length);
        const samplesPerBucket = Math.max(1, Math.floor(decoded.length / bucketCount));
        const flat: number[] = new Array(bucketCount * 2);

        // Average across all channels for visual purposes.
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
          channels.push(decoded.getChannelData(ch));
        }

        for (let bucket = 0; bucket < bucketCount; bucket += 1) {
          const start = bucket * samplesPerBucket;
          const end = Math.min(decoded.length, start + samplesPerBucket);
          let min = 1;
          let max = -1;
          for (let i = start; i < end; i += 1) {
            let sample = 0;
            for (let ch = 0; ch < channels.length; ch += 1) {
              sample += channels[ch][i] ?? 0;
            }
            sample /= channels.length || 1;
            if (sample < min) min = sample;
            if (sample > max) max = sample;
          }
          flat[bucket * 2] = min;
          flat[bucket * 2 + 1] = max;
        }

        setTrimSession({
          pendingId: pending.id,
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          channelCount: decoded.numberOfChannels,
          channelData: channels.map((data) => new Float32Array(data)),
          peaks: flat,
          bucketCount,
          selectionStart: 0,
          selectionEnd: decoded.duration,
          title: pending.title,
          category: pending.category,
          transcript: pending.transcript,
          durationSec: pending.durationSec,
          source: pending.source,
        });
      } catch (error) {
        console.error('Failed to open trim editor:', error);
        setStatusMessage(
          `Couldn't open trim editor: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    },
    [stopPreview, stopTrimPreview],
  );

  const closeTrim = useCallback(() => {
    stopTrimPreview();
    setTrimSession(null);
  }, [stopTrimPreview]);

  /**
   * Build a WAV blob of just the user-selected sub-range of the active trim
   * session, by slicing the decoded channel data we already have in memory.
   */
  const buildTrimmedBlob = useCallback((session: TrimSession): Blob => {
    const startSample = Math.floor(session.selectionStart * session.sampleRate);
    const endSample = Math.min(
      session.channelData[0]?.length ?? 0,
      Math.floor(session.selectionEnd * session.sampleRate),
    );
    const frameCount = Math.max(1, endSample - startSample);

    const offlineCtx = new OfflineAudioContext(
      session.channelCount || 1,
      frameCount,
      session.sampleRate,
    );
    const sliceBuffer = offlineCtx.createBuffer(
      session.channelCount || 1,
      frameCount,
      session.sampleRate,
    );

    for (let ch = 0; ch < session.channelCount; ch += 1) {
      const sourceData = session.channelData[ch];
      if (!sourceData) continue;
      const destination = sliceBuffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i += 1) {
        destination[i] = sourceData[startSample + i] ?? 0;
      }
    }

    return encodeWav(sliceBuffer);
  }, []);

  const playTrimPreview = useCallback(() => {
    if (!trimSession) return;
    if (trimPreviewing) {
      stopTrimPreview();
      return;
    }

    const trimmed = buildTrimmedBlob(trimSession);
    const url = URL.createObjectURL(trimmed);
    trimBlobUrlRef.current = url;

    const audio = new Audio(url);
    audio.onended = () => stopTrimPreview();
    audio.onerror = () => stopTrimPreview();
    trimAudioRef.current = audio;
    setTrimPreviewing(true);

    type AudioElementWithSink = HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    const sinkAware = audio as AudioElementWithSink;
    if (previewOutputId && typeof sinkAware.setSinkId === 'function') {
      sinkAware.setSinkId(previewOutputId).catch((error) => {
        console.warn('Trim preview setSinkId failed:', error);
      });
    }

    audio.play().catch((error) => {
      console.error('Trim preview play() failed:', error);
      stopTrimPreview();
    });
  }, [buildTrimmedBlob, previewOutputId, stopTrimPreview, trimPreviewing, trimSession]);

  const saveTrim = useCallback(async () => {
    if (!trimSession) return;
    const pending = pendingClips.find((c) => c.id === trimSession.pendingId);
    if (!pending) {
      closeTrim();
      return;
    }

    try {
      const trimmed = buildTrimmedBlob(trimSession);
      const fullFilename = await uploadClipBlob(
        trimmed,
        trimSession.title,
        trimSession.category,
      );
      if (!fullFilename) return;

      const clip: RecentClip = {
        id: `saved-${trimSession.pendingId}`,
        title: trimSession.title,
        filename: fullFilename.split('/').pop() ?? '',
        fullFilename,
        savedAt: Date.now(),
        durationSec: trimSession.selectionEnd - trimSession.selectionStart,
        source: trimSession.source,
        transcript: trimSession.transcript,
      };
      setRecentClips((current) => [clip, ...current].slice(0, 20));
      setPendingClips((current) => current.filter((c) => c.id !== trimSession.pendingId));
      setStatusMessage(`Saved trimmed "${trimSession.title}".`);
      closeTrim();
    } catch (error) {
      console.error('Failed to save trimmed clip:', error);
      setStatusMessage(
        `Save failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }, [buildTrimmedBlob, closeTrim, pendingClips, trimSession, uploadClipBlob]);

  // --- Trim canvas painting + drag --------------------------------------

  useEffect(() => {
    if (!trimSession) return;
    const canvas = trimCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Centerline
    const halfHeight = height / 2;
    ctx.fillStyle = 'rgba(180,210,234,0.18)';
    ctx.fillRect(0, halfHeight - 0.5, width, 1);

    // Waveform bars
    const pairs = trimSession.bucketCount;
    const pixelsPerBar = width / Math.max(1, pairs);
    ctx.fillStyle = 'rgba(62, 162, 230, 0.78)';
    for (let i = 0; i < pairs; i += 1) {
      const min = trimSession.peaks[i * 2] ?? 0;
      const max = trimSession.peaks[i * 2 + 1] ?? 0;
      const top = halfHeight - max * halfHeight;
      const barHeight = Math.max(1, (max - min) * halfHeight);
      ctx.fillRect(i * pixelsPerBar, top, Math.max(1, pixelsPerBar - 0.5), barHeight);
    }

    // Selection overlay
    if (trimSession.duration > 0) {
      const left =
        (trimSession.selectionStart / trimSession.duration) * width;
      const right = (trimSession.selectionEnd / trimSession.duration) * width;
      if (right > left) {
        ctx.fillStyle = 'rgba(127, 200, 240, 0.18)';
        ctx.fillRect(left, 0, right - left, height);

        ctx.fillStyle = 'rgba(127, 200, 240, 0.95)';
        ctx.fillRect(left - 1, 0, 2, height);
        ctx.fillRect(right - 1, 0, 2, height);

        // Grippy edge handles to make it obvious the boundaries are draggable
        ctx.fillRect(left - 6, height / 2 - 16, 12, 32);
        ctx.fillRect(right - 6, height / 2 - 16, 12, 32);
      }
    }
  }, [trimSession]);

  const trimPointerToTime = useCallback(
    (clientX: number, canvas: HTMLCanvasElement): number | null => {
      if (!trimSession) return null;
      const rect = canvas.getBoundingClientRect();
      const fraction = (clientX - rect.left) / rect.width;
      const clamped = Math.max(0, Math.min(1, fraction));
      return clamped * trimSession.duration;
    },
    [trimSession],
  );

  const handleTrimPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!trimSession) return;
      const canvas = event.currentTarget;
      const time = trimPointerToTime(event.clientX, canvas);
      if (time === null) return;

      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      trimPointerAnchorRef.current = time;

      // Wider handle hit zone since clips here are short — ±3% of duration
      const handleSeconds = trimSession.duration * 0.03;
      const nearStart = Math.abs(time - trimSession.selectionStart) <= handleSeconds;
      const nearEnd = Math.abs(time - trimSession.selectionEnd) <= handleSeconds;

      if (nearStart && (!nearEnd || time < trimSession.selectionStart)) {
        trimDragModeRef.current = {
          kind: 'resize-start',
          otherEdge: trimSession.selectionEnd,
        };
        return;
      }
      if (nearEnd) {
        trimDragModeRef.current = {
          kind: 'resize-end',
          otherEdge: trimSession.selectionStart,
        };
        return;
      }
      if (time > trimSession.selectionStart && time < trimSession.selectionEnd) {
        trimDragModeRef.current = {
          kind: 'move',
          offsetStart: time - trimSession.selectionStart,
          offsetEnd: trimSession.selectionEnd - time,
        };
        return;
      }

      // Fresh paint
      trimDragModeRef.current = { kind: 'paint', anchorSec: time };
      setTrimSession((current) =>
        current ? { ...current, selectionStart: time, selectionEnd: time } : current,
      );
      // Stop any active preview since the selection is changing
      if (trimPreviewing) stopTrimPreview();
    },
    [stopTrimPreview, trimPointerToTime, trimPreviewing, trimSession],
  );

  const handleTrimPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const mode = trimDragModeRef.current;
      if (!mode || !trimSession) return;
      const canvas = event.currentTarget;
      const time = trimPointerToTime(event.clientX, canvas);
      if (time === null) return;

      setTrimSession((current) => {
        if (!current) return current;
        let nextStart = current.selectionStart;
        let nextEnd = current.selectionEnd;

        if (mode.kind === 'paint') {
          nextStart = Math.min(mode.anchorSec, time);
          nextEnd = Math.max(mode.anchorSec, time);
        } else if (mode.kind === 'resize-start') {
          nextStart = Math.min(time, mode.otherEdge - 0.05);
          nextEnd = mode.otherEdge;
        } else if (mode.kind === 'resize-end') {
          nextStart = mode.otherEdge;
          nextEnd = Math.max(time, mode.otherEdge + 0.05);
        } else {
          const newStart = Math.max(0, time - mode.offsetStart);
          const newEnd = Math.min(
            current.duration,
            newStart + (mode.offsetStart + mode.offsetEnd),
          );
          nextStart = newStart;
          nextEnd = newEnd;
        }

        nextStart = Math.max(0, Math.min(current.duration, nextStart));
        nextEnd = Math.max(nextStart + 0.02, Math.min(current.duration, nextEnd));

        return { ...current, selectionStart: nextStart, selectionEnd: nextEnd };
      });
    },
    [trimPointerToTime, trimSession],
  );

  const handleTrimPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      trimDragModeRef.current = null;
      trimPointerAnchorRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
    },
    [],
  );

  // --- Detection loop -----------------------------------------------------

  const runSemanticCheck = useCallback(async () => {
    const startedAt = engineStartedAtRef.current;
    if (startedAt === null) return;

    const settings = settingsRef.current;
    const hasOpenAiKey =
      settings.openAiKey.trim().length > 0 || settings.hasServerOpenAiKey;
    if (!settings.semanticEnabled || !hasOpenAiKey) return;

    const elapsed = (performance.now() - startedAt) / 1000;
    const cutoff = elapsed - SEMANTIC_WINDOW_SECONDS;
    const wordsInWindow = transcriptWordsRef.current.filter(
      (word) => word.end >= cutoff,
    );

    if (wordsInWindow.length < 4) return; // not enough transcript yet

    const transcript = wordsInWindow.map((w) => w.word).join(' ');
    const referenceEnd = wordsInWindow[wordsInWindow.length - 1].end;

    try {
      const parsed = await requestAutoClipperAi({
        mode: 'semantic',
        transcript,
        openAiKey: settings.openAiKey,
        clipDurationSeconds: settings.clipDurationSeconds,
      });

      if (!parsed.clipWorthy) return;

      const startOffset = Math.max(0, parsed.startOffsetSec ?? settings.clipDurationSeconds);
      const endOffset = Math.max(0, parsed.endOffsetSec ?? 0);
      const startElapsed = Math.max(0, referenceEnd - startOffset);
      const endElapsed = Math.max(startElapsed + 0.5, referenceEnd - endOffset);

      void extractAndSaveClip(startElapsed, endElapsed, 'semantic');
    } catch (error) {
      console.warn('Semantic check failed:', error);
    }
  }, [extractAndSaveClip]);

  const runDetectionTick = useCallback(() => {
    const startedAt = engineStartedAtRef.current;
    if (startedAt === null) return;

    const settings = settingsRef.current;
    const elapsed = (performance.now() - startedAt) / 1000;
    const cooldownReady = performance.now() >= triggerCooldownUntilRef.current;
    const captureState = captureStateRef.current;

    const meanLevel = (samples: { level: number; capturedAt: number }[]) =>
      samples.length === 0
        ? 0
        : samples.reduce((sum, sample) => sum + sample.level, 0) / samples.length;

    if (captureState.phase === 'capturing') {
      // We're inside a clip-worthy moment, watching for it to end so we can
      // cut on a natural pause instead of mid-word.
      const silenceThreshold = settings.volumeThreshold * SILENCE_THRESHOLD_RATIO;
      const shortCutoff = elapsed - SHORT_LEVEL_WINDOW_SECONDS;
      const shortWindow = volumeHistoryRef.current.filter(
        (sample) => sample.capturedAt >= shortCutoff,
      );
      const shortAvg = meanLevel(shortWindow);

      // Bump the last-loud time whenever the trailing window is still over
      // the silence threshold; that's how we know the moment hasn't ended.
      if (shortAvg >= silenceThreshold) {
        captureState.lastLoudAt = elapsed;
      }

      const elapsedSinceLoud = elapsed - captureState.lastLoudAt;
      const elapsedSinceStart = elapsed - captureState.startedAt;
      const reachedMax = elapsedSinceStart >= settings.clipDurationSeconds;

      if (elapsedSinceLoud >= settings.silenceHoldSeconds || reachedMax) {
        // Find the start of the moment by walking the volume history
        // backwards from the original trigger point until we find a sample
        // that's quieter than the silence threshold. That's the "rise" — we
        // back off slightly with LEAD_PADDING_SECONDS so the consonant at
        // the start of the first word isn't shaved.
        let leadStart = Math.max(0, captureState.startedAt - LEAD_PADDING_SECONDS);
        const history = volumeHistoryRef.current;
        for (let index = history.length - 1; index >= 0; index -= 1) {
          const sample = history[index];
          if (sample.capturedAt >= captureState.startedAt) continue;
          if (sample.level < silenceThreshold) {
            leadStart = Math.max(0, sample.capturedAt - LEAD_PADDING_SECONDS);
            break;
          }
        }

        // End of clip = the last loud moment plus a tail pad so the final
        // word's release/decay is included. If we hit the max-length safety
        // cap, the end is "now" because the loud moment is still going.
        const tailEnd = reachedMax ? elapsed : captureState.lastLoudAt + TAIL_PADDING_SECONDS;

        // Apply the hard cap and the minimum length. clipDurationSeconds is
        // a *ceiling* in smart-cut mode — natural cuts can be shorter.
        const cappedStart = Math.max(leadStart, tailEnd - settings.clipDurationSeconds);
        const startElapsed = Math.min(cappedStart, tailEnd - MIN_CLIP_SECONDS);
        const endElapsed = tailEnd;

        captureStateRef.current = { phase: 'idle' };
        if (endElapsed - startElapsed >= MIN_CLIP_SECONDS) {
          void extractAndSaveClip(startElapsed, endElapsed, 'acoustic');
        }
        return;
      }

      return;
    }

    // Idle phase — looking for a trigger.
    if (!cooldownReady) return;

    if (settings.acousticEnabled) {
      const cutoff = elapsed - settings.sustainSeconds;
      const recent = volumeHistoryRef.current.filter(
        (sample) => sample.capturedAt >= cutoff,
      );
      if (recent.length >= 3) {
        const avg = meanLevel(recent);
        if (avg >= settings.volumeThreshold) {
          // Enter capturing mode. We don't extract yet — wait for the moment
          // to end (silence) or for the max-clip-length safety cap.
          captureStateRef.current = {
            phase: 'capturing',
            startedAt: elapsed,
            lastLoudAt: elapsed,
          };
          return;
        }
      }
    }

    // Semantic trigger fires on a slower cadence — checked here to avoid
    // overlapping with an acoustic trigger that just armed cooldown.
    const hasOpenAiKey =
      settings.openAiKey.trim().length > 0 || settings.hasServerOpenAiKey;
    if (
      settings.semanticEnabled &&
      hasOpenAiKey &&
      elapsed - lastSemanticCheckRef.current >= SEMANTIC_INTERVAL_SECONDS
    ) {
      lastSemanticCheckRef.current = elapsed;
      void runSemanticCheck();
    }
  }, [extractAndSaveClip, runSemanticCheck]);

  // --- Deepgram ----------------------------------------------------------

  const stopTranscript = useCallback(() => {
    const socket = transcriptSocketRef.current;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
    transcriptSocketRef.current = null;
    setTranscriptStatus('disabled');
  }, []);

  const startTranscript = useCallback((keyOverride?: string) => {
    const trimmed = (keyOverride ?? deepgramKey).trim();
    if (!trimmed) {
      setTranscriptStatus('disabled');
      return;
    }

    stopTranscript();
    setTranscriptStatus('connecting');

    const socket = new WebSocket(
      `wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&interim_results=false&encoding=linear16&sample_rate=${TRANSCRIPT_SAMPLE_RATE}&channels=1`,
      ['token', trimmed],
    );

    transcriptSocketRef.current = socket;

    socket.onopen = () => {
      setTranscriptStatus('live');
    };

    socket.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data) as DeepgramMessage;
        const alternative = data.channel?.alternatives?.[0];
        const words = alternative?.words ?? [];
        const transcriptText = alternative?.transcript?.trim() ?? '';
        if (!data.is_final || (words.length === 0 && !transcriptText)) return;

        const startedAt = engineStartedAtRef.current;
        const elapsed = startedAt !== null ? (performance.now() - startedAt) / 1000 : 0;

        if (words.length > 0) {
          for (const word of words) {
            const text = (word.punctuated_word || word.word).trim();
            if (!text) continue;

            transcriptWordsRef.current.push({
              word: text,
              start: transcriptOffsetRef.current + word.start,
              end: transcriptOffsetRef.current + word.end,
            });
          }
        } else {
          const tokens = transcriptText.split(/\s+/).filter(Boolean);
          const duration =
            typeof data.duration === 'number'
              ? Math.max(0.4, data.duration)
              : Math.max(0.8, tokens.length * 0.2);
          const messageStart =
            typeof data.start === 'number'
              ? transcriptOffsetRef.current + data.start
              : Math.max(0, elapsed - duration);

          tokens.forEach((token, index) => {
            const start = messageStart + (duration / tokens.length) * index;
            const end =
              index === tokens.length - 1
                ? messageStart + duration
                : messageStart + (duration / tokens.length) * (index + 1);

            transcriptWordsRef.current.push({ word: token, start, end });
          });
        }

        // Trim old words past the buffer window.
        if (startedAt !== null) {
          transcriptWordsRef.current = transcriptWordsRef.current.filter(
            (word) => word.end >= elapsed - BUFFER_SECONDS - 5,
          );
        }
      } catch {}
    };

    socket.onerror = () => {
      setTranscriptStatus('unavailable');
    };

    socket.onclose = () => {
      if (transcriptSocketRef.current === socket) {
        transcriptSocketRef.current = null;
        setTranscriptStatus((current) =>
          current === 'unavailable' ? 'unavailable' : 'disabled',
        );
      }
    };
  }, [deepgramKey, stopTranscript]);

  // --- Engine lifecycle --------------------------------------------------

  const stopEngine = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;

    if (transcriptProcessorRef.current) {
      transcriptProcessorRef.current.onaudioprocess = null;
      transcriptProcessorRef.current.disconnect();
      transcriptProcessorRef.current = null;
    }

    if (transcriptSilenceRef.current) {
      transcriptSilenceRef.current.disconnect();
      transcriptSilenceRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      void audioContextRef.current.close().catch(() => undefined);
    }
    audioContextRef.current = null;
    analyserRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (detectionIntervalRef.current !== null) {
      window.clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }

    stopTranscript();
    stopPreview();

    headerChunkRef.current = null;
    chunksRef.current = [];
    volumeHistoryRef.current = [];
    transcriptWordsRef.current = [];
    engineStartedAtRef.current = null;
    transcriptOffsetRef.current = 0;
    triggerCooldownUntilRef.current = 0;
    lastSemanticCheckRef.current = 0;
    captureStateRef.current = { phase: 'idle' };

    setIsEngineRunning(false);
    setCurrentVolume(0);
    setStatusMessage('Engine stopped.');
  }, [stopPreview, stopTranscript]);

  const startEngine = useCallback(async () => {
    if (selectedMicId === 'none') {
      alert('Pick a microphone first.');
      return;
    }

    try {
      setStatusMessage('Starting engine…');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: selectedMicId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const audioContext = createAudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      source.connect(analyser);

      // ScriptProcessor — deprecated but universally available; used here to
      // tee audio into Deepgram if a key is configured.
      const transcriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);
      const transcriptSilence = audioContext.createGain();
      transcriptSilence.gain.value = 0;
      transcriptProcessor.connect(transcriptSilence);
      transcriptSilence.connect(audioContext.destination);
      source.connect(transcriptProcessor);
      transcriptProcessorRef.current = transcriptProcessor;
      transcriptSilenceRef.current = transcriptSilence;
      transcriptProcessor.onaudioprocess = (event) => {
        const socket = transcriptSocketRef.current;
        if (socket?.readyState !== WebSocket.OPEN) return;

        if (transcriptOffsetRef.current === 0 && engineStartedAtRef.current !== null) {
          transcriptOffsetRef.current =
            (performance.now() - engineStartedAtRef.current) / 1000;
        }

        const linear16 = convertAudioBufferToLinear16(
          event.inputBuffer,
          TRANSCRIPT_SAMPLE_RATE,
        );
        if (linear16.byteLength > 0) {
          socket.send(linear16);
        }
      };

      await audioContext.resume().catch(() => undefined);

      engineStartedAtRef.current = performance.now();
      headerChunkRef.current = null;
      chunksRef.current = [];
      volumeHistoryRef.current = [];
      transcriptWordsRef.current = [];
      triggerCooldownUntilRef.current = 0;
      lastSemanticCheckRef.current = 0;
      transcriptOffsetRef.current = 0;
      captureStateRef.current = { phase: 'idle' };

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        const startedAt = engineStartedAtRef.current;
        const elapsed = startedAt ? (performance.now() - startedAt) / 1000 : 0;
        if (!headerChunkRef.current) {
          headerChunkRef.current = event.data;
        } else {
          chunksRef.current.push({ blob: event.data, capturedAt: elapsed });
          chunksRef.current = chunksRef.current.filter(
            (chunk) => elapsed - chunk.capturedAt <= BUFFER_SECONDS,
          );
        }
      };
      recorder.start(RECORDER_TIMESLICE_MS);

      // Volume sampling loop — runs at animation-frame cadence, samples at the
      // configured cadence into the rolling history buffer.
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      let lastSample = 0;
      const sampleVolume = () => {
        const startedAt = engineStartedAtRef.current;
        if (startedAt === null) return;
        const now = performance.now();
        if (now - lastSample >= VOLUME_SAMPLE_INTERVAL_MS) {
          lastSample = now;
          analyser.getByteFrequencyData(buffer);
          const avg = buffer.reduce((acc, value) => acc + value, 0) / buffer.length;
          const elapsed = (now - startedAt) / 1000;
          volumeHistoryRef.current.push({ level: avg, capturedAt: elapsed });
          const cutoff = elapsed - BUFFER_SECONDS;
          while (
            volumeHistoryRef.current.length > 0 &&
            volumeHistoryRef.current[0].capturedAt < cutoff
          ) {
            volumeHistoryRef.current.shift();
          }
          setCurrentVolume(avg);
        }
        animationFrameRef.current = requestAnimationFrame(sampleVolume);
      };
      animationFrameRef.current = requestAnimationFrame(sampleVolume);

      // Periodic detection tick.
      detectionIntervalRef.current = window.setInterval(
        runDetectionTick,
        DETECTION_TICK_MS,
      );

      setIsEngineRunning(true);
      setStatusMessage('Engine running. Listening for clip-worthy moments…');

      if (deepgramKey.trim()) {
        startTranscript();
      }
    } catch (error) {
      console.error('Failed to start auto-clipper engine:', error);
      setStatusMessage(
        `Engine failed to start: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      stopEngine();
    }
  }, [deepgramKey, runDetectionTick, selectedMicId, startTranscript, stopEngine]);

  const toggleEngine = useCallback(() => {
    if (isEngineRunning) stopEngine();
    else void startEngine();
  }, [isEngineRunning, startEngine, stopEngine]);

  const saveOpenAiKey = useCallback((value: string) => {
    setOpenAiKey(value);
    window.localStorage.setItem('openai-key', value);
  }, []);

  const saveDeepgramKey = useCallback(
    (value: string) => {
      setDeepgramKey(value);
      window.localStorage.setItem('deepgram-key', value);

      if (!isEngineRunning) return;
      if (value.trim()) startTranscript(value);
      else stopTranscript();
    },
    [isEngineRunning, startTranscript, stopTranscript],
  );

  const saveManualClip = useCallback(() => {
    const startedAt = engineStartedAtRef.current;
    if (startedAt === null) return;
    const elapsed = (performance.now() - startedAt) / 1000;
    const start = Math.max(0, elapsed - clipDurationSeconds);
    void extractAndSaveClip(start, elapsed, 'manual');
  }, [clipDurationSeconds, extractAndSaveClip]);

  // Stop the engine on unmount so we don't leak mic captures or sockets.
  useEffect(() => {
    return () => {
      stopEngine();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Render -------------------------------------------------------------

  if (!isHost) {
    return (
      <div className="flex min-h-full items-center justify-center py-8">
        <section className="panel-surface w-full max-w-2xl p-8 text-center">
          <p className="eyebrow mb-3">Host Only</p>
          <h2 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
            Auto-Clipper runs on the desktop host.
          </h2>
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            It needs continuous mic access plus the local soundboard library, so
            it lives on the host machine. Open JAWdio there and look for the
            Auto-Clipper tab in the sidebar.
          </p>
        </section>
      </div>
    );
  }

  const volumeBarWidth = `${Math.min(100, (currentVolume / 255) * 100).toFixed(1)}%`;
  const aboveThreshold = currentVolume >= volumeThreshold;
  const hasOpenAiKeyConfigured = openAiKey.trim().length > 0 || hasServerOpenAiKey;
  const usingServerOpenAiKey = hasServerOpenAiKey && openAiKey.trim().length === 0;
  const hasPublicDeepgramKey = PUBLIC_DEEPGRAM_API_KEY.length > 0;

  return (
    <div className="flex min-h-full flex-col gap-3 pb-6">
      <section className="panel-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-2xl">
            <p className="eyebrow mb-1">Auto-Clipper</p>
            <h1 className="font-[var(--font-display)] text-xl font-semibold tracking-[-0.03em] text-[var(--text-strong)]">
              Always-listening clip detector.
            </h1>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Keeps a {BUFFER_SECONDS}-second rolling buffer in memory.
              Acoustic triggers fire when audio gets loud and stays loud.
              Optional semantic triggers send the rolling transcript to an LLM
              to flag punchlines.
            </p>
          </div>

          <button
            type="button"
            onClick={toggleEngine}
            className={`${isEngineRunning ? 'danger-button' : 'accent-button'} shrink-0`}
          >
            {isEngineRunning ? <Pause size={14} /> : <Play size={14} />}
            {isEngineRunning ? 'Stop Engine' : 'Start Engine'}
          </button>
        </div>

        {/* Live indicator. */}
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-2">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
              Engine
            </p>
            <p className="font-mono text-sm text-[var(--text-strong)]">
              {isEngineRunning ? 'Listening' : 'Idle'}
            </p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-2">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
              Transcript
            </p>
            <p className="font-mono text-sm text-[var(--text-strong)]">{transcriptStatus}</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-2">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
              Live volume
            </p>
            <div className="mt-1 h-2 overflow-hidden rounded-full border border-[var(--line)] bg-[rgba(4,8,14,0.6)]">
              <div
                className="h-full rounded-full transition-[width]"
                style={{
                  width: volumeBarWidth,
                  background: aboveThreshold
                    ? 'linear-gradient(90deg, rgba(62,162,230,0.6), rgba(127,200,240,0.95))'
                    : 'linear-gradient(90deg, rgba(180,210,234,0.18), rgba(180,210,234,0.32))',
                }}
              />
            </div>
            <p className="mt-1 text-[10px] text-[var(--text-muted)]">
              {currentVolume.toFixed(0)} / 255 (threshold {volumeThreshold})
            </p>
          </div>
        </div>

        <p className="mt-3 text-xs text-[var(--text-muted)]">{statusMessage}</p>

        {/* Preview routing diagnostic. Lets the user see WHERE preview audio
            is being sent, plus a Test button that uses the exact same path
            so they can confirm before they need it to work mid-stream. */}
        <div className="mt-3 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.03)] px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Preview routes to:{' '}
              <span className="text-[var(--text-strong)]">{previewDeviceLabel}</span>
            </span>
            <button
              type="button"
              onClick={async () => {
                const ok = await testOutput(previewOutputId || null);
                setPreviewRouteStatus(
                  ok
                    ? `Test tone sent to: ${previewDeviceLabel}. If you didn't hear it, change Trim Preview Output in Settings → Routing.`
                    : `Test tone failed to route to ${previewDeviceLabel}. Try a different device or set Trim Preview Output to "Use Windows default".`,
                );
              }}
              className="ghost-button px-2 py-1 text-[11px]"
            >
              <Volume2 size={11} />
              Test preview output
            </button>
          </div>
          {previewRouteStatus && (
            <p className="mt-1 text-[10.5px]">{previewRouteStatus}</p>
          )}
        </div>
      </section>

      <section className="panel-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Mic size={14} className="text-[var(--accent)]" />
          <p className="eyebrow">Source</p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label
              htmlFor="auto-clipper-mic"
              className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]"
            >
              Microphone
            </label>
            <select
              id="auto-clipper-mic"
              className="select-field mt-1"
              value={selectedMicId}
              onChange={(event) => setSelectedMicId(event.target.value)}
              disabled={isEngineRunning}
            >
              <option value="none">Pick a microphone</option>
              {mics.map((mic) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label || `Microphone ${mic.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="auto-clipper-category"
              className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]"
            >
              Save clips into folder
            </label>
            <select
              id="auto-clipper-category"
              className="select-field mt-1"
              value={categoryOptions.includes(clipCategory) ? clipCategory : 'Uncategorized'}
              onChange={(event) => setClipCategory(event.target.value)}
            >
              {categoryOptions.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-[var(--text-base)]">
          <input
            type="checkbox"
            checked={autoSaveEnabled}
            onChange={(event) => setAutoSaveEnabled(event.target.checked)}
          />
          <span>
            <span className="text-[var(--text-strong)]">Auto-save</span>: upload every trigger
            straight to the soundboard.
          </span>
        </label>
        {!autoSaveEnabled && (
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Off → triggers land in a <em>Pending review</em> list below where you can preview,
            rename, and Save or Discard each clip.
          </p>
        )}
      </section>

      <section className="panel-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Volume2 size={14} className="text-[var(--accent)]" />
          <p className="eyebrow">Acoustic Trigger</p>
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={acousticEnabled}
              onChange={(event) => setAcousticEnabled(event.target.checked)}
            />
            Enabled
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="auto-clipper-threshold"
              className="flex justify-between text-[11px] text-[var(--text-muted)]"
            >
              <span>Volume threshold</span>
              <span className="text-[var(--text-strong)]">{volumeThreshold}</span>
            </label>
            <input
              id="auto-clipper-threshold"
              type="range"
              min={MIN_VOLUME_THRESHOLD}
              max={MAX_VOLUME_THRESHOLD}
              value={volumeThreshold}
              onChange={(event) => setVolumeThreshold(Number(event.target.value))}
              className="range-accent mt-1 w-full"
            />
          </div>
          <div>
            <label
              htmlFor="auto-clipper-sustain"
              className="flex justify-between text-[11px] text-[var(--text-muted)]"
            >
              <span>Sustain (seconds)</span>
              <span className="text-[var(--text-strong)]">{sustainSeconds.toFixed(2)}</span>
            </label>
            <input
              id="auto-clipper-sustain"
              type="range"
              min={0.2}
              max={3}
              step={0.05}
              value={sustainSeconds}
              onChange={(event) => setSustainSeconds(Number(event.target.value))}
              className="range-accent mt-1 w-full"
            />
          </div>
          <div>
            <label
              htmlFor="auto-clipper-cooldown"
              className="flex justify-between text-[11px] text-[var(--text-muted)]"
            >
              <span>Cooldown after firing (seconds)</span>
              <span className="text-[var(--text-strong)]">{cooldownSeconds}</span>
            </label>
            <input
              id="auto-clipper-cooldown"
              type="range"
              min={2}
              max={60}
              step={1}
              value={cooldownSeconds}
              onChange={(event) => setCooldownSeconds(Number(event.target.value))}
              className="range-accent mt-1 w-full"
            />
          </div>
          <div>
            <label
              htmlFor="auto-clipper-duration"
              className="flex justify-between text-[11px] text-[var(--text-muted)]"
            >
              <span>Max clip length (seconds)</span>
              <span className="text-[var(--text-strong)]">{clipDurationSeconds}</span>
            </label>
            <input
              id="auto-clipper-duration"
              type="range"
              min={2}
              max={Math.min(BUFFER_SECONDS - 2, 15)}
              step={1}
              value={clipDurationSeconds}
              onChange={(event) => setClipDurationSeconds(Number(event.target.value))}
              className="range-accent mt-1 w-full"
            />
            <p className="mt-1 text-[10px] text-[var(--text-muted)]">
              Hard cap. The clip ends naturally when audio quiets down, so most
              clips will be shorter than this.
            </p>
          </div>
          <div className="sm:col-span-2">
            <label
              htmlFor="auto-clipper-silence"
              className="flex justify-between text-[11px] text-[var(--text-muted)]"
            >
              <span>Sentence sensitivity (silence hold seconds)</span>
              <span className="text-[var(--text-strong)]">
                {silenceHoldSeconds.toFixed(2)}s
              </span>
            </label>
            <input
              id="auto-clipper-silence"
              type="range"
              min={0.1}
              max={1.5}
              step={0.05}
              value={silenceHoldSeconds}
              onChange={(event) => setSilenceHoldSeconds(Number(event.target.value))}
              className="range-accent mt-1 w-full"
            />
            <p className="mt-1 text-[10px] text-[var(--text-muted)]">
              How long audio must stay quiet before the clip ends.{' '}
              <span className="text-[var(--text-strong)]">Lower</span> = single
              utterances (&ldquo;she said cardi&rdquo; without other people).{' '}
              <span className="text-[var(--text-strong)]">Higher</span> = full
              multi-speaker exchanges. Tighten if clips keep including other
              people talking after the moment.
            </p>
          </div>
        </div>
      </section>

      <section className="panel-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles size={14} className="text-[var(--warm)]" />
          <p className="eyebrow">Semantic Trigger &amp; LLM Naming</p>
        </div>

        <p className="mb-3 text-xs text-[var(--text-muted)]">
          Optional. When enabled and an OpenAI key is set, the rolling
          transcript is checked every {SEMANTIC_INTERVAL_SECONDS}s for funny
          punchlines and quotable moments. The LLM also auto-names clips.
        </p>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-[var(--text-base)]">
            <input
              type="checkbox"
              checked={semanticEnabled}
              onChange={(event) => setSemanticEnabled(event.target.checked)}
            />
            Use LLM to spot clip-worthy quotes
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--text-base)]">
            <input
              type="checkbox"
              checked={llmNamingEnabled}
              onChange={(event) => setLlmNamingEnabled(event.target.checked)}
            />
            Use LLM to name clips (falls back to transcript words otherwise)
          </label>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <label
              htmlFor="auto-clipper-openai"
              className="flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]"
            >
              <KeyRound size={11} />
              OpenAI API key
            </label>
            <input
              id="auto-clipper-openai"
              type="password"
              value={openAiKey}
              onChange={(event) => saveOpenAiKey(event.target.value)}
              placeholder={usingServerOpenAiKey ? 'Using .env.local key' : 'sk-...'}
              className="field mt-1"
              autoComplete="off"
            />
            <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">
              {hasServerOpenAiKey
                ? 'Local AI route sees an OpenAI key in .env.local.'
                : 'Enter a key here or set OPENAI_API_KEY in .env.local.'}
            </p>
          </div>
          <div>
            <label
              htmlFor="auto-clipper-deepgram"
              className="flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]"
            >
              <KeyRound size={11} />
              Deepgram API key (for transcript)
            </label>
            <input
              id="auto-clipper-deepgram"
              type="password"
              value={deepgramKey}
              onChange={(event) => saveDeepgramKey(event.target.value)}
              placeholder={hasPublicDeepgramKey ? 'Using env Deepgram key' : 'dg-...'}
              className="field mt-1"
              autoComplete="off"
            />
            <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">
              {hasPublicDeepgramKey
                ? 'Loaded NEXT_PUBLIC_DEEPGRAM_API_KEY unless you enter a different key.'
                : 'Required for transcript, semantic triggers, and transcript-based names.'}
            </p>
          </div>
        </div>

        {semanticEnabled && !hasOpenAiKeyConfigured && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-[rgba(246,196,75,0.32)] bg-[rgba(246,196,75,0.08)] p-2 text-xs text-[var(--warm)]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>Semantic triggers need an OpenAI key. Add one above or set OPENAI_API_KEY in .env.local.</span>
          </div>
        )}
      </section>

      {pendingClips.length > 0 && (
        <section className="panel-surface p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-[var(--warm)]" />
              <p className="eyebrow">Pending review</p>
              <span className="rounded-full border border-[rgba(246,196,75,0.32)] bg-[rgba(246,196,75,0.1)] px-2 py-[1px] text-[10px] uppercase tracking-[0.14em] text-[var(--warm)]">
                {pendingClips.length}
              </span>
            </div>
            <button
              type="button"
              onClick={discardAllPending}
              className="inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] hover:text-[var(--danger)]"
            >
              <Trash2 size={11} />
              Discard all
            </button>
          </div>

          <ul className="space-y-2">
            {pendingClips.map((clip) => {
              const isPreviewing = previewingId === clip.id;
              return (
                <li
                  key={clip.id}
                  className="rounded-md border border-[rgba(246,196,75,0.32)] bg-[rgba(246,196,75,0.06)] p-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {clip.source === 'acoustic' && (
                      <Volume2 size={12} className="text-[var(--accent)]" />
                    )}
                    {clip.source === 'semantic' && (
                      <Sparkles size={12} className="text-[var(--warm)]" />
                    )}
                    {clip.source === 'manual' && (
                      <Wand2 size={12} className="text-[var(--text-muted)]" />
                    )}
                    <input
                      type="text"
                      value={clip.title}
                      onChange={(event) => renamePendingClip(clip.id, event.target.value)}
                      className="field flex-1 min-w-[160px] py-1 text-[12.5px]"
                    />
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {clip.durationSec.toFixed(1)}s · {clip.category}
                    </span>
                  </div>

                  {clip.transcript && (
                    <p className="mt-1 line-clamp-2 text-[10.5px] text-[var(--text-muted)]">
                      “{clip.transcript}”
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        playClipPreview(clip.id, { kind: 'blob', blob: clip.blob })
                      }
                      className="ghost-button px-2 py-1 text-[11px]"
                    >
                      {isPreviewing ? <Pause size={11} /> : <Play size={11} />}
                      {isPreviewing ? 'Stop' : 'Preview'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void openTrim(clip)}
                      className="ghost-button px-2 py-1 text-[11px]"
                      title="Drag to select a sub-range, then save just that part"
                    >
                      <Scissors size={11} />
                      Trim
                    </button>
                    <button
                      type="button"
                      onClick={() => void commitPendingClip(clip.id)}
                      disabled={!clip.title.trim()}
                      className="accent-button px-2 py-1 text-[11px]"
                    >
                      <Save size={11} />
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => discardPendingClip(clip.id)}
                      className="danger-button px-2 py-1 text-[11px]"
                    >
                      <X size={11} />
                      Discard
                    </button>
                    <span className="ml-auto text-[10px] text-[var(--text-muted)]">
                      <CircleDot size={9} className="mr-1 inline-block" />
                      {formatRelative(clip.createdAt, nowMs)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="panel-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-[var(--accent)]" />
            <p className="eyebrow">Saved clips</p>
          </div>
          <button
            type="button"
            onClick={saveManualClip}
            disabled={!isEngineRunning}
            className="ghost-button"
            title="Save the last clipDuration seconds right now"
          >
            <Zap size={13} />
            Save now
          </button>
        </div>

        {recentClips.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">
            {autoSaveEnabled
              ? 'Nothing yet. When the engine fires (or you press Save now), the clip will show up here AND appear in the soundboard library.'
              : 'Nothing saved yet. When clips fire they land in the Pending review list above — preview, name, then Save to land here and in the soundboard library.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {recentClips.map((clip) => {
              const isPreviewing = previewingId === clip.id;
              return (
                <li
                  key={clip.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.03)] px-2 py-1.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {clip.source === 'acoustic' && (
                        <Volume2 size={11} className="text-[var(--accent)]" />
                      )}
                      {clip.source === 'semantic' && (
                        <Sparkles size={11} className="text-[var(--warm)]" />
                      )}
                      {clip.source === 'manual' && (
                        <Wand2 size={11} className="text-[var(--text-muted)]" />
                      )}
                      <span className="truncate font-medium text-[var(--text-strong)]">
                        {clip.title}
                      </span>
                      <span className="text-[var(--text-muted)]">
                        · {clip.durationSec.toFixed(1)}s
                      </span>
                    </div>
                    {clip.transcript && (
                      <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-muted)]">
                        “{clip.transcript}”
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        playClipPreview(clip.id, { kind: 'file', path: clip.fullFilename })
                      }
                      title={isPreviewing ? 'Stop preview' : 'Preview'}
                      className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-1 text-[var(--text-muted)] transition hover:text-[var(--text-strong)]"
                    >
                      {isPreviewing ? <Pause size={11} /> : <Play size={11} />}
                    </button>
                    <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                      <CircleDot size={9} />
                      {formatRelative(clip.savedAt, nowMs)}
                    </span>
                  </div>
                </li>
              );
            })}
            {recentClips.length > 0 && (
              <li className="pt-1">
                <button
                  type="button"
                  onClick={() => setRecentClips([])}
                  className="inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                >
                  <Trash2 size={11} />
                  Clear list (doesn&apos;t delete saved clips)
                </button>
              </li>
            )}
          </ul>
        )}
      </section>

      {trimSession && (
        <div
          className="fixed inset-0 z-[260] flex items-center justify-center bg-[rgba(3,6,10,0.78)] p-4 backdrop-blur-lg"
          onClick={() => closeTrim()}
        >
          <div
            className="panel-surface w-full max-w-2xl p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="eyebrow mb-1">Trim clip</p>
                <input
                  type="text"
                  value={trimSession.title}
                  onChange={(event) =>
                    setTrimSession((current) =>
                      current ? { ...current, title: event.target.value } : current,
                    )
                  }
                  className="field text-sm"
                  placeholder="Clip name"
                />
              </div>
              <button
                type="button"
                onClick={closeTrim}
                title="Close"
                className="rounded-md border border-[var(--line)] p-1.5 text-[var(--text-muted)] hover:text-[var(--text-strong)]"
              >
                <X size={14} />
              </button>
            </div>

            <div className="relative h-40 overflow-hidden rounded-md border border-[var(--line)] bg-[rgba(4,8,14,0.86)] sm:h-44">
              <canvas
                ref={trimCanvasRef}
                width={1280}
                height={176}
                className="h-full w-full touch-none cursor-crosshair"
                onPointerDown={handleTrimPointerDown}
                onPointerMove={handleTrimPointerMove}
                onPointerUp={handleTrimPointerUp}
                onPointerCancel={handleTrimPointerUp}
              />
            </div>

            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-2">
                <p className="text-[var(--text-muted)]">Selection start</p>
                <p className="font-mono text-[var(--text-strong)]">
                  {trimSession.selectionStart.toFixed(2)}s
                </p>
              </div>
              <div className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-2">
                <p className="text-[var(--text-muted)]">Selection end</p>
                <p className="font-mono text-[var(--text-strong)]">
                  {trimSession.selectionEnd.toFixed(2)}s
                </p>
              </div>
              <div className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-2">
                <p className="text-[var(--text-muted)]">Length</p>
                <p className="font-mono text-[var(--text-strong)]">
                  {(trimSession.selectionEnd - trimSession.selectionStart).toFixed(2)}s
                </p>
              </div>
            </div>

            <p className="mt-2 text-[10.5px] text-[var(--text-muted)]">
              Drag anywhere on the waveform to paint a new range. Drag the edges
              to fine-tune. Drag inside the selection to slide it.
            </p>

            {trimSession.transcript && (
              <p className="mt-2 line-clamp-3 text-[11px] italic text-[var(--text-muted)]">
                “{trimSession.transcript}”
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={playTrimPreview}
                className="ghost-button"
              >
                {trimPreviewing ? <Pause size={13} /> : <Play size={13} />}
                {trimPreviewing ? 'Stop' : 'Preview selection'}
              </button>
              <button
                type="button"
                onClick={() =>
                  setTrimSession((current) =>
                    current
                      ? { ...current, selectionStart: 0, selectionEnd: current.duration }
                      : current,
                  )
                }
                className="ghost-button"
                title="Reset selection to the full clip"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={closeTrim}
                className="ghost-button"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveTrim()}
                disabled={
                  !trimSession.title.trim() ||
                  trimSession.selectionEnd - trimSession.selectionStart < 0.1
                }
                className="accent-button"
              >
                <Save size={13} />
                Save trimmed
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
