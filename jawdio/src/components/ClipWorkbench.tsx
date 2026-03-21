'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  KeyRound,
  Loader2,
  Mic,
  Pause,
  Play,
  Radio,
  Save,
  Waves,
} from 'lucide-react';

import { useAudio } from '@/context/AudioContext';
import { createAudioContext, encodeWav, sliceAndExportAudio } from '@/lib/audio';
import LiveTimelineEditor from '@/components/LiveTimelineEditor';

type DesktopMediaTrackConstraints = MediaTrackConstraints & {
  mandatory: {
    chromeMediaSource: 'desktop';
    chromeMediaSourceId?: string;
  };
};

type TranscriptStatus = 'disabled' | 'ready' | 'connecting' | 'live' | 'unavailable';

interface LiveWord {
  id: string;
  word: string;
  start: number;
  end: number;
}

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
}

interface DeepgramMessage {
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      words?: DeepgramWord[];
    }>;
  };
}

interface TimedChunk {
  blob: Blob;
  capturedAt: number;
}

interface BufferWindow {
  start: number;
  end: number;
  duration: number;
}

interface SelectionRange {
  start: number;
  end: number;
}

interface PreviewSnapshot {
  blob: Blob;
  window: BufferWindow;
  peaks: Array<Float32Array | number[]>;
  audioDuration: number;
}

const BUFFER_SECONDS = 60;
const RECORDER_TIMESLICE_MS = 250;
const TRANSCRIPT_RETENTION_SECONDS = 240;
const DEFAULT_SELECTION_SECONDS = 8;
const MIN_PREVIEW_SECONDS = 0.35;
const TRANSCRIPT_SAMPLE_RATE = 16000;
const WORD_TIMING_LEAD_SECONDS = 0.26;

const buildWordKey = (word: Pick<LiveWord, 'word' | 'start' | 'end'>) =>
  `${word.word}:${word.start.toFixed(3)}:${word.end.toFixed(3)}`;

const applyWordTimingLead = (start: number, end: number) => {
  const duration = Math.max(0.02, end - start);
  const ledStart = Math.max(0, start + WORD_TIMING_LEAD_SECONDS);

  return {
    start: ledStart,
    end: ledStart + duration,
  };
};

const mergeWords = (current: LiveWord[], incoming: LiveWord[]) => {
  if (incoming.length === 0) {
    return current;
  }

  const seen = new Set(current.map(buildWordKey));
  const next = [...current];

  incoming.forEach((word) => {
    const key = buildWordKey(word);

    if (!seen.has(key)) {
      seen.add(key);
      next.push(word);
    }
  });

  const newestEnd = next[next.length - 1]?.end ?? 0;

  if (newestEnd === 0) {
    return next;
  }

  return next.filter((word) => word.end >= newestEnd - TRANSCRIPT_RETENTION_SECONDS);
};

const buildTranscriptWords = (
  data: DeepgramMessage,
  elapsedSeconds: number,
  nextSequenceId: () => number,
) => {
  const alternative = data.channel?.alternatives?.[0];
  const transcriptWords = alternative?.words ?? [];
  const transcriptText = alternative?.transcript?.trim() ?? '';
  const messageDuration = typeof data.duration === 'number' ? Math.max(0, data.duration) : 0;
  const messageStart =
    typeof data.start === 'number'
      ? Math.max(0, data.start)
      : Math.max(0, elapsedSeconds - Math.max(messageDuration, 0.8));
  const messageEnd = messageDuration > 0 ? messageStart + messageDuration : elapsedSeconds;

  if (transcriptWords.length > 0) {
    const earliestWordStart = Math.min(...transcriptWords.map((word) => word.start));
    const latestWordEnd = Math.max(...transcriptWords.map((word) => word.end));
    const shouldOffsetWords =
      typeof data.start === 'number' &&
      (latestWordEnd <= messageDuration + 0.35 ||
        earliestWordStart < Math.max(0.3, messageStart * 0.5));
    const wordBase = shouldOffsetWords ? messageStart : 0;

    return transcriptWords.map((word) => {
      const ledWord = applyWordTimingLead(wordBase + word.start, wordBase + word.end);

      return {
        word: word.punctuated_word || word.word,
        start: ledWord.start,
        end: ledWord.end,
        id: `${ledWord.start}-${ledWord.end}-${nextSequenceId()}`,
      };
    });
  }

  if (!transcriptText) {
    return [];
  }

  const tokens = transcriptText.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return [];
  }

  const syntheticDuration = Math.max(messageEnd - messageStart, 0.9);
  const tokenDuration = syntheticDuration / tokens.length;

  return tokens.map((token, index) => {
    const start = messageStart + index * tokenDuration;
    const end = index === tokens.length - 1 ? messageStart + syntheticDuration : start + tokenDuration;
    const ledWord = applyWordTimingLead(start, end);

    return {
      word: token,
      start: ledWord.start,
      end: ledWord.end,
      id: `${ledWord.start}-${ledWord.end}-${nextSequenceId()}`,
    };
  });
};

const convertAudioBufferToLinear16 = (buffer: AudioBuffer, targetSampleRate: number) => {
  const sampleRate = buffer.sampleRate;
  const channelCount = buffer.numberOfChannels;
  const channelData = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index));
  const sourceLength = channelData[0]?.length ?? 0;

  if (sourceLength === 0) {
    return new ArrayBuffer(0);
  }

  const sampleRatio = sampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(sourceLength / sampleRatio));
  const output = new Int16Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * sampleRatio);
    const end = Math.min(sourceLength, Math.floor((outputIndex + 1) * sampleRatio));
    const safeEnd = Math.max(start + 1, end);
    let sampleSum = 0;
    let frameCount = 0;

    for (let frameIndex = start; frameIndex < safeEnd; frameIndex += 1) {
      let mixedSample = 0;

      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        mixedSample += channelData[channelIndex][frameIndex] ?? 0;
      }

      sampleSum += mixedSample / channelCount;
      frameCount += 1;
    }

    const averagedSample = frameCount > 0 ? sampleSum / frameCount : 0;
    const clampedSample = Math.max(-1, Math.min(1, averagedSample));

    output[outputIndex] = clampedSample < 0 ? clampedSample * 32768 : clampedSample * 32767;
  }

  return output.buffer;
};

const transcriptStateMeta: Record<
  TranscriptStatus,
  { label: string; className: string; detail: string }
> = {
  disabled: {
    label: 'Optional',
    className: 'border border-[var(--line)] text-[var(--text-muted)]',
    detail: 'Realtime speech is offline, but capture and editing stay fully available.',
  },
  ready: {
    label: 'Ready',
    className:
      'border border-[rgba(45,212,191,0.22)] bg-[rgba(45,212,191,0.1)] text-[var(--accent)]',
    detail: 'Speech capture is armed and will attach when the buffer starts.',
  },
  connecting: {
    label: 'Connecting',
    className:
      'border border-[rgba(247,185,85,0.22)] bg-[rgba(247,185,85,0.1)] text-[var(--warm)]',
    detail: 'Opening the realtime speech stream. Audio capture continues either way.',
  },
  live: {
    label: 'Live',
    className:
      'border border-[rgba(45,212,191,0.22)] bg-[rgba(45,212,191,0.12)] text-[var(--accent)]',
    detail: 'Audio is buffering and incoming words are being aligned live.',
  },
  unavailable: {
    label: 'Unavailable',
    className:
      'border border-[rgba(251,113,133,0.22)] bg-[rgba(251,113,133,0.1)] text-[var(--danger)]',
    detail: 'Speech services were not available. Recording and trim editing are still active.',
  },
};

export default function ClipWorkbench() {
  const { isHost, loadSounds, mics } = useAudio();

  const [selectedDevice, setSelectedDevice] = useState('none');
  const [desktopSources, setDesktopSources] = useState<DesktopSource[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [transcriptStatus, setTranscriptStatus] = useState<TranscriptStatus>('disabled');
  const [isEngineRunning, setIsEngineRunning] = useState(false);
  const [finalWords, setFinalWords] = useState<LiveWord[]>([]);
  const [interimWords, setInterimWords] = useState<LiveWord[]>([]);
  const [workingBlob, setWorkingBlob] = useState<Blob | null>(null);
  const [activePreviewSnapshot, setActivePreviewSnapshot] = useState<PreviewSnapshot | null>(null);
  const [bufferWindow, setBufferWindow] = useState<BufferWindow>({
    start: 0,
    end: 0,
    duration: 0,
  });
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null);
  const [hasManualSelection, setHasManualSelection] = useState(false);
  const [isFollowingLive, setIsFollowingLive] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(72);
  const [clipName, setClipName] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [transcriptMessage, setTranscriptMessage] = useState(
    'Live words will appear on the timeline when speech capture is available.',
  );

  const engineStartedAtRef = useRef<number | null>(null);
  const originalStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const transcriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptSilenceRef = useRef<GainNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const volumeHistoryRef = useRef<number[]>(new Array(120).fill(0));
  const headerChunkRef = useRef<Blob | null>(null);
  const chunksRef = useRef<TimedChunk[]>([]);
  const transcriptSocketRef = useRef<WebSocket | null>(null);
  const bufferWindowRef = useRef<BufferWindow>({ start: 0, end: 0, duration: 0 });
  const selectionRangeRef = useRef<SelectionRange | null>(null);
  const hasManualSelectionRef = useRef(false);
  const shouldFollowLiveEdgeRef = useRef(true);
  const isRenderingBufferRef = useRef(false);
  const pendingBufferElapsedRef = useRef<number | null>(null);
  const latestPreviewSnapshotRef = useRef<PreviewSnapshot | null>(null);
  const isTimelineInteractingRef = useRef(false);
  const lastBufferCommitRef = useRef(0);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const toggleEngineCommandRef = useRef<() => Promise<void>>(async () => undefined);
  const markClipCommandRef = useRef<() => Promise<void>>(async () => undefined);
  const wordSequenceRef = useRef(0);

  const transcriptMeta = transcriptStateMeta[transcriptStatus];
  const sourceCount = mics.length + desktopSources.length;
  const hasConfiguredApiKey = apiKey.trim().length > 0;
  const timelineWords = useMemo(
    () =>
      finalWords
        .filter((word) => word.end >= bufferWindow.start && word.start <= bufferWindow.end)
        .sort((left, right) => left.start - right.start),
    [bufferWindow.end, bufferWindow.start, finalWords],
  );
  const hasLiveInterimWords = useMemo(
    () =>
      interimWords.some((word) => word.end >= bufferWindow.start && word.start <= bufferWindow.end),
    [bufferWindow.end, bufferWindow.start, interimWords],
  );
  const relativeSelection = useMemo(() => {
    if (!selectionRange || bufferWindow.duration <= 0) {
      return null;
    }

    const start = Math.max(0, selectionRange.start - bufferWindow.start);
    const end = Math.min(bufferWindow.duration, selectionRange.end - bufferWindow.start);

    if (end - start < 0.05) {
      return null;
    }

    return { start, end, duration: end - start };
  }, [bufferWindow.duration, bufferWindow.start, selectionRange]);
  const alignedSelectionWords = useMemo(() => {
    if (!selectionRange) {
      return '';
    }

    return finalWords
      .filter((word) => word.end >= selectionRange.start && word.start <= selectionRange.end)
      .map((word) => word.word)
      .join(' ')
      .trim();
  }, [finalWords, selectionRange]);

  useEffect(() => {
    bufferWindowRef.current = bufferWindow;
  }, [bufferWindow]);

  useEffect(() => {
    selectionRangeRef.current = selectionRange;
  }, [selectionRange]);

  useEffect(() => {
    hasManualSelectionRef.current = hasManualSelection;
  }, [hasManualSelection]);

  const updateFollowLive = useCallback((nextFollowLive: boolean) => {
    shouldFollowLiveEdgeRef.current = nextFollowLive;
    setIsFollowingLive(nextFollowLive);
  }, []);

  const clearMeter = useCallback(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    context?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const applyPreviewSnapshot = useCallback(
    (
      snapshot: PreviewSnapshot,
      options: {
        followLive?: boolean;
        forceLatestSelection?: boolean;
      } = {},
    ) => {
      const { followLive = shouldFollowLiveEdgeRef.current, forceLatestSelection = false } = options;
      const nextWindow = snapshot.window;
      const currentSelection = selectionRangeRef.current;

      setActivePreviewSnapshot(snapshot);
      setWorkingBlob(snapshot.blob);
      setBufferWindow(nextWindow);

      if (forceLatestSelection || !hasManualSelectionRef.current || !currentSelection) {
        const autoSelection = {
          start: Math.max(
            nextWindow.start,
            nextWindow.end - Math.min(DEFAULT_SELECTION_SECONDS, nextWindow.duration),
          ),
          end: nextWindow.end,
        };

        setSelectionRange(autoSelection);
        selectionRangeRef.current = autoSelection;
        return;
      }

      if (followLive) {
        const selectionDuration = Math.max(
          0.25,
          currentSelection.end - currentSelection.start,
        );
        const liveSelection = {
          start: Math.max(nextWindow.start, nextWindow.end - selectionDuration),
          end: nextWindow.end,
        };

        setSelectionRange(liveSelection);
        selectionRangeRef.current = liveSelection;
        return;
      }

      const clampedSelection = {
        start: Math.max(currentSelection.start, nextWindow.start),
        end: Math.min(currentSelection.end, nextWindow.end),
      };

      if (clampedSelection.end - clampedSelection.start < 0.05) {
        const fallbackSelection = {
          start: Math.max(
            nextWindow.start,
            nextWindow.end - Math.min(DEFAULT_SELECTION_SECONDS, nextWindow.duration),
          ),
          end: nextWindow.end,
        };

        setSelectionRange(fallbackSelection);
        selectionRangeRef.current = fallbackSelection;
        setHasManualSelection(false);
        hasManualSelectionRef.current = false;
        return;
      }

      setSelectionRange(clampedSelection);
      selectionRangeRef.current = clampedSelection;
    },
    [],
  );

  const handleTimelineSelectionChange = useCallback((nextSelection: SelectionRange) => {
    if (!hasManualSelectionRef.current) {
      setHasManualSelection(true);
      hasManualSelectionRef.current = true;
    }

    if (shouldFollowLiveEdgeRef.current) {
      updateFollowLive(false);
    }

    setSelectionRange(nextSelection);
    selectionRangeRef.current = nextSelection;
  }, [updateFollowLive]);

  const handleTimelineSelectionCommit = useCallback(() => {
    setTranscriptMessage(
      'Selection updated. Drag the handles to refine the trim, or hold Ctrl while dragging to paint a new range.',
    );
  }, []);

  const handleTimelineInteractionChange = useCallback((isInteracting: boolean) => {
    isTimelineInteractingRef.current = isInteracting;
  }, []);

  const handleTimelineFollowChange = useCallback(
    (nextFollowLive: boolean) => {
      updateFollowLive(nextFollowLive);

      if (nextFollowLive && latestPreviewSnapshotRef.current) {
        applyPreviewSnapshot(latestPreviewSnapshotRef.current, { followLive: true });
      }
    },
    [applyPreviewSnapshot, updateFollowLive],
  );

  const focusLatestSelection = useCallback(
    (seconds = DEFAULT_SELECTION_SECONDS) => {
      const latestSnapshot = latestPreviewSnapshotRef.current;
      const currentBuffer = latestSnapshot?.window ?? bufferWindowRef.current;

      if (currentBuffer.duration <= 0) {
        return;
      }

      setHasManualSelection(true);
      hasManualSelectionRef.current = true;
      updateFollowLive(true);

      if (latestSnapshot) {
        applyPreviewSnapshot(latestSnapshot, {
          followLive: true,
          forceLatestSelection: true,
        });
      } else {
        const end = currentBuffer.end;
        const start = Math.max(currentBuffer.start, end - Math.min(seconds, currentBuffer.duration));
        const nextSelection = { start, end };

        setSelectionRange(nextSelection);
        selectionRangeRef.current = nextSelection;
      }

      setTranscriptMessage('Selection snapped to the live edge so you can trim the latest moment.');
    },
    [applyPreviewSnapshot, updateFollowLive],
  );

  const stopPreviewAudio = useCallback(() => {
    const previewAudio = previewAudioRef.current;

    if (previewAudio) {
      previewAudio.pause();
      previewAudio.currentTime = 0;
      previewAudio.onended = null;
      previewAudio.onerror = null;
    }

    previewAudioRef.current = null;

    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    setIsPlaying(false);
  }, []);

  const commitRollingBuffer = useCallback(
    async (
      elapsedSeconds: number,
      options: {
        forceRender?: boolean;
        forceVisibleRefresh?: boolean;
      } = {},
    ) => {
      const { forceRender = false, forceVisibleRefresh = false } = options;

      if (!headerChunkRef.current || chunksRef.current.length === 0) {
        return;
      }

      if (isRenderingBufferRef.current && !forceRender) {
        pendingBufferElapsedRef.current = elapsedSeconds;
        return;
      }

      isRenderingBufferRef.current = true;

      const nextBlob = new Blob(
        [headerChunkRef.current, ...chunksRef.current.map((chunk) => chunk.blob)],
        { type: 'audio/webm' },
      );

      try {
        const audioContext = createAudioContext();

        try {
          const arrayBuffer = await nextBlob.arrayBuffer();
          const decodedData = await audioContext.decodeAudioData(arrayBuffer);
          const wavBlob = encodeWav(decodedData);
          const audioDuration = decodedData.duration;
          const nextWindowEnd = elapsedSeconds;
          const nextWindowStart = Math.max(0, nextWindowEnd - audioDuration);
          const snapshot = {
            blob: wavBlob,
            window: {
              start: nextWindowStart,
              end: nextWindowEnd,
              duration: audioDuration,
            },
            peaks: Array.from({ length: decodedData.numberOfChannels }, (_, index) =>
              decodedData.getChannelData(index),
            ),
            audioDuration,
          };

          latestPreviewSnapshotRef.current = snapshot;

          if (
            (shouldFollowLiveEdgeRef.current && !isTimelineInteractingRef.current) ||
            !bufferWindowRef.current.duration ||
            forceVisibleRefresh
          ) {
            applyPreviewSnapshot(snapshot, {
              followLive: shouldFollowLiveEdgeRef.current,
            });
          }
        } finally {
          if (audioContext.state !== 'closed') {
            await audioContext.close().catch(() => undefined);
          }
        }
      } catch (error) {
        console.error('Failed to refresh the rolling waveform:', error);
      } finally {
        isRenderingBufferRef.current = false;

        if (pendingBufferElapsedRef.current !== null) {
          const pendingElapsed = pendingBufferElapsedRef.current;
          pendingBufferElapsedRef.current = null;
          void commitRollingBuffer(pendingElapsed, { forceRender: true, forceVisibleRefresh });
        }
      }
    },
    [applyPreviewSnapshot],
  );

  const stopTranscriptStream = useCallback(
    (statusOverride?: TranscriptStatus) => {
      const socket = transcriptSocketRef.current;

      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;

        if (socket.readyState < WebSocket.CLOSING) {
          socket.close();
        }
      }

      transcriptSocketRef.current = null;
      setInterimWords([]);
      setTranscriptStatus(statusOverride ?? (apiKey.trim() ? 'ready' : 'disabled'));
    },
    [apiKey],
  );

  const startTranscriptStream = useCallback(
    (keyOverride?: string) => {
      if (!isHost) {
        setTranscriptStatus('disabled');
        return;
      }

      const token = (keyOverride ?? apiKey).trim();

      if (!token) {
        setTranscriptStatus('disabled');
        return;
      }

      stopTranscriptStream('connecting');

      const socket = new WebSocket(
        `wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&interim_results=true&encoding=linear16&sample_rate=${TRANSCRIPT_SAMPLE_RATE}&channels=1`,
        ['token', token],
      );

      transcriptSocketRef.current = socket;

      socket.onopen = () => {
        setTranscriptStatus('live');
      };

      socket.onmessage = (message) => {
        const data = JSON.parse(message.data) as DeepgramMessage;
        const elapsedSeconds = engineStartedAtRef.current
          ? (performance.now() - engineStartedAtRef.current) / 1000
          : 0;
        const nextWords = buildTranscriptWords(data, elapsedSeconds, () => wordSequenceRef.current++);

        if (data.is_final) {
          setFinalWords((current) => mergeWords(current, nextWords));
          setInterimWords([]);
          return;
        }

        setInterimWords(nextWords);
      };

      socket.onerror = () => {
        setInterimWords([]);
        setTranscriptStatus('unavailable');
      };

      socket.onclose = () => {
        if (transcriptSocketRef.current !== socket) {
          return;
        }

        transcriptSocketRef.current = null;
        setInterimWords([]);
        setTranscriptStatus((current) =>
          current === 'unavailable' ? 'unavailable' : token ? 'ready' : 'disabled',
        );
      };
    },
    [apiKey, isHost, stopTranscriptStream],
  );

  const saveApiKey = useCallback(
    (value: string) => {
      setApiKey(value);
      window.localStorage.setItem('deepgram-key', value);

      if (!isEngineRunning) {
        setTranscriptStatus(value.trim() ? 'ready' : 'disabled');
        return;
      }

      if (!value.trim()) {
        stopTranscriptStream('disabled');
        return;
      }

      if (!transcriptSocketRef.current) {
        startTranscriptStream(value);
      }
    },
    [isEngineRunning, startTranscriptStream, stopTranscriptStream],
  );

  const stopEngine = useCallback(async () => {
    stopPreviewAudio();

    if (engineStartedAtRef.current && headerChunkRef.current && chunksRef.current.length > 0) {
      await commitRollingBuffer((performance.now() - engineStartedAtRef.current) / 1000, {
        forceRender: true,
        forceVisibleRefresh: true,
      });
    }

    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }

    mediaRecorderRef.current = null;

    originalStreamRef.current?.getTracks().forEach((track) => track.stop());
    originalStreamRef.current = null;

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (transcriptProcessorRef.current) {
      transcriptProcessorRef.current.onaudioprocess = null;
      transcriptProcessorRef.current.disconnect();
    }

    transcriptProcessorRef.current = null;

    if (transcriptSilenceRef.current) {
      transcriptSilenceRef.current.disconnect();
    }

    transcriptSilenceRef.current = null;

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close().catch(() => undefined);
    }

    audioContextRef.current = null;
    lastBufferCommitRef.current = 0;
    pendingBufferElapsedRef.current = null;
    isRenderingBufferRef.current = false;
    latestPreviewSnapshotRef.current = null;
    engineStartedAtRef.current = null;
    isTimelineInteractingRef.current = false;
    updateFollowLive(true);
    clearMeter();
    stopTranscriptStream();
    setIsEngineRunning(false);
  }, [clearMeter, commitRollingBuffer, stopPreviewAudio, stopTranscriptStream, updateFollowLive]);

  const startEngine = useCallback(async () => {
    if (selectedDevice === 'none') {
      alert('Select a capture source first.');
      return;
    }

    try {
      let stream: MediaStream;

      if (selectedDevice.startsWith('desktop:')) {
        const sourceId = selectedDevice.replace('desktop:', '');
        const desktopAudio: DesktopMediaTrackConstraints = {
          mandatory: { chromeMediaSource: 'desktop' },
        };
        const desktopVideo: DesktopMediaTrackConstraints = {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
          },
        };

        stream = await navigator.mediaDevices.getUserMedia({
          audio: desktopAudio,
          video: desktopVideo,
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: selectedDevice },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      const audioTrack = stream.getAudioTracks()[0];

      if (!audioTrack) {
        stream.getTracks().forEach((track) => track.stop());
        alert(
          'No audio track was captured. If you are grabbing an app window, make sure it is producing sound.',
        );
        return;
      }

      originalStreamRef.current = stream;
      engineStartedAtRef.current = performance.now();
      lastBufferCommitRef.current = 0;
      pendingBufferElapsedRef.current = null;
      isRenderingBufferRef.current = false;
      latestPreviewSnapshotRef.current = null;
      headerChunkRef.current = null;
      chunksRef.current = [];
      wordSequenceRef.current = 0;
      isTimelineInteractingRef.current = false;
      selectionRangeRef.current = null;
      bufferWindowRef.current = { start: 0, end: 0, duration: 0 };
      hasManualSelectionRef.current = false;
      updateFollowLive(true);
      stopPreviewAudio();
      setActivePreviewSnapshot(null);
      setFinalWords([]);
      setInterimWords([]);
      setWorkingBlob(null);
      setBufferWindow({ start: 0, end: 0, duration: 0 });
      setSelectionRange(null);
      setHasManualSelection(false);
      setClipName('');
      setTranscriptMessage(
        hasConfiguredApiKey
          ? 'The rolling editor is live. Drag the region or make a new one directly on the waveform.'
          : 'Realtime speech is optional. The rolling editor still stays live without a speech key.',
      );

      const audioStream = new MediaStream([audioTrack]);
      const audioContext = createAudioContext();
      const source = audioContext.createMediaStreamSource(audioStream);
      const analyser = audioContext.createAnalyser();
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const transcriptProcessor = audioContext.createScriptProcessor(4096, 2, 1);
      const transcriptSilence = audioContext.createGain();

      analyser.fftSize = 256;
      transcriptSilence.gain.value = 0;
      source.connect(analyser);
      source.connect(transcriptProcessor);
      transcriptProcessor.connect(transcriptSilence);
      transcriptSilence.connect(audioContext.destination);
      audioContextRef.current = audioContext;
      transcriptProcessorRef.current = transcriptProcessor;
      transcriptSilenceRef.current = transcriptSilence;

      transcriptProcessor.onaudioprocess = (event) => {
        const socket = transcriptSocketRef.current;

        if (socket?.readyState !== WebSocket.OPEN) {
          return;
        }

        const linear16Chunk = convertAudioBufferToLinear16(
          event.inputBuffer,
          TRANSCRIPT_SAMPLE_RATE,
        );

        if (linear16Chunk.byteLength > 0) {
          socket.send(linear16Chunk);
        }
      };

      const drawMeter = () => {
        analyser.getByteFrequencyData(dataArray);
        const averageLevel =
          dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;

        volumeHistoryRef.current.push(averageLevel);
        volumeHistoryRef.current.shift();

        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');

        if (canvas && context) {
          context.clearRect(0, 0, canvas.width, canvas.height);
          const barWidth = canvas.width / volumeHistoryRef.current.length;

          volumeHistoryRef.current.forEach((value, index) => {
            const barHeight = Math.max(8, (value / 128) * canvas.height);
            const gradient = context.createLinearGradient(0, canvas.height, 0, 0);
            gradient.addColorStop(0, 'rgba(45, 212, 191, 0.36)');
            gradient.addColorStop(0.7, 'rgba(45, 212, 191, 0.82)');
            gradient.addColorStop(1, 'rgba(247, 185, 85, 0.98)');
            context.fillStyle = gradient;
            context.fillRect(
              index * barWidth,
              canvas.height - barHeight,
              Math.max(2, barWidth - 1.5),
              barHeight,
            );
          });
        }

        animationFrameRef.current = requestAnimationFrame(drawMeter);
      };

      drawMeter();

      const recorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });

      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) {
          return;
        }

        const elapsedSeconds = engineStartedAtRef.current
          ? (performance.now() - engineStartedAtRef.current) / 1000
          : 0;

        if (!headerChunkRef.current) {
          headerChunkRef.current = event.data;
        } else {
          chunksRef.current.push({ blob: event.data, capturedAt: elapsedSeconds });
          chunksRef.current = chunksRef.current.filter(
            (chunk) => elapsedSeconds - chunk.capturedAt <= BUFFER_SECONDS,
          );
        }

        if (
          headerChunkRef.current &&
          chunksRef.current.length > 0 &&
          (elapsedSeconds - lastBufferCommitRef.current >= 1 ||
            lastBufferCommitRef.current === 0)
        ) {
          lastBufferCommitRef.current = elapsedSeconds;
          void commitRollingBuffer(elapsedSeconds);
        }

      };

      mediaRecorderRef.current = recorder;
      recorder.start(RECORDER_TIMESLICE_MS);
      setIsEngineRunning(true);

      if (hasConfiguredApiKey) {
        startTranscriptStream();
      } else {
        setTranscriptStatus('disabled');
      }
    } catch (error) {
      console.error(error);
      await stopEngine();
      alert('Capture failed. Verify the source is available and permissions are allowed.');
    }
  }, [
    commitRollingBuffer,
    hasConfiguredApiKey,
    selectedDevice,
    startTranscriptStream,
    stopEngine,
    stopPreviewAudio,
    updateFollowLive,
  ]);

  const toggleEngine = useCallback(async () => {
    if (isEngineRunning) {
      await stopEngine();
      return;
    }

    await startEngine();
  }, [isEngineRunning, startEngine, stopEngine]);

  const handleToggleClick = useCallback(async () => {
    if (!isHost) {
      alert('The live rolling editor runs on the desktop host so it can keep the raw audio buffer.');
      return;
    }

    await toggleEngine();
  }, [isHost, toggleEngine]);

  const saveClip = useCallback(async () => {
    if (!workingBlob || !clipName.trim() || !relativeSelection) {
      return;
    }

    setIsSaving(true);

    try {
      const trimmedWav = await sliceAndExportAudio(
        workingBlob,
        relativeSelection.start,
        relativeSelection.end,
      );
      const safeName = clipName.replace(/[^a-z0-9]+/gi, '_');
      const file = new File([trimmedWav], `${safeName}_${Date.now()}.wav`, {
        type: 'audio/wav',
      });
      const formData = new FormData();

      formData.append('file', file);
      formData.append('category', 'Uncategorized');

      const response = await fetch('/api/upload', { method: 'POST', body: formData });

      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(error?.error ?? 'Upload failed.');
      }

      await loadSounds();
      setTranscriptMessage('Clip rendered and added to the soundboard.');
    } catch (error) {
      console.error(error);
      alert('The trim could not be saved to the board.');
    } finally {
      setIsSaving(false);
    }
  }, [clipName, loadSounds, relativeSelection, workingBlob]);

  useEffect(() => {
    const savedKey = window.localStorage.getItem('deepgram-key');
    const envKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;
    const initialKey = savedKey || envKey || '';

    setApiKey(initialKey);
    setTranscriptStatus(initialKey ? 'ready' : 'disabled');

    if (!isHost || !window.electronAPI) {
      return;
    }

    void window.electronAPI.getDesktopSources().then(setDesktopSources);
  }, [isHost]);

  useEffect(() => {
    toggleEngineCommandRef.current = handleToggleClick;
    markClipCommandRef.current = async () => {
      focusLatestSelection();
    };
  }, [focusLatestSelection, handleToggleClick]);

  useEffect(() => {
    if (!isHost || !window.electronAPI) {
      return;
    }

    window.electronAPI.onEngineCommand((command: string) => {
      if (command === 'toggle') {
        void toggleEngineCommandRef.current();
      }

      if (command === 'mark') {
        void markClipCommandRef.current();
      }
    });
  }, [isHost]);

  useEffect(() => {
    return () => {
      void stopEngine();
    };
  }, [stopEngine]);

  useEffect(() => {
    if (!clipName.trim() && alignedSelectionWords) {
      setClipName(alignedSelectionWords.slice(0, 72));
    }
  }, [alignedSelectionWords, clipName]);

  useEffect(() => stopPreviewAudio, [stopPreviewAudio]);

  const handlePreviewToggle = async () => {
    if (isPlaying) {
      stopPreviewAudio();
      return;
    }

    if (!workingBlob || !relativeSelection) {
      return;
    }

    try {
      const previewStart =
        relativeSelection.duration >= MIN_PREVIEW_SECONDS
          ? relativeSelection.start
          : Math.max(
              0,
              relativeSelection.start - (MIN_PREVIEW_SECONDS - relativeSelection.duration) / 2,
            );
      const previewEnd = Math.min(
        activePreviewSnapshot?.audioDuration ?? bufferWindow.duration,
        Math.max(relativeSelection.end, previewStart + MIN_PREVIEW_SECONDS),
      );
      const trimmedWav = await sliceAndExportAudio(
        workingBlob,
        previewStart,
        previewEnd,
      );

      stopPreviewAudio();

      const previewUrl = URL.createObjectURL(trimmedWav);
      const previewAudio = new Audio(previewUrl);

      previewAudioRef.current = previewAudio;
      previewUrlRef.current = previewUrl;
      previewAudio.onended = () => {
        stopPreviewAudio();
      };
      previewAudio.onerror = () => {
        stopPreviewAudio();
        setTranscriptMessage('Preview playback was unavailable for this trim range.');
      };

      await previewAudio.play();
      setIsPlaying(true);
    } catch {
      stopPreviewAudio();
      setTranscriptMessage('Preview playback was unavailable for this trim range.');
    }
  };

  return (
    <div className="flex min-h-full flex-col gap-6 py-2">
      <section className="panel-surface p-6 sm:p-8">
        <p className="eyebrow mb-3">Unified Clipper</p>
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <h2 className="font-[var(--font-display)] text-3xl font-semibold tracking-[-0.05em] text-[var(--text-strong)] sm:text-4xl">
              Watch the rolling waveform update live, see word timing on that same timeline, and
              trim directly from the buffer.
            </h2>
            <p className="mt-4 text-base text-[var(--text-muted)]">
              The editor now stays hot while you record, so you can scroll, zoom, and shape the
              live buffer without taking a separate snapshot first.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <div className="metric-card">
              <span className="metric-label">Buffer</span>
              <strong className="metric-value">{BUFFER_SECONDS}s</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Sources</span>
              <strong className="metric-value">{sourceCount}</strong>
            </div>
            <div className="metric-card col-span-2 lg:col-span-1">
              <span className="metric-label">Speech</span>
              <strong className="metric-value text-[1.05rem]">{transcriptMeta.label}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="grid min-w-0 gap-5 2xl:grid-cols-[0.78fr_minmax(0,1.22fr)]">
        <div className="min-w-0 space-y-5">
          <div className="panel-surface p-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[rgba(45,212,191,0.24)] bg-[rgba(45,212,191,0.1)] text-[var(--accent)]">
                <Mic size={18} />
              </div>
              <div>
                <p className="eyebrow mb-1">Capture Deck</p>
                <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                  Arm the source once, then trim directly from the rolling buffer.
                </h3>
              </div>
            </div>

            {!process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY && (
              <div className="panel-soft mb-5 p-4">
                <div className="mb-3 flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[rgba(247,185,85,0.24)] bg-[rgba(247,185,85,0.1)] text-[var(--warm)]">
                    <KeyRound size={18} />
                  </div>
                  <div>
                    <p className="eyebrow mb-1">Optional Speech Key</p>
                    <p className="text-sm text-[var(--text-muted)]">
                      Leave this blank if you only want audio capture and editing.
                    </p>
                  </div>
                </div>

                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => saveApiKey(event.target.value)}
                  placeholder="Enter Deepgram token"
                  className="field"
                />
              </div>
            )}

            <select
              className="select-field"
              value={selectedDevice}
              onChange={(event) => setSelectedDevice(event.target.value)}
              disabled={isEngineRunning || !isHost}
            >
              <option value="none">
                {isHost ? 'Select a screen, app, or microphone' : 'Managed by the host desktop'}
              </option>
              {isHost && (
                <>
                  <optgroup label="Screens & App Windows">
                    {desktopSources.map((source) => (
                      <option key={source.id} value={`desktop:${source.id}`}>
                        {source.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Audio Inputs">
                    {mics.map((mic) => (
                      <option key={mic.deviceId} value={mic.deviceId}>
                        {mic.label || `Microphone ${mic.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </optgroup>
                </>
              )}
            </select>

            <div className="panel-soft mt-5 overflow-hidden p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-[var(--text-base)]">
                  <Waves size={16} className="text-[var(--accent)]" />
                  Live audio meter
                </div>
                <span className={`rounded-full px-3 py-1 text-xs ${transcriptMeta.className}`}>
                  {isEngineRunning ? `Buffer ${transcriptMeta.label}` : transcriptMeta.label}
                </span>
              </div>
              <div className="relative h-24 overflow-hidden rounded-[1.2rem] border border-[var(--line)] bg-[rgba(4,8,14,0.86)]">
                {!isEngineRunning && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs uppercase tracking-[0.24em] text-[var(--text-muted)]">
                    Waiting for source
                  </div>
                )}
                <canvas ref={canvasRef} width={560} height={96} className="h-full w-full" />
              </div>
              <p className="mt-3 text-sm text-[var(--text-muted)]">{transcriptMeta.detail}</p>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void handleToggleClick()}
                className={isEngineRunning ? 'danger-button' : 'accent-button'}
              >
                <Radio size={16} />
                {isEngineRunning ? 'Stop Buffer' : 'Start Buffer'}
              </button>

              <button
                type="button"
                onClick={() => focusLatestSelection()}
                className="ghost-button"
                disabled={!workingBlob}
              >
                <Bookmark size={16} />
                Latest 8s
              </button>
            </div>
          </div>
        </div>

        <div className="panel-surface flex min-h-[40rem] min-w-0 flex-col overflow-hidden p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="eyebrow mb-1">Rolling Editor</p>
              <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                Scroll the live buffer, drag a range, and render that exact section.
              </h3>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-3 py-1 text-xs ${transcriptMeta.className}`}>
                {transcriptMeta.label}
              </span>
              <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs text-[var(--text-muted)]">
                {relativeSelection
                  ? `${relativeSelection.duration.toFixed(2)}s selected`
                  : 'No active selection'}
              </span>
              <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs text-[var(--text-muted)]">
                {bufferWindow.duration > 0
                  ? `${bufferWindow.duration.toFixed(1)}s buffered`
                  : 'Buffer idle'}
              </span>
            </div>
          </div>

          {workingBlob ? (
            <div className="flex min-h-0 flex-1 flex-col gap-5">
              <input
                type="text"
                value={clipName}
                onChange={(event) => setClipName(event.target.value)}
                placeholder="Name your clip"
                className="field"
              />

              <div className="panel-soft overflow-hidden p-1.5">
                <LiveTimelineEditor
                  snapshot={activePreviewSnapshot}
                  bufferWindow={bufferWindow}
                  selectionRange={selectionRange}
                  timelineWords={timelineWords}
                  hasLiveInterimWords={hasLiveInterimWords}
                  transcriptStatus={transcriptStatus}
                  zoomLevel={zoomLevel}
                  followLive={isFollowingLive}
                  onZoomChange={setZoomLevel}
                  onFollowLiveChange={handleTimelineFollowChange}
                  onInteractionChange={handleTimelineInteractionChange}
                  onSelectionChange={handleTimelineSelectionChange}
                  onSelectionCommit={handleTimelineSelectionCommit}
                />
              </div>

              <div className="grid gap-3 xl:grid-cols-[1fr_auto_auto]">
                <div className="panel-soft flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-[var(--text-muted)]">Selection window</span>
                  <strong className="font-[var(--font-display)] text-lg tracking-[-0.04em] text-[var(--text-strong)]">
                    {relativeSelection
                      ? `${relativeSelection.start.toFixed(2)}s - ${relativeSelection.end.toFixed(2)}s`
                      : 'Adjust trim handles'}
                  </strong>
                </div>

                <button type="button" onClick={handlePreviewToggle} className="ghost-button">
                  {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                  {isPlaying ? 'Pause Preview' : 'Preview Trim'}
                </button>

                <button
                  type="button"
                  onClick={() => focusLatestSelection()}
                  className="ghost-button"
                >
                  <Bookmark size={16} />
                  Jump to Live Edge
                </button>
              </div>

              <p className="text-xs text-[var(--text-muted)]">
                Mouse wheel zooms, middle-mouse drag pans, and the live view only reattaches when
                you push all the way back to the live edge or use the live-edge button. The words
                now share the exact same timeline math as the waveform so they stay locked to the
                trim surface.
              </p>

              <div className="panel-soft p-4">
                <p className="eyebrow mb-2">Aligned Words</p>
                <p className="min-h-20 text-sm text-[var(--text-base)]">
                  {alignedSelectionWords ||
                    'Resize the trim handles to see the live words that line up with that exact slice of audio.'}
                </p>
                <p className="mt-3 text-xs text-[var(--text-muted)]">{transcriptMessage}</p>
              </div>

              <button
                type="button"
                onClick={() => void saveClip()}
                className="accent-button mt-auto"
                disabled={isSaving || !relativeSelection}
              >
                {isSaving ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Save size={16} />
                )}
                {isSaving ? 'Rendering Clip' : 'Save to Soundboard'}
              </button>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-[1.6rem] border border-dashed border-[var(--line-strong)] bg-[rgba(255,255,255,0.02)] p-10 text-center">
              <div className="max-w-md">
                <p className="eyebrow mb-3">Ready for Capture</p>
                <h4 className="font-[var(--font-display)] text-3xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                  Start the buffer and the live trim surface will begin filling automatically.
                </h4>
                <p className="mt-3 text-sm text-[var(--text-muted)]">
                  Once audio is flowing, zoom the waveform, drag a region, inspect the aligned
                  words, and render the exact slice you want.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
