/**
 * Wire format for streaming the host's Clipper state to remote browsers.
 *
 * The host's ClipWorkbench owns the source of truth (audio engine, mic stream,
 * MediaRecorder buffer, Deepgram socket). Remote browsers don't run their own
 * audio engine — they just mirror what the host publishes here and fire HTTP
 * commands back when the user interacts.
 *
 * Transport is Server-Sent Events over the existing port-8080 remote-control
 * server, so no extra npm dependencies. Each SSE message body is a JSON
 * payload matching {@link ClipperSyncSnapshot}.
 */

export interface ClipperSyncWord {
  id: string;
  word: string;
  /** Seconds since engine start. */
  start: number;
  /** Seconds since engine start. */
  end: number;
}

export interface ClipperSyncBufferWindow {
  start: number;
  end: number;
  duration: number;
}

export interface ClipperSyncSelection {
  start: number;
  end: number;
}

/**
 * Volume meter history matching the host's volumeHistoryRef (120-frame rolling
 * window of 0–255 frequency averages). Cheap to send and lets the remote
 * render an identical-looking bar meter.
 */
export type ClipperSyncVolumeHistory = number[];

/**
 * Downsampled waveform peaks for the rolling buffer, used to render the
 * draggable timeline on the remote. Each entry is a [min, max] pair across
 * the bucket. We aggressively downsample (to ~ TIMELINE_PEAK_BUCKETS pairs)
 * so the payload stays cheap for SSE.
 */
export interface ClipperSyncTimelinePeaks {
  /** Flattened [min0, max0, min1, max1, ...] — length = bucketCount * 2. */
  bucketsFlat: number[];
  bucketCount: number;
  /** Wall-clock seconds covered by the peaks. */
  audioDuration: number;
  /**
   * Engine-elapsed seconds of the *first* sample in these peaks. Together with
   * endSec it defines the canvas's time-axis. We expose both bounds so the
   * remote can align words, selection rectangles, and tick marks accurately —
   * the host's bufferWindow lags the live edge by up to a commit-tick.
   */
  startSec: number;
  /** Engine-elapsed seconds of the *last* sample in these peaks. */
  endSec: number;
}

/** Number of (min, max) pairs we resample peaks down to before sending. */
export const TIMELINE_PEAK_BUCKETS = 360;

/**
 * Snapshot of the host's Clipper state visible to remote browsers. Fields are
 * optional so the host can publish partial diffs (e.g. interim transcript
 * updates without resending all peaks). Remotes deep-merge into their local
 * mirror.
 */
export interface ClipperSyncSnapshot {
  /** Logical generation counter — increments on each publish. */
  generation?: number;
  /** When the snapshot was assembled on the host (ms since epoch). */
  publishedAt?: number;
  /** True when the rolling buffer is running. */
  isEngineRunning?: boolean;
  /** Wall-clock seconds since the engine started, or null when stopped. */
  elapsedSeconds?: number | null;
  /** Total buffer capacity in seconds (constant — included for first-message convenience). */
  bufferSeconds?: number;
  /** Current visible window of the rolling buffer. */
  bufferWindow?: ClipperSyncBufferWindow;
  /** Current trim selection in buffer-relative seconds, or null when none. */
  selectionRange?: ClipperSyncSelection | null;
  /** Final/locked-in transcript words from Deepgram. */
  finalWords?: ClipperSyncWord[];
  /** Interim (in-flight) transcript words from Deepgram. */
  interimWords?: ClipperSyncWord[];
  /** Currently-running engine source label, for the remote's "Source: …" line. */
  sourceLabel?: string;
  /** Deepgram-or-equivalent transcription status. */
  transcriptStatus?:
    | 'disabled'
    | 'ready'
    | 'connecting'
    | 'live'
    | 'unavailable';
  /** Whether the host is currently saving a clip. */
  isSaving?: boolean;
  /** Most recent status message the host wants to surface. */
  statusMessage?: string;
  /** Volume meter history (120-entry rolling window of 0-255 averages). */
  volumeHistory?: ClipperSyncVolumeHistory | null;
  /** Downsampled rolling-buffer peaks for the remote's draggable timeline. */
  timelinePeaks?: ClipperSyncTimelinePeaks | null;
}

/** Commands a remote can fire at the host. */
export type ClipperSyncCommand =
  | { type: 'toggle' }
  | { type: 'mark' }
  | { type: 'clip-last'; durationSec: number; category?: string }
  | { type: 'set-selection'; start: number; end: number }
  | {
      type: 'save-clip';
      name: string;
      start: number;
      end: number;
      /** Soundboard category to save into; defaults to Uncategorized. */
      category?: string;
    };

/** Default Clipper buffer length (kept here so both sides agree). */
export const CLIPPER_BUFFER_SECONDS = 60;

/** Throttle interval for full snapshots when the engine is running. */
export const CLIPPER_PUBLISH_INTERVAL_MS = 120;
