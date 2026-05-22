'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { buildMediaUrl } from '@/lib/media';

/**
 * Lightweight per-sound metrics derived by decoding each audio file once and
 * computing duration + perceptual loudness (RMS expressed in dBFS, where 0 dB
 * is full-scale). Cached at module scope so navigating between folders or
 * remounting the library doesn't re-decode anything we've already seen.
 */
export interface SoundMetrics {
  /** Duration in seconds. */
  durationSec: number;
  /** RMS amplitude, normalized 0-1. */
  rms: number;
  /** RMS converted to dBFS (≤ 0, smaller is quieter; -Infinity for silence). */
  loudnessDb: number;
}

const cache: Map<string, SoundMetrics> = new Map();
const inflight: Set<string> = new Set();

let sharedContext: AudioContext | OfflineAudioContext | null = null;
const getSharedContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;
  if (sharedContext && 'decodeAudioData' in sharedContext) {
    return sharedContext as AudioContext;
  }
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  sharedContext = new Ctor();
  return sharedContext as AudioContext;
};

/**
 * Decode one file and write its metrics into the cache. We deliberately keep
 * the AudioBuffer out of the cache (it can be huge) and discard it as soon as
 * we have the scalar summary.
 */
const analyzeFile = async (filename: string): Promise<SoundMetrics | null> => {
  if (cache.has(filename)) return cache.get(filename) ?? null;
  if (inflight.has(filename)) return null;
  inflight.add(filename);

  try {
    const url = buildMediaUrl('sounds', filename);
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const ctx = getSharedContext();
    if (!ctx) return null;

    // decodeAudioData detaches the buffer in Chrome, so always pass a slice.
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

    // Mix to mono and compute RMS in chunks to avoid building one huge array.
    const channelCount = buffer.numberOfChannels;
    const frameCount = buffer.length;
    let sumSquares = 0;
    let totalSamples = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) {
        const sample = data[i];
        sumSquares += sample * sample;
      }
      totalSamples += data.length;
    }
    const rms = totalSamples > 0 ? Math.sqrt(sumSquares / totalSamples) : 0;
    const loudnessDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

    const metrics: SoundMetrics = {
      durationSec: buffer.duration || frameCount / buffer.sampleRate,
      rms,
      loudnessDb,
    };
    cache.set(filename, metrics);
    return metrics;
  } catch {
    return null;
  } finally {
    inflight.delete(filename);
  }
};

/**
 * Hook that lazily analyzes every filename in the provided list, returning a
 * stable Map of measured metrics. Analyses run with a small concurrency limit
 * so loading a large library doesn't slam the audio decoder all at once.
 */
export const useSoundMetrics = (filenames: string[]): Map<string, SoundMetrics> => {
  const [version, setVersion] = useState(0);
  // Track which filenames we've already enqueued in this hook instance so we
  // don't spam the analyzer when parent re-renders pass new array identities.
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;

    const pending = filenames.filter(
      (name) => name && !cache.has(name) && !seenRef.current.has(name),
    );
    if (pending.length === 0) return;

    pending.forEach((name) => seenRef.current.add(name));

    const CONCURRENCY = 3;
    let cursor = 0;
    let activeWorkers = 0;

    const pump = () => {
      if (cancelled) return;
      while (activeWorkers < CONCURRENCY && cursor < pending.length) {
        const next = pending[cursor];
        cursor += 1;
        activeWorkers += 1;
        void analyzeFile(next).then(() => {
          activeWorkers -= 1;
          if (cancelled) return;
          // Trigger a re-render so the new metric appears in the UI. Coalesce
          // by batching with rAF — multiple finishes in the same frame collapse
          // into a single render.
          if (typeof window !== 'undefined') {
            window.requestAnimationFrame(() => {
              if (!cancelled) setVersion((v) => v + 1);
            });
          } else {
            setVersion((v) => v + 1);
          }
          pump();
        });
      }
    };

    pump();
    return () => {
      cancelled = true;
    };
  }, [filenames]);

  // Build the returned map from the shared cache, restricted to what was asked
  // for. We depend on `version` so React re-renders consumers when new data
  // lands, even though the cache itself is module-scoped.
  return useMemo(() => {
    const out = new Map<string, SoundMetrics>();
    for (const name of filenames) {
      const m = cache.get(name);
      if (m) out.set(name, m);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filenames, version]);
};

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–';
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

export const formatLoudness = (db: number): string => {
  if (!Number.isFinite(db)) return '–';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
};
