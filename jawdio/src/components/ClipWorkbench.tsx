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
  Scissors,
  Waves,
} from 'lucide-react';

import { useAudio } from '@/context/AudioContext';
import { createAudioContext, encodeWav, sliceAndExportAudio } from '@/lib/audio';
import LiveTimelineEditor from '@/components/LiveTimelineEditor';
import {
  CLIPPER_BUFFER_SECONDS,
  CLIPPER_PUBLISH_INTERVAL_MS,
  TIMELINE_PEAK_BUCKETS,
  type ClipperSyncCommand,
  type ClipperSyncSnapshot,
  type ClipperSyncTimelinePeaks,
  type ClipperSyncVolumeHistory,
  type ClipperSyncWord,
} from '@/lib/engine-sync';

type DesktopMediaTrackConstraints = MediaTrackConstraints & {
  mandatory: {
    chromeMediaSource: 'desktop';
    chromeMediaSourceId?: string;
  };
};

type AudioElementWithSink = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
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
  blob: Blob | null;
  window: BufferWindow;
  peaks: Array<Float32Array | number[]>;
  audioDuration: number;
  sampleRate: number;
  sampleCount: number;
  circularWriteIndex?: number;
}

interface LiveWaveformState {
  peaks: Float32Array[];
  capacity: number;
  writeIndex: number;
  sampleCount: number;
  sampleRate: number;
  bucketCount: number;
  processedFrames: number;
  sourceSampleRate: number;
  processorFrameCount: number;
}

const BUFFER_SECONDS = 60;
const RECORDER_TIMESLICE_MS = 250;
const AUDIO_PROCESSOR_BUFFER_SIZE = 2048;
const LIVE_WAVEFORM_BUCKET_COUNT = 32;
const TRANSCRIPT_RETENTION_SECONDS = 240;
const DEFAULT_SELECTION_SECONDS = 8;
const MIN_PREVIEW_SECONDS = 0.35;
const TRANSCRIPT_SAMPLE_RATE = 16000;
const WORD_TIMING_LEAD_SECONDS = 0;

const createLiveWaveformState = (
  channelCount: number,
  sourceSampleRate: number,
  processorFrameCount: number,
): LiveWaveformState => {
  const bucketCount = Math.max(
    1,
    Math.min(LIVE_WAVEFORM_BUCKET_COUNT, Math.floor(processorFrameCount / 8)),
  );
  const samplesPerProcessorBuffer = bucketCount * 2;
  const effectiveSampleRate = (sourceSampleRate * samplesPerProcessorBuffer) / processorFrameCount;
  const capacity = Math.max(
    samplesPerProcessorBuffer,
    Math.floor((BUFFER_SECONDS * effectiveSampleRate) / 2) * 2,
  );

  return {
    peaks: Array.from({ length: channelCount }, () => new Float32Array(capacity)),
    capacity,
    writeIndex: 0,
    sampleCount: 0,
    sampleRate: effectiveSampleRate,
    bucketCount,
    processedFrames: 0,
    sourceSampleRate,
    processorFrameCount,
  };
};

const appendLiveWaveformPeaks = (state: LiveWaveformState, buffer: AudioBuffer) => {
  if (buffer.numberOfChannels === 0 || buffer.length === 0) {
    return;
  }

  const nextWriteIndex = state.writeIndex;
  const nextWriteValues = state.bucketCount * 2;

  for (let channelIndex = 0; channelIndex < state.peaks.length; channelIndex += 1) {
    const samples = buffer.getChannelData(channelIndex);
    for (let bucketIndex = 0; bucketIndex < state.bucketCount; bucketIndex += 1) {
      const bucketStart = Math.floor((bucketIndex / state.bucketCount) * samples.length);
      const bucketEnd = Math.max(
        bucketStart + 1,
        Math.floor(((bucketIndex + 1) / state.bucketCount) * samples.length),
      );
      let min = 1;
      let max = -1;

      for (let sampleIndex = bucketStart; sampleIndex < bucketEnd; sampleIndex += 1) {
        const sample = samples[sampleIndex];

        if (sample < min) {
          min = sample;
        }

        if (sample > max) {
          max = sample;
        }
      }

      const minIndex = (nextWriteIndex + bucketIndex * 2) % state.capacity;
      const maxIndex = (minIndex + 1) % state.capacity;

      state.peaks[channelIndex][minIndex] = min;
      state.peaks[channelIndex][maxIndex] = max;
    }
  }

  state.writeIndex = (nextWriteIndex + nextWriteValues) % state.capacity;
  state.sampleCount = Math.min(state.capacity, state.sampleCount + nextWriteValues);
  state.processedFrames += buffer.length;
};

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
  /**
   * Engine-elapsed seconds at the moment Deepgram received its first audio
   * frame. Added to data.start so words land on the same time axis as the
   * waveform peaks (data.start is relative to Deepgram's stream start, not
   * the engine's).
   */
  streamOffsetSeconds: number = 0,
) => {
  const alternative = data.channel?.alternatives?.[0];
  const transcriptWords = alternative?.words ?? [];
  const transcriptText = alternative?.transcript?.trim() ?? '';
  const messageDuration = typeof data.duration === 'number' ? Math.max(0, data.duration) : 0;
  const messageStart =
    typeof data.start === 'number'
      ? Math.max(0, data.start + streamOffsetSeconds)
      : Math.max(0, elapsedSeconds - Math.max(messageDuration, 0.8));
  const messageEnd = messageDuration > 0 ? messageStart + messageDuration : elapsedSeconds;

  if (transcriptWords.length > 0) {
    const earliestWordStart = Math.min(...transcriptWords.map((word) => word.start));
    const latestWordEnd = Math.max(...transcriptWords.map((word) => word.end));
    const shouldOffsetWords =
      typeof data.start === 'number' &&
      (latestWordEnd <= messageDuration + 0.35 ||
        earliestWordStart < Math.max(0.3, messageStart * 0.5));
    // When messageStart is trusted, it already contains streamOffsetSeconds.
    // Otherwise, words come in Deepgram-relative time and need the offset
    // applied directly so they land on the engine-time axis.
    const wordBase = shouldOffsetWords ? messageStart : streamOffsetSeconds;

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

/**
 * Full Clipper mirror rendered on remote browsers. Subscribes to the host's
 * SSE stream at /engine/stream, holds the received state in React, and
 * renders the same panels the host shows. User actions are sent back to the
 * host as HTTP commands so the host's audio engine remains the single source
 * of truth.
 */
function ClipperRemoteController() {
  const hostHttpBase =
    typeof window !== 'undefined'
      ? `http://${window.location.hostname}:8080`
      : 'http://localhost:8080';

  const [snapshot, setSnapshot] = useState<ClipperSyncSnapshot>({});
  const [connection, setConnection] = useState<
    'connecting' | 'connected' | 'disconnected'
  >('connecting');
  const [busy, setBusy] = useState<string | null>(null);
  const [clipName, setClipName] = useState('');
  // True until the user types in the clip-name field. While true we
  // auto-overwrite the name from the currently-selected transcript words.
  const [clipNameAuto, setClipNameAuto] = useState(true);
  const [clipCategory, setClipCategory] = useState('Uncategorized');
  const [categories, setCategories] = useState<string[]>(['Uncategorized']);
  const [dragSelection, setDragSelection] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const meterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastSelectionSendRef = useRef<number>(0);
  const previousHostSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const pointerAnchorRef = useRef<number | null>(null);
  const minimapDragRef = useRef<{ pointerId: number; offsetSec: number } | null>(null);

  // Zoom state. 1x shows the whole buffer; higher values zoom into a sliding
  // window centered on viewCenterSec. When viewCenterSec is null we follow
  // the live edge automatically (zoom = 1x is also free-follow).
  const [zoomLevel, setZoomLevel] = useState(1);
  const [viewCenterSec, setViewCenterSec] = useState<number | null>(null);

  // When the host echoes back a selection different from our local drag
  // override, clear the local override so the canvas shows the host's truth
  // again. Prevents stale drag visuals after the host changes selection via
  // mark/quick-clip or another remote.
  useEffect(() => {
    const current = snapshot.selectionRange ?? null;
    const prev = previousHostSelectionRef.current;

    const differs =
      !current ||
      !prev ||
      Math.abs(current.start - prev.start) > 0.05 ||
      Math.abs(current.end - prev.end) > 0.05;

    if (differs && pointerAnchorRef.current === null) {
      setDragSelection(null);
    }

    previousHostSelectionRef.current = current;
  }, [snapshot.selectionRange]);

  // Open an EventSource to the host. Merge incoming partial snapshots into
  // local state. Reconnect with backoff if the stream drops.
  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let cancelled = false;

    const connect = () => {
      setConnection('connecting');
      source = new EventSource(`${hostHttpBase}/engine/stream`);

      source.onopen = () => {
        if (!cancelled) setConnection('connected');
      };

      source.onmessage = (event) => {
        try {
          const incoming = JSON.parse(event.data) as ClipperSyncSnapshot;
          setSnapshot((current) => ({ ...current, ...incoming }));
        } catch (error) {
          console.warn('Bad sync payload:', error);
        }
      };

      source.onerror = () => {
        if (cancelled) return;
        setConnection('disconnected');
        source?.close();
        // Backoff reconnect every 2s.
        reconnectTimer = window.setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [hostHttpBase]);

  // Volume-meter canvas. Mirrors the host's bar meter from volumeHistory
  // (120 entries, 0–255). Repaints whenever the host pushes a new snapshot.
  useEffect(() => {
    const canvas = meterCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const history = snapshot.volumeHistory;
    if (!history || history.length === 0) {
      ctx.fillStyle = 'rgba(180,210,234,0.18)';
      ctx.fillRect(0, height - 1, width, 1);
      return;
    }

    const barWidth = width / history.length;
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, 'rgba(62, 162, 230, 0.34)');
    gradient.addColorStop(0.7, 'rgba(62, 162, 230, 0.86)');
    gradient.addColorStop(1, 'rgba(127, 200, 240, 0.98)');
    ctx.fillStyle = gradient;

    for (let i = 0; i < history.length; i += 1) {
      const value = history[i] ?? 0;
      const barHeight = Math.max(2, (value / 128) * height);
      ctx.fillRect(
        i * barWidth,
        height - barHeight,
        Math.max(2, barWidth - 1.5),
        barHeight,
      );
    }
  }, [snapshot.volumeHistory]);

  // Use the timelinePeaks' time axis when present (it tracks the live edge
  // better than bufferWindow does) and fall back to bufferWindow otherwise.
  const timeAxis = useMemo(() => {
    if (snapshot.timelinePeaks && snapshot.timelinePeaks.endSec > snapshot.timelinePeaks.startSec) {
      return {
        start: snapshot.timelinePeaks.startSec,
        end: snapshot.timelinePeaks.endSec,
        duration: snapshot.timelinePeaks.endSec - snapshot.timelinePeaks.startSec,
      };
    }
    if (snapshot.bufferWindow && snapshot.bufferWindow.duration > 0) {
      return snapshot.bufferWindow;
    }
    return null;
  }, [snapshot.bufferWindow, snapshot.timelinePeaks]);

  /**
   * Visible slice of timeAxis after applying zoom + pan. zoom=1 returns the
   * full buffer (and tracks the live edge as the buffer scrolls forward).
   * Higher zoom levels narrow the window around viewCenterSec; when the user
   * hasn't explicitly panned, we keep the view glued to the live edge so the
   * latest audio is always visible.
   */
  const visibleAxis = useMemo(() => {
    if (!timeAxis) return null;
    if (zoomLevel <= 1) {
      return { ...timeAxis };
    }

    const visibleDuration = timeAxis.duration / zoomLevel;
    const followLive = viewCenterSec === null;
    const center = followLive
      ? timeAxis.end - visibleDuration / 2
      : viewCenterSec;

    let start = center - visibleDuration / 2;
    let end = center + visibleDuration / 2;

    // Clamp the visible window inside the actual buffer.
    if (start < timeAxis.start) {
      start = timeAxis.start;
      end = start + visibleDuration;
    }
    if (end > timeAxis.end) {
      end = timeAxis.end;
      start = end - visibleDuration;
    }

    return {
      start: Math.max(timeAxis.start, start),
      end: Math.min(timeAxis.end, end),
      duration: visibleDuration,
    };
  }, [timeAxis, viewCenterSec, zoomLevel]);

  const zoomInCentered = useCallback(() => {
    setZoomLevel((current) => Math.min(8, current * 2));
    if (!timeAxis) return;
    setViewCenterSec((current) => {
      const reference =
        dragSelection ?? snapshot.selectionRange ?? null;
      if (reference) {
        return (reference.start + reference.end) / 2;
      }
      return current ?? timeAxis.end - timeAxis.duration / 2;
    });
  }, [dragSelection, snapshot.selectionRange, timeAxis]);

  const zoomOut = useCallback(() => {
    setZoomLevel((current) => {
      const next = Math.max(1, current / 2);
      if (next <= 1) {
        setViewCenterSec(null);
      }
      return next;
    });
  }, []);

  const resetZoom = useCallback(() => {
    setZoomLevel(1);
    setViewCenterSec(null);
  }, []);

  const jumpToLiveEdge = useCallback(() => {
    setViewCenterSec(null);
  }, []);

  // Waveform canvas. Renders peaks + word tick lines + selection rectangle.
  // Repaints whenever any input changes.
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const peaks = snapshot.timelinePeaks;
    const halfHeight = height / 2;

    // Background centerline.
    ctx.fillStyle = 'rgba(180,210,234,0.12)';
    ctx.fillRect(0, halfHeight - 0.5, width, 1);

    if (peaks && peaks.bucketCount > 0 && visibleAxis && timeAxis) {
      // Map the visible time window onto bucket indices so we draw only the
      // peaks inside the zoomed view, stretched across the full canvas width.
      const pairs = peaks.bucketCount;
      const flat = peaks.bucketsFlat;
      const bucketSeconds = (peaks.endSec - peaks.startSec) / pairs;

      const firstBucket = Math.max(
        0,
        Math.floor((visibleAxis.start - peaks.startSec) / bucketSeconds),
      );
      const lastBucket = Math.min(
        pairs,
        Math.ceil((visibleAxis.end - peaks.startSec) / bucketSeconds),
      );
      const visibleBucketCount = Math.max(1, lastBucket - firstBucket);
      const pixelsPerBar = width / visibleBucketCount;

      ctx.fillStyle = 'rgba(62, 162, 230, 0.78)';
      for (let i = 0; i < visibleBucketCount; i += 1) {
        const bucketIndex = firstBucket + i;
        const min = flat[bucketIndex * 2] ?? 0;
        const max = flat[bucketIndex * 2 + 1] ?? 0;
        const top = halfHeight - max * halfHeight;
        const barHeight = Math.max(1, (max - min) * halfHeight);
        ctx.fillRect(i * pixelsPerBar, top, Math.max(1, pixelsPerBar - 0.5), barHeight);
      }
    }

    if (!visibleAxis) return;

    // Word boundary lines — bright ticks at each visible transcript word's
    // start and end so the user can see exactly which audio belongs to each
    // word. Drawn before the selection so the selection's overlay sits on top.
    const candidates = [
      ...((snapshot.finalWords ?? []) as ClipperSyncWord[]),
      ...((snapshot.interimWords ?? []) as ClipperSyncWord[]),
    ];
    ctx.fillStyle = 'rgba(127, 200, 240, 0.7)';
    for (const word of candidates) {
      if (word.end < visibleAxis.start || word.start > visibleAxis.end) continue;
      const startFrac = (word.start - visibleAxis.start) / visibleAxis.duration;
      const endFrac = (word.end - visibleAxis.start) / visibleAxis.duration;
      const x1 = Math.max(0, Math.min(1, startFrac)) * width;
      const x2 = Math.max(0, Math.min(1, endFrac)) * width;
      ctx.fillRect(x1, 0, 1, height);
      ctx.fillRect(x2 - 1, 0, 1, height);
    }

    // Selection overlay.
    const activeSelection = dragSelection ?? snapshot.selectionRange ?? null;

    if (activeSelection) {
      const selectionStartFrac =
        (activeSelection.start - visibleAxis.start) / visibleAxis.duration;
      const selectionEndFrac =
        (activeSelection.end - visibleAxis.start) / visibleAxis.duration;
      const left = Math.max(0, Math.min(1, selectionStartFrac)) * width;
      const right = Math.max(0, Math.min(1, selectionEndFrac)) * width;

      if (right > left) {
        ctx.fillStyle = 'rgba(127, 200, 240, 0.18)';
        ctx.fillRect(left, 0, right - left, height);

        ctx.fillStyle = 'rgba(127, 200, 240, 0.95)';
        ctx.fillRect(left - 1, 0, 2, height);
        ctx.fillRect(right - 1, 0, 2, height);

        // Solid handle "grips" near top and bottom so it's obvious the edges
        // are draggable.
        ctx.fillRect(left - 6, height / 2 - 14, 12, 28);
        ctx.fillRect(right - 6, height / 2 - 14, 12, 28);
      }
    }
  }, [
    dragSelection,
    snapshot.finalWords,
    snapshot.interimWords,
    snapshot.selectionRange,
    snapshot.timelinePeaks,
    timeAxis,
    visibleAxis,
  ]);

  const sendCommand = useCallback(
    async (path: string, label: string) => {
      setBusy(label);

      try {
        const response = await fetch(`${hostHttpBase}/engine/${path}`, {
          method: 'GET',
          cache: 'no-store',
        });

        if (!response.ok) {
          throw new Error(`Host rejected the command (HTTP ${response.status}).`);
        }
      } catch (error) {
        console.error('Remote command failed:', error);
      } finally {
        setBusy(null);
      }
    },
    [hostHttpBase],
  );

  const sendCommandPayload = useCallback(
    async (command: ClipperSyncCommand, label: string) => {
      setBusy(label);

      try {
        const response = await fetch(`${hostHttpBase}/engine/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command),
          cache: 'no-store',
        });

        if (!response.ok) {
          throw new Error(`Host rejected the command (HTTP ${response.status}).`);
        }
      } catch (error) {
        console.error('Remote command failed:', error);
      } finally {
        setBusy(null);
      }
    },
    [hostHttpBase],
  );

  /**
   * Pointer-driven drag on the waveform canvas. Translates pointer X into a
   * buffer-relative selection range and pushes throttled set-selection
   * commands to the host. Same gesture works for mouse and touch.
   * (pointerAnchorRef is declared higher up so the "clear local drag when
   * host echoes a different selection" effect can read it.)
   */
  const pointerToBufferTime = useCallback(
    (clientX: number, canvas: HTMLCanvasElement): number | null => {
      if (!visibleAxis) return null;
      const rect = canvas.getBoundingClientRect();
      const fraction = (clientX - rect.left) / rect.width;
      const clamped = Math.max(0, Math.min(1, fraction));
      return visibleAxis.start + clamped * visibleAxis.duration;
    },
    [visibleAxis],
  );

  const sendSelection = useCallback(
    async (start: number, end: number, immediate = false) => {
      const now = performance.now();
      if (!immediate && now - lastSelectionSendRef.current < 120) {
        return;
      }
      lastSelectionSendRef.current = now;

      try {
        await fetch(`${hostHttpBase}/engine/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'set-selection', start, end }),
          cache: 'no-store',
        });
      } catch (error) {
        console.error('Failed to push selection to host:', error);
      }
    },
    [hostHttpBase],
  );

  /**
   * Pointer-down on the waveform decides which gesture is starting:
   *   - hit zone around the LEFT edge of the current selection → resize-start
   *   - hit zone around the RIGHT edge → resize-end
   *   - inside the selection body → move whole selection
   *   - outside the selection → start a fresh selection
   *
   * dragModeRef carries the gesture state through pointer-move/up.
   */
  const dragModeRef = useRef<
    | { kind: 'paint'; anchorTime: number }
    | { kind: 'resize-start'; otherEdge: number }
    | { kind: 'resize-end'; otherEdge: number }
    | { kind: 'move'; offsetStart: number; offsetEnd: number; anchorTime: number }
    | null
  >(null);

  const handleWaveformPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget;
      const time = pointerToBufferTime(event.clientX, canvas);
      if (time === null || !timeAxis) return;

      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointerAnchorRef.current = time;

      // Decide gesture by where the pointer landed relative to the current
      // selection rectangle. Hit zone for handle is ±(handleSeconds) around
      // the edge — wide enough for a fingertip on mobile. Computed against
      // the visible window so the on-screen handle width stays roughly the
      // same number of pixels regardless of zoom level.
      const current = dragSelection ?? snapshot.selectionRange ?? null;
      const handleSeconds =
        (visibleAxis?.duration ?? timeAxis.duration) * 0.025;

      if (current && current.end > current.start) {
        const nearStart = Math.abs(time - current.start) <= handleSeconds;
        const nearEnd = Math.abs(time - current.end) <= handleSeconds;

        if (nearStart && (!nearEnd || time < current.start)) {
          dragModeRef.current = { kind: 'resize-start', otherEdge: current.end };
          return;
        }

        if (nearEnd) {
          dragModeRef.current = { kind: 'resize-end', otherEdge: current.start };
          return;
        }

        if (time > current.start && time < current.end) {
          dragModeRef.current = {
            kind: 'move',
            offsetStart: time - current.start,
            offsetEnd: current.end - time,
            anchorTime: time,
          };
          return;
        }
      }

      // Fresh paint gesture.
      dragModeRef.current = { kind: 'paint', anchorTime: time };
      setDragSelection({ start: time, end: time });
    },
    [dragSelection, pointerToBufferTime, snapshot.selectionRange, timeAxis, visibleAxis],
  );

  const handleWaveformPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const mode = dragModeRef.current;
      if (!mode) return;

      const canvas = event.currentTarget;
      const time = pointerToBufferTime(event.clientX, canvas);
      if (time === null || !timeAxis) return;

      let next: { start: number; end: number } | null = null;

      if (mode.kind === 'paint') {
        next = {
          start: Math.min(mode.anchorTime, time),
          end: Math.max(mode.anchorTime, time),
        };
      } else if (mode.kind === 'resize-start') {
        next = {
          start: Math.min(time, mode.otherEdge - 0.05),
          end: mode.otherEdge,
        };
      } else if (mode.kind === 'resize-end') {
        next = {
          start: mode.otherEdge,
          end: Math.max(time, mode.otherEdge + 0.05),
        };
      } else if (mode.kind === 'move') {
        const newStart = Math.max(timeAxis.start, time - mode.offsetStart);
        const newEnd = Math.min(timeAxis.end, newStart + (mode.offsetStart + mode.offsetEnd));
        next = { start: newStart, end: newEnd };
      }

      if (!next) return;
      setDragSelection(next);
      if (next.end - next.start > 0.05) {
        void sendSelection(next.start, next.end, false);
      }
    },
    [pointerToBufferTime, sendSelection, timeAxis],
  );

  const handleWaveformPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const mode = dragModeRef.current;
      dragModeRef.current = null;
      pointerAnchorRef.current = null;

      const canvas = event.currentTarget;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {}

      if (!mode || !timeAxis) return;

      const time = pointerToBufferTime(event.clientX, canvas);
      if (time === null) return;

      let final: { start: number; end: number };

      if (mode.kind === 'paint') {
        final = {
          start: Math.min(mode.anchorTime, time),
          end: Math.max(mode.anchorTime, time),
        };
        // Tap-without-drag → snap a half-second window around the tap.
        if (final.end - final.start < 0.05) {
          final.start = Math.max(timeAxis.start, final.start - 0.25);
          final.end = Math.min(timeAxis.end, final.start + 0.5);
        }
      } else if (mode.kind === 'resize-start') {
        final = {
          start: Math.min(time, mode.otherEdge - 0.05),
          end: mode.otherEdge,
        };
      } else if (mode.kind === 'resize-end') {
        final = {
          start: mode.otherEdge,
          end: Math.max(time, mode.otherEdge + 0.05),
        };
      } else {
        const newStart = Math.max(timeAxis.start, time - mode.offsetStart);
        const newEnd = Math.min(timeAxis.end, newStart + (mode.offsetStart + mode.offsetEnd));
        final = { start: newStart, end: newEnd };
      }

      // Keep dragSelection set so the visual doesn't blink. The
      // selectionRange-change effect clears it when the host echoes a different
      // selection back later.
      setDragSelection(final);
      void sendSelection(final.start, final.end, true);
    },
    [pointerToBufferTime, sendSelection, timeAxis],
  );

  const handleSaveClip = useCallback(() => {
    const range = snapshot.selectionRange;
    if (!range || !clipName.trim()) return;

    void sendCommandPayload(
      {
        type: 'save-clip',
        name: clipName.trim(),
        start: range.start,
        end: range.end,
        category: clipCategory,
      },
      'save-clip',
    );
    setClipName('');
    setClipNameAuto(true);
  }, [clipCategory, clipName, sendCommandPayload, snapshot.selectionRange]);

  /**
   * Preview-audio plumbing. Asks the host to render the current selection
   * as a WAV, then plays it back on this device's speakers. Uses a regular
   * <audio> element with the /engine/preview URL so the browser handles
   * fetch + decode without us shipping bytes through SSE.
   */
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'playing'>(
    'idle',
  );

  const stopPreview = useCallback(() => {
    const el = previewAudioRef.current;
    if (el) {
      el.onended = null;
      el.onerror = null;
      el.pause();
      el.src = '';
    }
    previewAudioRef.current = null;
    setPreviewState('idle');
  }, []);

  const handlePreview = useCallback(() => {
    if (previewState === 'playing' || previewState === 'loading') {
      stopPreview();
      return;
    }

    const range = dragSelection ?? snapshot.selectionRange ?? null;
    if (!range || range.end <= range.start) return;

    setPreviewState('loading');
    // Cache-bust so a repeated preview at the same range still re-fetches if
    // the user's selection or buffer has shifted since.
    const url = `${hostHttpBase}/engine/preview?start=${range.start}&end=${range.end}&t=${Date.now()}`;
    const audio = new Audio(url);
    previewAudioRef.current = audio;

    audio.onplaying = () => setPreviewState('playing');
    audio.onended = () => {
      previewAudioRef.current = null;
      setPreviewState('idle');
    };
    audio.onerror = () => {
      console.error('Preview audio failed to load.');
      previewAudioRef.current = null;
      setPreviewState('idle');
    };
    audio.play().catch((error) => {
      console.error('Preview audio play() rejected:', error);
      previewAudioRef.current = null;
      setPreviewState('idle');
    });
  }, [dragSelection, hostHttpBase, previewState, snapshot.selectionRange, stopPreview]);

  useEffect(() => stopPreview, [stopPreview]);

  /**
   * Fetch the soundboard's category list from the host's REST API. Refreshed
   * on a slow interval so new categories created on the host show up here
   * without a full reload.
   */
  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const response = await fetch('/api/sounds', { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as {
          library?: Record<string, unknown>;
        };
        const next = Object.keys(data.library ?? {});
        if (cancelled) return;
        const merged = next.includes('Uncategorized') ? next : ['Uncategorized', ...next];
        merged.sort((a, b) =>
          a === 'Uncategorized' ? -1 : b === 'Uncategorized' ? 1 : a.localeCompare(b),
        );
        setCategories(merged);
      } catch (error) {
        console.warn('Could not refresh soundboard categories:', error);
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 8_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  /**
   * Auto-name the clip from the words inside the active selection. The user
   * can still override by typing — once they do, clipNameAuto flips false and
   * we leave the field alone until they explicitly clear it.
   */
  const selectionWordsText = useMemo(() => {
    const range = dragSelection ?? snapshot.selectionRange ?? null;
    if (!range) return '';
    const candidates = (snapshot.finalWords ?? []) as ClipperSyncWord[];
    const insideSelection = candidates
      .filter((word) => word.end >= range.start && word.start <= range.end)
      .map((word) => word.word.trim())
      .filter(Boolean);
    if (insideSelection.length === 0) return '';
    return insideSelection.join(' ').slice(0, 72);
  }, [dragSelection, snapshot.finalWords, snapshot.selectionRange]);

  useEffect(() => {
    if (clipNameAuto && selectionWordsText) {
      setClipName(selectionWordsText);
    }
  }, [clipNameAuto, selectionWordsText]);

  const handleClipNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setClipName(event.target.value);
      setClipNameAuto(event.target.value.trim().length === 0);
    },
    [],
  );

  /**
   * Mini-map canvas. Renders the full buffer at low detail with a viewport
   * rectangle showing what slice of time the main waveform is currently
   * focused on. Lets the user pan when zoomed in without having to leave the
   * waveform area.
   */
  useEffect(() => {
    const canvas = minimapCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (!timeAxis) return;

    const peaks = snapshot.timelinePeaks;
    const halfHeight = height / 2;

    ctx.fillStyle = 'rgba(180,210,234,0.12)';
    ctx.fillRect(0, halfHeight - 0.5, width, 1);

    if (peaks && peaks.bucketCount > 0) {
      // Resample the peaks down to roughly one bar per canvas pixel.
      const targetBuckets = Math.min(peaks.bucketCount, width);
      const step = peaks.bucketCount / targetBuckets;
      const pixelsPerBar = width / targetBuckets;

      ctx.fillStyle = 'rgba(62, 162, 230, 0.5)';
      for (let i = 0; i < targetBuckets; i += 1) {
        const sourceStart = Math.floor(i * step);
        const sourceEnd = Math.max(sourceStart + 1, Math.floor((i + 1) * step));
        let bucketMin = 0;
        let bucketMax = 0;
        for (let p = sourceStart; p < sourceEnd && p < peaks.bucketCount; p += 1) {
          const min = peaks.bucketsFlat[p * 2] ?? 0;
          const max = peaks.bucketsFlat[p * 2 + 1] ?? 0;
          if (min < bucketMin) bucketMin = min;
          if (max > bucketMax) bucketMax = max;
        }
        const top = halfHeight - bucketMax * halfHeight;
        const barHeight = Math.max(1, (bucketMax - bucketMin) * halfHeight);
        ctx.fillRect(i * pixelsPerBar, top, Math.max(1, pixelsPerBar - 0.3), barHeight);
      }
    }

    if (visibleAxis) {
      const startFrac = (visibleAxis.start - timeAxis.start) / timeAxis.duration;
      const endFrac = (visibleAxis.end - timeAxis.start) / timeAxis.duration;
      const left = Math.max(0, Math.min(1, startFrac)) * width;
      const right = Math.max(0, Math.min(1, endFrac)) * width;

      ctx.fillStyle = 'rgba(127, 200, 240, 0.16)';
      ctx.fillRect(left, 0, Math.max(2, right - left), height);

      ctx.strokeStyle = 'rgba(127, 200, 240, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left + 0.75, 0.75, Math.max(2, right - left) - 1.5, height - 1.5);
    }
  }, [snapshot.timelinePeaks, timeAxis, visibleAxis]);

  /**
   * Drag the mini-map viewport rectangle to pan the main waveform. We snap
   * the rectangle's CENTER to the pointer (with an offset if the user grabs
   * away from the centre) and clamp against the full-buffer bounds.
   */
  const minimapPointerToTime = useCallback(
    (clientX: number, canvas: HTMLCanvasElement): number | null => {
      if (!timeAxis) return null;
      const rect = canvas.getBoundingClientRect();
      const fraction = (clientX - rect.left) / rect.width;
      const clamped = Math.max(0, Math.min(1, fraction));
      return timeAxis.start + clamped * timeAxis.duration;
    },
    [timeAxis],
  );

  const handleMinimapPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!timeAxis || zoomLevel <= 1) return;
      const canvas = event.currentTarget;
      const time = minimapPointerToTime(event.clientX, canvas);
      if (time === null) return;

      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);

      const currentCenter =
        viewCenterSec ?? (visibleAxis ? (visibleAxis.start + visibleAxis.end) / 2 : time);
      // If the pointer hit inside the existing viewport rectangle, preserve
      // the offset so the rectangle slides under the finger smoothly. If it
      // hit outside, jump the centre to the pointer.
      const insideViewport =
        visibleAxis && time >= visibleAxis.start && time <= visibleAxis.end;
      const offsetSec = insideViewport ? currentCenter - time : 0;

      minimapDragRef.current = { pointerId: event.pointerId, offsetSec };
      setViewCenterSec(time + offsetSec);
    },
    [minimapPointerToTime, timeAxis, viewCenterSec, visibleAxis, zoomLevel],
  );

  const handleMinimapPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = minimapDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const canvas = event.currentTarget;
      const time = minimapPointerToTime(event.clientX, canvas);
      if (time === null) return;

      setViewCenterSec(time + drag.offsetSec);
    },
    [minimapPointerToTime],
  );

  const handleMinimapPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {}
      minimapDragRef.current = null;
    },
    [],
  );

  /**
   * Words that fall inside the currently-visible buffer window, projected
   * onto the canvas's 0–1 fraction space and stacked into a small number of
   * lanes when they overlap horizontally. Mirrors what the host renders on
   * its own LiveTimelineEditor.
   */
  const visibleWords = useMemo(() => {
    if (!visibleAxis) return [];

    const candidates = [
      ...((snapshot.finalWords ?? []) as ClipperSyncWord[]).map((w) => ({
        ...w,
        interim: false,
      })),
      ...((snapshot.interimWords ?? []) as ClipperSyncWord[]).map((w) => ({
        ...w,
        interim: true,
      })),
    ];

    const inWindow = candidates
      .filter((word) => word.end >= visibleAxis.start && word.start <= visibleAxis.end)
      .sort((a, b) => a.start - b.start);

    const laneEndTimes: number[] = [];
    const MAX_LANES = 4;
    const MIN_GAP = 0.05;

    return inWindow.map((word) => {
      const xFrac =
        (Math.max(word.start, visibleAxis.start) - visibleAxis.start) / visibleAxis.duration;
      const endFrac =
        (Math.min(word.end, visibleAxis.end) - visibleAxis.start) / visibleAxis.duration;
      const wFrac = Math.max(0.005, endFrac - xFrac);

      // Greedy lane assignment.
      let lane = laneEndTimes.findIndex((endTime) => endTime <= word.start);
      if (lane === -1) {
        if (laneEndTimes.length < MAX_LANES) {
          lane = laneEndTimes.length;
          laneEndTimes.push(0);
        } else {
          // Out of lanes — reuse the lane that ends earliest.
          lane = 0;
          for (let i = 1; i < laneEndTimes.length; i += 1) {
            if (laneEndTimes[i] < laneEndTimes[lane]) lane = i;
          }
        }
      }
      laneEndTimes[lane] = word.end + MIN_GAP;

      return {
        id: word.id,
        word: word.word,
        xFrac,
        wFrac,
        lane,
        interim: word.interim,
      };
    });
  }, [snapshot.finalWords, snapshot.interimWords, visibleAxis]);

  const elapsedSec = snapshot.elapsedSeconds ?? null;
  const elapsedLabel = elapsedSec == null
    ? '--:--'
    : `${Math.floor(elapsedSec / 60).toString().padStart(2, '0')}:${Math.floor(elapsedSec % 60)
        .toString()
        .padStart(2, '0')}`;
  const finalWords = (snapshot.finalWords ?? []) as ClipperSyncWord[];
  const interimWords = (snapshot.interimWords ?? []) as ClipperSyncWord[];
  const selectionRange = snapshot.selectionRange ?? null;
  const isRunning = snapshot.isEngineRunning === true;

  return (
    <div className="flex min-h-full flex-col gap-3 py-2">
      <section className="panel-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow mb-1">Clipper · Remote view</p>
            <h1 className="font-[var(--font-display)] text-xl font-semibold tracking-[-0.03em] text-[var(--text-strong)]">
              {snapshot.sourceLabel || 'No source selected on host'}
            </h1>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {connection === 'connected' && 'Live mirror of the host Clipper.'}
              {connection === 'connecting' && 'Connecting to host…'}
              {connection === 'disconnected' &&
                'Lost connection. Retrying every 2 seconds.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
                isRunning
                  ? 'border-[rgba(62,162,230,0.45)] bg-[rgba(62,162,230,0.14)] text-[var(--accent)]'
                  : 'border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--text-muted)]'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  isRunning ? 'bg-[var(--accent)]' : 'bg-[var(--text-muted)]'
                }`}
              />
              {isRunning ? 'Engine live' : 'Engine stopped'}
            </span>
            <span className="font-mono text-base text-[var(--text-strong)]">
              {elapsedLabel}
            </span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void sendCommand('toggle', 'Toggle engine')}
            disabled={busy === 'Toggle engine'}
            className={`${
              isRunning ? 'danger-button' : 'accent-button'
            } w-full justify-center`}
          >
            {isRunning ? <Pause size={14} /> : <Play size={14} />}
            {isRunning ? 'Stop on host' : 'Start on host'}
          </button>
          <button
            type="button"
            onClick={() => void sendCommand('mark', 'Mark on host')}
            disabled={!isRunning || busy === 'Mark on host'}
            className="ghost-button w-full justify-center"
          >
            <Bookmark size={14} />
            Mark latest moment
          </button>
        </div>
      </section>

      <section className="panel-surface p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="eyebrow">Live meter</p>
          <span
            className={`rounded-full border px-2.5 py-[1px] text-[10px] uppercase tracking-[0.14em] ${
              snapshot.transcriptStatus === 'live'
                ? 'border-[rgba(62,162,230,0.45)] bg-[rgba(62,162,230,0.14)] text-[var(--accent)]'
                : 'border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--text-muted)]'
            }`}
          >
            Transcript: {snapshot.transcriptStatus ?? 'disabled'}
          </span>
        </div>
        <div className="relative h-16 overflow-hidden rounded-md border border-[var(--line)] bg-[rgba(4,8,14,0.86)] sm:h-20">
          {!isRunning && (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-[0.24em] text-[var(--text-muted)]">
              Waiting for the host&apos;s engine to start
            </div>
          )}
          <canvas
            ref={meterCanvasRef}
            width={720}
            height={96}
            className="h-full w-full"
          />
        </div>
      </section>

      <section className="panel-surface p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="eyebrow">Waveform · Drag to select</p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={zoomOut}
              disabled={zoomLevel <= 1}
              title="Zoom out"
              className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[12px] text-[var(--text-base)] transition hover:border-[var(--line-strong)] hover:text-[var(--text-strong)] disabled:opacity-40"
            >
              −
            </button>
            <span className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
              {zoomLevel.toFixed(0)}x
            </span>
            <button
              type="button"
              onClick={zoomInCentered}
              disabled={zoomLevel >= 8 || !timeAxis}
              title="Zoom in"
              className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[12px] text-[var(--text-base)] transition hover:border-[var(--line-strong)] hover:text-[var(--text-strong)] disabled:opacity-40"
            >
              +
            </button>
            <button
              type="button"
              onClick={resetZoom}
              disabled={zoomLevel === 1 && viewCenterSec === null}
              title="Reset zoom and follow live edge"
              className="ml-1 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--text-base)] transition hover:border-[var(--line-strong)] hover:text-[var(--text-strong)] disabled:opacity-40"
            >
              1x
            </button>
            {zoomLevel > 1 && (
              <button
                type="button"
                onClick={jumpToLiveEdge}
                disabled={viewCenterSec === null}
                title="Snap the view to the live edge"
                className="rounded-md border border-[rgba(62,162,230,0.32)] bg-[rgba(62,162,230,0.1)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--accent)] transition hover:border-[rgba(62,162,230,0.5)] disabled:opacity-40"
              >
                Live
              </button>
            )}
          </div>
        </div>
        <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
          {visibleAxis && timeAxis
            ? `Viewing ${visibleAxis.duration.toFixed(1)}s of ${timeAxis.duration.toFixed(1)}s buffered`
            : snapshot.bufferWindow
              ? `${snapshot.bufferWindow.duration.toFixed(1)}s in buffer`
              : 'No buffer'}
        </div>
        <div className="relative h-40 overflow-hidden rounded-md border border-[var(--line)] bg-[rgba(4,8,14,0.86)] sm:h-44">
          {!snapshot.timelinePeaks && (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-[0.24em] text-[var(--text-muted)]">
              {isRunning
                ? 'Building buffer…'
                : 'Start the engine on the host to see the waveform.'}
            </div>
          )}
          <canvas
            ref={waveformCanvasRef}
            width={1280}
            height={176}
            className="h-full w-full touch-none cursor-crosshair"
            onPointerDown={handleWaveformPointerDown}
            onPointerMove={handleWaveformPointerMove}
            onPointerUp={handleWaveformPointerUp}
            onPointerCancel={handleWaveformPointerUp}
          />

          {/* Word overlay. Positioned in fraction-of-buffer-window space so it
             tracks the canvas as the buffer rolls. */}
          <div className="pointer-events-none absolute inset-0">
            {visibleWords.map((word) => (
              <span
                key={word.id}
                className={`absolute truncate rounded px-1 py-[1px] text-[9px] font-medium leading-tight ${
                  word.interim
                    ? 'border border-[rgba(246,196,75,0.35)] bg-[rgba(246,196,75,0.15)] text-[var(--warm)]'
                    : 'border border-[rgba(62,162,230,0.4)] bg-[rgba(62,162,230,0.22)] text-[var(--text-strong)]'
                }`}
                style={{
                  left: `${word.xFrac * 100}%`,
                  width: `${word.wFrac * 100}%`,
                  minWidth: '14px',
                  top: `${4 + word.lane * 14}px`,
                }}
                title={word.word}
              >
                {word.word}
              </span>
            ))}
          </div>
        </div>
        <div
          className={`relative mt-2 h-10 overflow-hidden rounded-md border ${
            zoomLevel > 1
              ? 'border-[rgba(62,162,230,0.4)] bg-[rgba(4,8,14,0.86)] cursor-grab active:cursor-grabbing'
              : 'border-[var(--line)] bg-[rgba(4,8,14,0.6)] opacity-70'
          }`}
          title={
            zoomLevel > 1
              ? 'Drag to pan the waveform'
              : 'Zoom in (+) to enable panning'
          }
        >
          <canvas
            ref={minimapCanvasRef}
            width={1280}
            height={40}
            className="h-full w-full touch-none"
            onPointerDown={handleMinimapPointerDown}
            onPointerMove={handleMinimapPointerMove}
            onPointerUp={handleMinimapPointerUp}
            onPointerCancel={handleMinimapPointerUp}
          />
        </div>
        <p className="mt-2 text-[11px] text-[var(--text-muted)]">
          Drag anywhere on the waveform to pick a clip range. Use the +/− buttons
          to zoom in for fine selections, then drag the strip below to pan.
        </p>
      </section>

      <section className="panel-surface p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="eyebrow">Live transcript</p>
          {interimWords.length > 0 && (
            <span className="rounded-full border border-[rgba(246,196,75,0.32)] bg-[rgba(246,196,75,0.1)] px-2 py-[1px] text-[10px] uppercase tracking-[0.14em] text-[var(--warm)]">
              Listening
            </span>
          )}
        </div>
        <div className="max-h-48 overflow-y-auto rounded-md border border-[var(--line)] bg-[rgba(4,8,14,0.6)] p-3 text-sm leading-relaxed">
          {finalWords.length === 0 && interimWords.length === 0 ? (
            <p className="text-[var(--text-muted)]">
              {isRunning
                ? 'Listening for speech…'
                : 'Start the engine on the host (or from here) to begin transcription.'}
            </p>
          ) : (
            <p className="text-[var(--text-strong)]">
              {finalWords.map((word) => `${word.word} `)}
              {interimWords.length > 0 && (
                <span className="text-[var(--text-muted)] italic">
                  {interimWords.map((word) => `${word.word} `).join('')}
                </span>
              )}
            </p>
          )}
        </div>
      </section>

      <section className="panel-surface p-4">
        <p className="eyebrow mb-2">Buffer · Selection</p>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-2">
            <p className="text-[var(--text-muted)]">Buffer window</p>
            <p className="font-mono text-[var(--text-strong)]">
              {snapshot.bufferWindow
                ? `${snapshot.bufferWindow.start.toFixed(1)} → ${snapshot.bufferWindow.end.toFixed(1)} s`
                : '—'}
            </p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-2">
            <p className="text-[var(--text-muted)]">Selection</p>
            <p className="font-mono text-[var(--text-strong)]">
              {selectionRange
                ? `${selectionRange.start.toFixed(1)} → ${selectionRange.end.toFixed(1)} s`
                : '—'}
            </p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-2">
            <p className="text-[var(--text-muted)]">Duration</p>
            <p className="font-mono text-[var(--text-strong)]">
              {selectionRange
                ? `${(selectionRange.end - selectionRange.start).toFixed(2)} s`
                : '—'}
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={clipName}
            onChange={handleClipNameChange}
            placeholder="Clip name (auto-filled from words in selection)"
            className="field flex-1 min-w-[180px]"
          />
          <select
            value={categories.includes(clipCategory) ? clipCategory : 'Uncategorized'}
            onChange={(event) => setClipCategory(event.target.value)}
            className="select-field w-full sm:w-auto"
            title="Soundboard category to file this clip under"
          >
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handlePreview}
            disabled={!(dragSelection ?? snapshot.selectionRange) || previewState === 'loading'}
            className="ghost-button"
          >
            {previewState === 'playing' ? <Pause size={14} /> : <Play size={14} />}
            {previewState === 'loading'
              ? 'Loading…'
              : previewState === 'playing'
                ? 'Stop preview'
                : 'Preview'}
          </button>
          <button
            type="button"
            onClick={handleSaveClip}
            disabled={!selectionRange || !clipName.trim() || busy === 'save-clip'}
            className="accent-button"
          >
            <Save size={14} />
            Save selection
          </button>
        </div>

        <p className="mt-2 text-[11px] text-[var(--text-muted)]">
          Use Mark on the host (or here) to snap the selection to the live edge,
          then save with a name. Clip lands in the host&apos;s Uncategorized
          category and syncs to all connected devices.
        </p>
      </section>

      <section className="panel-surface p-4">
        <p className="eyebrow mb-2">Quick save (last N seconds)</p>
        <div className="grid grid-cols-3 gap-2">
          {[10, 30, 60].map((seconds) => (
            <button
              key={seconds}
              type="button"
              onClick={() =>
                void sendCommand(`clip-last-${seconds}`, `Quick ${seconds}s`)
              }
              disabled={!isRunning || busy === `Quick ${seconds}s`}
              className="ghost-button justify-center"
            >
              <Scissors size={13} />
              Last {seconds}s
            </button>
          ))}
        </div>
      </section>

      {snapshot.statusMessage && (
        <p className="text-xs text-[var(--text-muted)]">{snapshot.statusMessage}</p>
      )}
    </div>
  );
}

export default function ClipWorkbench() {
  const { isHost, loadSounds, mics, previewOutputId, soundLibrary } = useAudio();

  // Categories for the save-to dropdown. Always pin "Uncategorized" first
  // and alphabetize the rest.
  const categoryOptions = useMemo(() => {
    const keys = Object.keys(soundLibrary);
    const ordered = keys.includes('Uncategorized') ? keys : ['Uncategorized', ...keys];
    ordered.sort((a, b) =>
      a === 'Uncategorized' ? -1 : b === 'Uncategorized' ? 1 : a.localeCompare(b),
    );
    return ordered;
  }, [soundLibrary]);

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
  const [clipCategory, setClipCategory] = useState('Uncategorized');
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
  // Engine-elapsed seconds at the moment the Deepgram socket received its
  // first audio frame. Deepgram timestamps words relative to its OWN clock
  // (starting at 0 when its first sample arrives), so we need to add this
  // offset to bring word times back onto the same axis as the waveform peaks.
  const transcriptStreamOffsetRef = useRef<number>(0);
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
  const latestCommittedSnapshotRef = useRef<PreviewSnapshot | null>(null);
  const liveWaveformRef = useRef<LiveWaveformState | null>(null);
  const isTimelineInteractingRef = useRef(false);
  const lastBufferCommitRef = useRef(0);
  const stopEngineRef = useRef<() => Promise<void>>(async () => undefined);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const toggleEngineCommandRef = useRef<() => Promise<void>>(async () => undefined);
  const markClipCommandRef = useRef<() => Promise<void>>(async () => undefined);
  // Ref so the engine-command IPC handler always sees the latest saveQuickClip
  // closure (which captures isEngineRunning + getRenderableBlob, etc.).
  const quickClipCommandRef = useRef<(durationSec: number) => Promise<void>>(
    async () => undefined,
  );
  const saveClipCommandRef = useRef<() => Promise<void>>(async () => undefined);
  const getRenderableBlobRef = useRef<() => Promise<Blob | null>>(async () => null);
  // One-time IPC registration guards. Without these, hot reloads / dependency
  // changes would re-run the registration effects and stack listeners on top
  // of each other — every fired IPC then runs the handler N times, causing
  // duplicated clip saves and other ghost actions.
  const engineCommandRegisteredRef = useRef(false);
  const engineCommandPayloadRegisteredRef = useRef(false);
  const enginePreviewRequestRegisteredRef = useRef(false);
  // Set by the engine-command-payload handler when a remote includes a
  // category in its save command. saveClip / saveQuickClip read this ref to
  // know where to file the clip; it's reset after each save so subsequent
  // host-side saves go back to Uncategorized unless explicitly overridden.
  const categoryOverrideRef = useRef<string | null>(null);
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
        skipSelection?: boolean;
      } = {},
    ) => {
      const {
        followLive = shouldFollowLiveEdgeRef.current,
        forceLatestSelection = false,
        skipSelection = false,
      } = options;
      const nextWindow = snapshot.window;
      const currentSelection = selectionRangeRef.current;

      setActivePreviewSnapshot(snapshot);
      latestPreviewSnapshotRef.current = snapshot;
      bufferWindowRef.current = nextWindow;

      if (snapshot.blob) {
        setWorkingBlob(snapshot.blob);
      }

      setBufferWindow(nextWindow);

      if (skipSelection) {
        return;
      }

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

  const publishLiveWaveformSnapshot = useCallback(() => {
    const liveWaveform = liveWaveformRef.current;

    if (!liveWaveform || liveWaveform.sampleCount === 0) {
      return;
    }

    const audioDuration = liveWaveform.sampleCount / liveWaveform.sampleRate;
    const audioEnd = liveWaveform.processedFrames / liveWaveform.sourceSampleRate;
    const snapshot = {
      blob: null,
      window: {
        start: Math.max(0, audioEnd - audioDuration),
        end: audioEnd,
        duration: audioDuration,
      },
      peaks: liveWaveform.peaks,
      audioDuration,
      sampleRate: liveWaveform.sampleRate,
      sampleCount: liveWaveform.sampleCount,
      circularWriteIndex:
        liveWaveform.sampleCount === liveWaveform.capacity
          ? liveWaveform.writeIndex
          : undefined,
    };

    applyPreviewSnapshot(snapshot, {
      followLive: shouldFollowLiveEdgeRef.current,
      skipSelection: isTimelineInteractingRef.current,
    });
  }, [applyPreviewSnapshot]);

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
        return null;
      }

      if (isRenderingBufferRef.current && !forceRender) {
        pendingBufferElapsedRef.current = elapsedSeconds;
        return null;
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
            sampleRate: decodedData.sampleRate,
            sampleCount: decodedData.length,
          };

          latestCommittedSnapshotRef.current = snapshot;
          setWorkingBlob(snapshot.blob);

          if (forceVisibleRefresh || !latestPreviewSnapshotRef.current) {
            applyPreviewSnapshot(snapshot, {
              followLive: shouldFollowLiveEdgeRef.current,
              skipSelection: isTimelineInteractingRef.current && !forceVisibleRefresh,
            });
          }

          return snapshot;
        } finally {
          if (audioContext.state !== 'closed') {
            await audioContext.close().catch(() => undefined);
          }
        }
      } catch (error) {
        console.error('Failed to refresh the rolling waveform:', error);
        return null;
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
        const nextWords = buildTranscriptWords(
          data,
          elapsedSeconds,
          () => wordSequenceRef.current++,
          transcriptStreamOffsetRef.current,
        );

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
    liveWaveformRef.current = null;
    engineStartedAtRef.current = null;
    transcriptStreamOffsetRef.current = 0;
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
      transcriptStreamOffsetRef.current = 0;
      lastBufferCommitRef.current = 0;
      pendingBufferElapsedRef.current = null;
      isRenderingBufferRef.current = false;
      latestPreviewSnapshotRef.current = null;
      latestCommittedSnapshotRef.current = null;
      liveWaveformRef.current = null;
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
      const transcriptProcessor = audioContext.createScriptProcessor(
        AUDIO_PROCESSOR_BUFFER_SIZE,
        2,
        1,
      );
      const transcriptSilence = audioContext.createGain();

      analyser.fftSize = 256;
      transcriptSilence.gain.value = 0;
      source.connect(analyser);
      source.connect(transcriptProcessor);
      transcriptProcessor.connect(transcriptSilence);
      transcriptSilence.connect(audioContext.destination);
      await audioContext.resume().catch(() => undefined);
      audioContextRef.current = audioContext;
      transcriptProcessorRef.current = transcriptProcessor;
      transcriptSilenceRef.current = transcriptSilence;

      transcriptProcessor.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer;
        const inputChannelCount = inputBuffer.numberOfChannels;

        if (inputChannelCount > 0) {
          const currentWaveform = liveWaveformRef.current;

          if (
            !currentWaveform ||
            currentWaveform.peaks.length !== inputChannelCount ||
            currentWaveform.sourceSampleRate !== inputBuffer.sampleRate ||
            currentWaveform.processorFrameCount !== inputBuffer.length
          ) {
            liveWaveformRef.current = createLiveWaveformState(
              inputChannelCount,
              inputBuffer.sampleRate,
              inputBuffer.length,
            );
          }

          if (liveWaveformRef.current) {
            appendLiveWaveformPeaks(liveWaveformRef.current, inputBuffer);
            publishLiveWaveformSnapshot();
          }
        }

        const socket = transcriptSocketRef.current;

        if (socket?.readyState !== WebSocket.OPEN) {
          return;
        }

        const linear16Chunk = convertAudioBufferToLinear16(
          inputBuffer,
          TRANSCRIPT_SAMPLE_RATE,
        );

        if (linear16Chunk.byteLength > 0) {
          // First frame heading to Deepgram — stamp the engine-elapsed time so
          // we can later offset Deepgram's word timestamps onto the same axis
          // as the waveform peaks. Without this, words drift LEFT by however
          // long the WebSocket took to open after engineStartedAtRef.
          if (
            transcriptStreamOffsetRef.current === 0 &&
            engineStartedAtRef.current !== null
          ) {
            transcriptStreamOffsetRef.current =
              (performance.now() - engineStartedAtRef.current) / 1000;
          }
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
    publishLiveWaveformSnapshot,
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
      // Remote browsers don't run their own engine; they remote-control the
      // host via the buttons in the Remote Controller panel below.
      return;
    }

    await toggleEngine();
  }, [isHost, toggleEngine]);

  const getRenderableBlob = useCallback(async () => {
    if (isEngineRunning && engineStartedAtRef.current) {
      const snapshot = await commitRollingBuffer(
        (performance.now() - engineStartedAtRef.current) / 1000,
        { forceRender: true },
      );

      return snapshot?.blob ?? latestCommittedSnapshotRef.current?.blob ?? workingBlob;
    }

    return latestCommittedSnapshotRef.current?.blob ?? workingBlob;
  }, [commitRollingBuffer, isEngineRunning, workingBlob]);

  const saveClip = useCallback(async () => {
    if (!clipName.trim() || !relativeSelection) {
      return;
    }

    setIsSaving(true);

    try {
      const renderableBlob = await getRenderableBlob();

      if (!renderableBlob) {
        return;
      }

      const trimmedWav = await sliceAndExportAudio(
        renderableBlob,
        relativeSelection.start,
        relativeSelection.end,
      );
      const safeName = clipName.replace(/[^a-z0-9]+/gi, '_');
      const file = new File([trimmedWav], `${safeName}_${Date.now()}.wav`, {
        type: 'audio/wav',
      });
      const formData = new FormData();
      // Use the explicit override when present (e.g. remote command set it);
      // otherwise fall back to whatever the host's dropdown is set to.
      const category = categoryOverrideRef.current ?? clipCategory ?? 'Uncategorized';
      categoryOverrideRef.current = null;

      formData.append('file', file);
      formData.append('category', category);

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
  }, [clipCategory, clipName, getRenderableBlob, loadSounds, relativeSelection]);

  /**
   * Saves the last `durationSec` seconds of the rolling buffer with an auto-
   * generated name. Used by the remote-controller buttons that fire via the
   * /engine/clip-last-N HTTP commands. The engine has to already be running so
   * there's a buffer to slice from.
   */
  const saveQuickClip = useCallback(
    async (durationSec: number) => {
      if (!isEngineRunning || !engineStartedAtRef.current) {
        setTranscriptMessage(
          'Remote tried to save a clip but the rolling engine isn’t running.',
        );
        return;
      }

      setIsSaving(true);

      try {
        const renderableBlob = await getRenderableBlob();

        if (!renderableBlob) {
          setTranscriptMessage('No audio buffer to slice yet — give the engine a moment.');
          return;
        }

        // Use the snapshot's actual audio duration to decide what "the last N
        // seconds" means. The renderable blob may be shorter than durationSec
        // if the engine just started; sliceAndExportAudio clamps for us, but
        // we want the slice tail-aligned regardless.
        const snapshot = latestCommittedSnapshotRef.current;
        const totalDuration = snapshot?.audioDuration
          ?? Math.min(
            (performance.now() - engineStartedAtRef.current) / 1000,
            BUFFER_SECONDS,
          );
        const sliceStart = Math.max(0, totalDuration - durationSec);
        const sliceEnd = totalDuration;

        const trimmedWav = await sliceAndExportAudio(renderableBlob, sliceStart, sliceEnd);
        const stamp = new Date()
          .toISOString()
          .replace(/[^0-9]/g, '')
          .slice(0, 14);
        const filename = `quick_${durationSec}s_${stamp}.wav`;
        const file = new File([trimmedWav], filename, { type: 'audio/wav' });
        const formData = new FormData();
        const category = categoryOverrideRef.current ?? 'Uncategorized';
        categoryOverrideRef.current = null;

        formData.append('file', file);
        formData.append('category', category);

        const response = await fetch('/api/upload', { method: 'POST', body: formData });

        if (!response.ok) {
          const error = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(error?.error ?? 'Upload failed.');
        }

        await loadSounds();
        setTranscriptMessage(
          `Saved the last ${durationSec}s as a pad (${filename}). Rename it from the soundboard.`,
        );
      } catch (error) {
        console.error('Quick clip failed:', error);
        setTranscriptMessage('Quick clip failed — see DevTools console for details.');
      } finally {
        setIsSaving(false);
      }
    },
    [getRenderableBlob, isEngineRunning, loadSounds],
  );

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
    quickClipCommandRef.current = saveQuickClip;
    saveClipCommandRef.current = saveClip;
    getRenderableBlobRef.current = getRenderableBlob;
  }, [focusLatestSelection, getRenderableBlob, handleToggleClick, saveClip, saveQuickClip]);

  useEffect(() => {
    if (!isHost || !window.electronAPI || engineCommandRegisteredRef.current) {
      return;
    }

    engineCommandRegisteredRef.current = true;

    window.electronAPI.onEngineCommand((command: string) => {
      if (command === 'toggle') {
        void toggleEngineCommandRef.current();
        return;
      }

      if (command === 'mark') {
        void markClipCommandRef.current();
        return;
      }

      // clip-last-<n> where n is seconds. Forward to the quick-clip handler.
      const quickMatch = command.match(/^clip-last-(\d+)$/);
      if (quickMatch) {
        const durationSec = Math.max(1, Math.min(BUFFER_SECONDS, Number(quickMatch[1])));
        void quickClipCommandRef.current(durationSec);
      }
    });
  }, [isHost]);

  useEffect(() => {
    stopEngineRef.current = stopEngine;
  }, [stopEngine]);

  useEffect(() => {
    return () => {
      void stopEngineRef.current();
    };
  }, []);

  // Compute a human source label so remote browsers can show "Source: …"
  // matching what's selected on the host.
  const sourceLabel = useMemo(() => {
    if (selectedDevice === 'none') return '';

    if (selectedDevice.startsWith('desktop:')) {
      const sourceId = selectedDevice.slice('desktop:'.length);
      const match = desktopSources.find((source) => source.id === sourceId);
      return match?.name ?? 'Desktop source';
    }

    const micMatch = mics.find((mic) => mic.deviceId === selectedDevice);
    return micMatch?.label || 'Microphone';
  }, [desktopSources, mics, selectedDevice]);

  /**
   * State-change publication for remote browsers. We snapshot the visible
   * fields whenever anything important changes; a separate interval ticks
   * elapsedSeconds + live waveform while the engine is running. SSE delivers
   * everything to clients connected to /engine/stream.
   */
  useEffect(() => {
    if (!isHost || typeof window === 'undefined' || !window.electronAPI?.publishEngineState) {
      return;
    }

    const snapshot: ClipperSyncSnapshot = {
      publishedAt: Date.now(),
      isEngineRunning,
      elapsedSeconds: engineStartedAtRef.current
        ? (performance.now() - engineStartedAtRef.current) / 1000
        : null,
      bufferSeconds: CLIPPER_BUFFER_SECONDS,
      bufferWindow,
      selectionRange,
      finalWords: finalWords as ClipperSyncWord[],
      interimWords: interimWords as ClipperSyncWord[],
      sourceLabel,
      transcriptStatus,
      isSaving,
      statusMessage: transcriptMessage,
    };

    window.electronAPI.publishEngineState(snapshot);
  }, [
    bufferWindow,
    finalWords,
    interimWords,
    isEngineRunning,
    isHost,
    isSaving,
    selectionRange,
    sourceLabel,
    transcriptMessage,
    transcriptStatus,
  ]);

  /**
   * Tick while the engine is running. Publishes:
   *   - elapsedSeconds — for the remote's mm:ss timer
   *   - volumeHistory — the 120-entry rolling meter the host paints (cheap)
   *   - timelinePeaks — downsampled buffer peaks for the remote's timeline,
   *     refreshed at a slower cadence so we don't spam SSE with kilobytes
   *
   * Heavy payloads (timeline peaks) only ride every Nth tick.
   */
  useEffect(() => {
    if (!isHost || !isEngineRunning) return;
    if (typeof window === 'undefined' || !window.electronAPI?.publishEngineState) return;

    let tickIndex = 0;
    // Resample heavy peaks every ~600ms while engine runs (every 5 ticks at
    // 120ms each). The 120-entry volume history piggybacks on every tick.
    const PEAKS_EVERY_N_TICKS = 5;

    const downsamplePeaks = (
      source: Float32Array,
      writeIndex: number,
      sampleCount: number,
      capacity: number,
      duration: number,
      endSec: number,
    ): ClipperSyncTimelinePeaks | null => {
      const totalPairs = Math.min(sampleCount, capacity) / 2;
      if (totalPairs <= 0) return null;

      const outputBuckets = Math.min(TIMELINE_PEAK_BUCKETS, Math.floor(totalPairs));
      if (outputBuckets <= 0) return null;

      // The host's ring buffer writes (min, max) pairs. The newest pair is at
      // writeIndex-2, oldest at writeIndex (wrapping). Walk in chronological
      // order so the remote can paint left-to-right.
      const flat = new Array<number>(outputBuckets * 2);
      const ringStart = sampleCount >= capacity ? writeIndex : 0;
      const pairsAvailable = totalPairs;
      const pairsPerOutput = pairsAvailable / outputBuckets;

      for (let bucket = 0; bucket < outputBuckets; bucket += 1) {
        const sourceStart = Math.floor(bucket * pairsPerOutput);
        const sourceEnd = Math.max(sourceStart + 1, Math.floor((bucket + 1) * pairsPerOutput));
        let bucketMin = Infinity;
        let bucketMax = -Infinity;

        for (let p = sourceStart; p < sourceEnd && p < pairsAvailable; p += 1) {
          const offsetPairs = (ringStart / 2 + p) % (capacity / 2);
          const flatIdx = Math.floor(offsetPairs) * 2;
          const min = source[flatIdx];
          const max = source[flatIdx + 1];
          if (typeof min === 'number' && min < bucketMin) bucketMin = min;
          if (typeof max === 'number' && max > bucketMax) bucketMax = max;
        }

        if (!Number.isFinite(bucketMin)) bucketMin = 0;
        if (!Number.isFinite(bucketMax)) bucketMax = 0;

        flat[bucket * 2] = bucketMin;
        flat[bucket * 2 + 1] = bucketMax;
      }

      const startSec = Math.max(0, endSec - duration);

      return {
        bucketsFlat: flat,
        bucketCount: outputBuckets,
        audioDuration: duration,
        startSec,
        endSec,
      };
    };

    const interval = window.setInterval(() => {
      tickIndex += 1;

      const volumeHistory =
        volumeHistoryRef.current.length > 0
          ? ([...volumeHistoryRef.current] as ClipperSyncVolumeHistory)
          : null;

      let timelinePeaks: ClipperSyncTimelinePeaks | null | undefined = undefined;

      if (tickIndex % PEAKS_EVERY_N_TICKS === 0) {
        const wave = liveWaveformRef.current;
        if (wave && wave.peaks[0]) {
          const elapsedSeconds = engineStartedAtRef.current
            ? (performance.now() - engineStartedAtRef.current) / 1000
            : 0;
          const audibleDuration = Math.min(elapsedSeconds, CLIPPER_BUFFER_SECONDS);
          timelinePeaks = downsamplePeaks(
            wave.peaks[0],
            wave.writeIndex,
            wave.sampleCount,
            wave.capacity,
            audibleDuration,
            elapsedSeconds,
          );
        }
      }

      const tickSnapshot: ClipperSyncSnapshot = {
        publishedAt: Date.now(),
        isEngineRunning: true,
        elapsedSeconds: engineStartedAtRef.current
          ? (performance.now() - engineStartedAtRef.current) / 1000
          : null,
        volumeHistory,
      };

      if (timelinePeaks !== undefined) {
        tickSnapshot.timelinePeaks = timelinePeaks;
      }

      window.electronAPI?.publishEngineState(tickSnapshot);
    }, CLIPPER_PUBLISH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [isEngineRunning, isHost]);

  /**
   * Handle commands posted by remote browsers via POST /engine/command (e.g.
   * set-selection from a remote scrub, save-clip with explicit name). Simple
   * one-shot commands like toggle/mark/clip-last-N still come through the
   * existing engine-command path.
   */
  useEffect(() => {
    if (
      !isHost ||
      typeof window === 'undefined' ||
      !window.electronAPI?.onEngineCommandPayload ||
      engineCommandPayloadRegisteredRef.current
    ) {
      return;
    }

    engineCommandPayloadRegisteredRef.current = true;

    window.electronAPI.onEngineCommandPayload((payload) => {
      const command = payload as ClipperSyncCommand;

      if (!command || typeof command !== 'object' || !('type' in command)) {
        return;
      }

      if (command.type === 'toggle') {
        void toggleEngineCommandRef.current();
        return;
      }

      if (command.type === 'mark') {
        void markClipCommandRef.current();
        return;
      }

      if (command.type === 'clip-last' && typeof command.durationSec === 'number') {
        const clamped = Math.max(1, Math.min(BUFFER_SECONDS, command.durationSec));
        if (typeof command.category === 'string' && command.category.trim()) {
          categoryOverrideRef.current = command.category.trim();
        }
        void quickClipCommandRef.current(clamped);
        return;
      }

      if (
        command.type === 'set-selection' &&
        typeof command.start === 'number' &&
        typeof command.end === 'number'
      ) {
        const next = { start: command.start, end: command.end };
        selectionRangeRef.current = next;
        setSelectionRange(next);
        setHasManualSelection(true);
        hasManualSelectionRef.current = true;
        // The remote user picked a specific range — pin it. Without this, the
        // next commitRollingBuffer tick would snap selection back to the live
        // edge because shouldFollowLiveEdgeRef defaults to true.
        shouldFollowLiveEdgeRef.current = false;
        setIsFollowingLive(false);
        return;
      }

      if (
        command.type === 'save-clip' &&
        typeof command.name === 'string' &&
        typeof command.start === 'number' &&
        typeof command.end === 'number'
      ) {
        // The remote sent a complete save request. Apply the selection and
        // name to host state, then trigger the normal save flow.
        const next = { start: command.start, end: command.end };
        selectionRangeRef.current = next;
        setSelectionRange(next);
        setHasManualSelection(true);
        hasManualSelectionRef.current = true;
        shouldFollowLiveEdgeRef.current = false;
        setIsFollowingLive(false);
        setClipName(command.name);
        if (typeof command.category === 'string' && command.category.trim()) {
          categoryOverrideRef.current = command.category.trim();
        }
        // saveClip reads state via closures so deferred call to avoid stale
        // values from the current render frame.
        window.setTimeout(() => {
          void saveClipCommandRef.current();
        }, 50);
      }
    });
  }, [isHost]);

  useEffect(() => {
    if (!clipName.trim() && alignedSelectionWords) {
      setClipName(alignedSelectionWords.slice(0, 72));
    }
  }, [alignedSelectionWords, clipName]);

  // Host: fulfil preview-audio requests from remote browsers. The remote
  // hit /engine/preview?start=X&end=Y; main.js IPCs us with a request id;
  // we slice the rolling buffer to a WAV and send the bytes back. main.js
  // writes them as the HTTP response body for the remote to play.
  useEffect(() => {
    if (
      !isHost ||
      typeof window === 'undefined' ||
      !window.electronAPI?.onEnginePreviewRequest ||
      enginePreviewRequestRegisteredRef.current
    ) {
      return;
    }

    enginePreviewRequestRegisteredRef.current = true;

    const electronAPI = window.electronAPI;

    electronAPI.onEnginePreviewRequest(async ({ id, start, end }) => {
      try {
        const renderableBlob = await getRenderableBlobRef.current();
        if (!renderableBlob) {
          electronAPI.respondEnginePreview({ id, bytes: null });
          return;
        }

        // Convert from engine-elapsed seconds (which is what the remote sees
        // on its waveform timeline) to blob-relative seconds. The blob's
        // t=0 corresponds to the start of the committed buffer window.
        const bw = bufferWindowRef.current;
        const blobStart = Math.max(0, start - (bw?.start ?? 0));
        const blobEnd = Math.max(blobStart + 0.05, end - (bw?.start ?? 0));

        const trimmedWav = await sliceAndExportAudio(renderableBlob, blobStart, blobEnd);
        const bytes = new Uint8Array(await trimmedWav.arrayBuffer());
        electronAPI.respondEnginePreview({ id, bytes });
      } catch (error) {
        console.error('Failed to render preview slice for remote:', error);
        electronAPI.respondEnginePreview({ id, bytes: null });
      }
    });
  }, [isHost]);

  useEffect(() => stopPreviewAudio, [stopPreviewAudio]);

  const handlePreviewToggle = async () => {
    if (isPlaying) {
      stopPreviewAudio();
      return;
    }

    if (!relativeSelection) {
      return;
    }

    try {
      const renderableBlob = await getRenderableBlob();

      if (!renderableBlob) {
        return;
      }

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
        renderableBlob,
        previewStart,
        previewEnd,
      );

      stopPreviewAudio();

      const previewUrl = URL.createObjectURL(trimmedWav);
      const previewAudio = new Audio(previewUrl) as AudioElementWithSink;

      previewAudioRef.current = previewAudio;
      previewUrlRef.current = previewUrl;

      // Try the user-picked Preview Output. If setSinkId fails we still play
      // on the OS default so the clip is never silent.
      if (previewOutputId && typeof previewAudio.setSinkId === 'function') {
        try {
          await previewAudio.setSinkId(previewOutputId);
        } catch (error) {
          console.warn('Clipper preview sink routing failed, playing on default:', error);
        }
      }

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

  if (!isHost) {
    return <ClipperRemoteController />;
  }

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
                disabled={!activePreviewSnapshot}
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

          {activePreviewSnapshot ? (
            <div className="flex min-h-0 flex-1 flex-col gap-5">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={clipName}
                  onChange={(event) => setClipName(event.target.value)}
                  placeholder="Name your clip"
                  className="field flex-1 min-w-[200px]"
                />
                <select
                  value={
                    categoryOptions.includes(clipCategory) ? clipCategory : 'Uncategorized'
                  }
                  onChange={(event) => setClipCategory(event.target.value)}
                  className="select-field w-full sm:w-auto"
                  title="Soundboard category to save this clip into"
                >
                  {categoryOptions.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </div>

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

                <button
                  type="button"
                  onClick={handlePreviewToggle}
                  className="ghost-button"
                  disabled={!workingBlob || !relativeSelection}
                >
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
                disabled={isSaving || !workingBlob || !relativeSelection || !clipName.trim()}
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
