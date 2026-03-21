'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type TranscriptStatus = 'disabled' | 'ready' | 'connecting' | 'live' | 'unavailable';

interface LiveWord {
  id: string;
  word: string;
  start: number;
  end: number;
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
  peaks: Array<Float32Array | number[]>;
  audioDuration: number;
}

interface TimelineInteractionPan {
  type: 'pan';
  pointerId: number;
  startX: number;
  startViewStart: number;
  visibleDuration: number;
}

interface TimelineInteractionPaint {
  type: 'paint';
  pointerId: number;
  anchorTime: number;
}

interface TimelineInteractionResizeStart {
  type: 'resize-start';
  pointerId: number;
  anchorEnd: number;
}

interface TimelineInteractionResizeEnd {
  type: 'resize-end';
  pointerId: number;
  anchorStart: number;
}

interface TimelineInteractionMove {
  type: 'move';
  pointerId: number;
  dragOffset: number;
  duration: number;
}

type TimelineInteraction =
  | TimelineInteractionPan
  | TimelineInteractionPaint
  | TimelineInteractionResizeStart
  | TimelineInteractionResizeEnd
  | TimelineInteractionMove;

interface PositionedWord {
  id: string;
  word: string;
  barLeft: number;
  barWidth: number;
  labelLeft: number;
  labelWidth: number;
  laneIndex: number;
  isInSelection: boolean;
}

interface LiveTimelineEditorProps {
  snapshot: PreviewSnapshot | null;
  bufferWindow: BufferWindow;
  selectionRange: SelectionRange | null;
  timelineWords: LiveWord[];
  hasLiveInterimWords: boolean;
  transcriptStatus: TranscriptStatus;
  zoomLevel: number;
  followLive: boolean;
  onZoomChange: (nextZoom: number) => void;
  onFollowLiveChange: (nextFollowLive: boolean) => void;
  onInteractionChange: (isInteracting: boolean) => void;
  onSelectionChange: (nextSelection: SelectionRange) => void;
  onSelectionCommit: () => void;
}

const MIN_SELECTION_SECONDS = 0.05;
const MIN_VIEW_SECONDS = 0.35;
const MIN_ZOOM = 24;
const MAX_ZOOM = 1800;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const getViewDuration = (viewportWidth: number, zoomLevel: number) =>
  Math.max(MIN_VIEW_SECONDS, viewportWidth > 0 ? viewportWidth / zoomLevel : 8);

const clampViewStart = (
  nextViewStart: number,
  viewDuration: number,
  bufferWindow: BufferWindow,
) => {
  if (bufferWindow.duration <= 0) {
    return 0;
  }

  const safeViewDuration = Math.min(
    Math.max(viewDuration, MIN_VIEW_SECONDS),
    Math.max(bufferWindow.duration, MIN_VIEW_SECONDS),
  );
  const maxViewStart = Math.max(bufferWindow.start, bufferWindow.end - safeViewDuration);

  return clamp(nextViewStart, bufferWindow.start, maxViewStart);
};

const getLiveViewStart = (bufferWindow: BufferWindow, viewDuration: number) =>
  clampViewStart(bufferWindow.end - viewDuration, viewDuration, bufferWindow);

const getTranscriptStatusLabel = (
  transcriptStatus: TranscriptStatus,
  hasLiveInterimWords: boolean,
) => {
  if (transcriptStatus === 'live' && hasLiveInterimWords) {
    return 'Locking word timing...';
  }

  if (transcriptStatus === 'live') {
    return 'Listening for words...';
  }

  if (transcriptStatus === 'connecting') {
    return 'Connecting speech...';
  }

  if (transcriptStatus === 'ready') {
    return 'Speech armed';
  }

  if (transcriptStatus === 'unavailable') {
    return 'Speech service unavailable';
  }

  return '';
};

export default function LiveTimelineEditor({
  snapshot,
  bufferWindow,
  selectionRange,
  timelineWords,
  hasLiveInterimWords,
  transcriptStatus,
  zoomLevel,
  followLive,
  onZoomChange,
  onFollowLiveChange,
  onInteractionChange,
  onSelectionChange,
  onSelectionCommit,
}: LiveTimelineEditorProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const interactionRef = useRef<TimelineInteraction | null>(null);
  const bufferWindowRef = useRef(bufferWindow);
  const selectionRangeRef = useRef(selectionRange);
  const viewportWidthRef = useRef(0);
  const zoomLevelRef = useRef(zoomLevel);
  const followLiveRef = useRef(followLive);
  const viewStartRef = useRef(0);
  const resolvedViewStartRef = useRef(0);
  const resolvedViewDurationRef = useRef(8);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [viewStart, setViewStart] = useState(0);

  const visibleDuration = useMemo(
    () => getViewDuration(viewportSize.width, zoomLevel),
    [viewportSize.width, zoomLevel],
  );
  const liveViewStart = useMemo(
    () => getLiveViewStart(bufferWindow, visibleDuration),
    [bufferWindow, visibleDuration],
  );
  const resolvedViewStart = useMemo(
    () =>
      followLive
        ? liveViewStart
        : clampViewStart(viewStart, visibleDuration, bufferWindow),
    [bufferWindow, followLive, liveViewStart, viewStart, visibleDuration],
  );
  const resolvedViewEnd = useMemo(
    () =>
      Math.min(
        bufferWindow.end,
        resolvedViewStart +
          Math.min(visibleDuration, Math.max(bufferWindow.duration, MIN_VIEW_SECONDS)),
      ),
    [bufferWindow.duration, bufferWindow.end, resolvedViewStart, visibleDuration],
  );
  const resolvedViewDuration = useMemo(
    () => Math.max(MIN_VIEW_SECONDS, resolvedViewEnd - resolvedViewStart),
    [resolvedViewEnd, resolvedViewStart],
  );

  useEffect(() => {
    resolvedViewStartRef.current = resolvedViewStart;
    viewStartRef.current = resolvedViewStart;
  }, [resolvedViewStart]);

  useEffect(() => {
    resolvedViewDurationRef.current = resolvedViewDuration;
  }, [resolvedViewDuration]);

  useEffect(() => {
    bufferWindowRef.current = bufferWindow;
  }, [bufferWindow]);

  useEffect(() => {
    selectionRangeRef.current = selectionRange;
  }, [selectionRange]);

  useEffect(() => {
    viewportWidthRef.current = viewportSize.width;
  }, [viewportSize.width]);

  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);

  useEffect(() => {
    followLiveRef.current = followLive;
  }, [followLive]);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const updateSize = () => {
      const rect = viewport.getBoundingClientRect();
      const nextSize = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };

      setViewportSize((current) =>
        current.width === nextSize.width && current.height === nextSize.height
          ? current
          : nextSize,
      );
    };

    updateSize();

    const observer = new ResizeObserver(() => {
      updateSize();
    });

    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  }, []);

  const setClampedDetachedViewStart = useCallback(
    (nextViewStart: number, viewDurationOverride?: number) => {
      const clampedViewStart = clampViewStart(
        nextViewStart,
        viewDurationOverride ?? getViewDuration(viewportWidthRef.current, zoomLevelRef.current),
        bufferWindowRef.current,
      );

      viewStartRef.current = clampedViewStart;
      setViewStart(clampedViewStart);
    },
    [],
  );

  const detachFromLive = useCallback(() => {
    if (!followLiveRef.current) {
      return;
    }

    const currentViewDuration = getViewDuration(viewportWidthRef.current, zoomLevelRef.current);
    const currentLiveViewStart = getLiveViewStart(bufferWindowRef.current, currentViewDuration);

    setClampedDetachedViewStart(currentLiveViewStart, currentViewDuration);
    onFollowLiveChange(false);
  }, [onFollowLiveChange, setClampedDetachedViewStart]);

  const maybeReattachLive = useCallback(() => {
    const currentViewDuration = getViewDuration(viewportWidthRef.current, zoomLevelRef.current);
    const currentLiveViewStart = getLiveViewStart(bufferWindowRef.current, currentViewDuration);
    const currentViewStart = clampViewStart(
      viewStartRef.current,
      currentViewDuration,
      bufferWindowRef.current,
    );

    if (Math.abs(currentViewStart - currentLiveViewStart) <= 0.001) {
      setClampedDetachedViewStart(currentLiveViewStart, currentViewDuration);
      onFollowLiveChange(true);
    }
  }, [onFollowLiveChange, setClampedDetachedViewStart]);

  const clientXToTime = useCallback((clientX: number) => {
    const viewport = viewportRef.current;

    if (!viewport || viewportWidthRef.current <= 0) {
      return resolvedViewStartRef.current;
    }

    const rect = viewport.getBoundingClientRect();
    const clampedX = clamp(clientX - rect.left, 0, rect.width);

    return (
      resolvedViewStartRef.current +
      (clampedX / rect.width) * resolvedViewDurationRef.current
    );
  }, []);

  const timeToX = useCallback(
    (time: number) =>
      ((time - resolvedViewStart) / resolvedViewDuration) * viewportSize.width,
    [resolvedViewDuration, resolvedViewStart, viewportSize.width],
  );

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || viewportSize.width <= 0 || viewportSize.height <= 0) {
      return;
    }

    const drawFrame = window.requestAnimationFrame(() => {
      const context = canvas.getContext('2d');

      if (!context) {
        return;
      }

      const width = viewportSize.width;
      const height = viewportSize.height;
      const devicePixelRatio = window.devicePixelRatio || 1;

      if (
        canvas.width !== Math.round(width * devicePixelRatio) ||
        canvas.height !== Math.round(height * devicePixelRatio)
      ) {
        canvas.width = Math.round(width * devicePixelRatio);
        canvas.height = Math.round(height * devicePixelRatio);
      }

      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const railHeight = Math.max(58, Math.min(84, Math.round(height * 0.28)));
      const waveAreaTop = 12;
      const waveAreaHeight = Math.max(72, height - railHeight - 22);
      const centerY = waveAreaTop + waveAreaHeight / 2;
      const halfWaveHeight = Math.max(26, waveAreaHeight * 0.42);

      context.strokeStyle = 'rgba(143, 162, 184, 0.1)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, centerY + 0.5);
      context.lineTo(width, centerY + 0.5);
      context.stroke();

      const tickInterval =
        resolvedViewDuration <= 4
          ? 0.25
          : resolvedViewDuration <= 10
            ? 0.5
            : resolvedViewDuration <= 24
              ? 1
              : resolvedViewDuration <= 48
                ? 2
                : 5;
      const firstTick =
        Math.floor(resolvedViewStart / tickInterval) * tickInterval;

      context.strokeStyle = 'rgba(143, 162, 184, 0.06)';

      for (let tick = firstTick; tick <= resolvedViewEnd; tick += tickInterval) {
        const tickX = timeToX(tick);

        if (tickX < 0 || tickX > width) {
          continue;
        }

        context.beginPath();
        context.moveTo(tickX + 0.5, waveAreaTop);
        context.lineTo(tickX + 0.5, height);
        context.stroke();
      }

      if (selectionRange) {
        const selectionLeft = timeToX(
          clamp(selectionRange.start, resolvedViewStart, resolvedViewEnd),
        );
        const selectionRight = timeToX(
          clamp(selectionRange.end, resolvedViewStart, resolvedViewEnd),
        );

        if (selectionRight > selectionLeft) {
          context.fillStyle = 'rgba(45, 212, 191, 0.12)';
          context.fillRect(
            selectionLeft,
            waveAreaTop,
            selectionRight - selectionLeft,
            waveAreaHeight,
          );

          context.strokeStyle = 'rgba(45, 212, 191, 0.52)';
          context.lineWidth = 1.5;
          context.beginPath();
          context.moveTo(selectionLeft + 0.5, waveAreaTop);
          context.lineTo(selectionLeft + 0.5, waveAreaTop + waveAreaHeight);
          context.moveTo(selectionRight - 0.5, waveAreaTop);
          context.lineTo(selectionRight - 0.5, waveAreaTop + waveAreaHeight);
          context.stroke();
        }
      }

      if (!snapshot || bufferWindow.duration <= 0 || snapshot.peaks.length === 0) {
        return;
      }

      const channels = snapshot.peaks.filter((channel) => channel.length > 0);
      const sampleCount = channels[0]?.length ?? 0;

      if (sampleCount === 0) {
        return;
      }

      const viewStartRatio = clamp(
        (resolvedViewStart - bufferWindow.start) / Math.max(bufferWindow.duration, MIN_VIEW_SECONDS),
        0,
        1,
      );
      const viewEndRatio = clamp(
        (resolvedViewEnd - bufferWindow.start) / Math.max(bufferWindow.duration, MIN_VIEW_SECONDS),
        0,
        1,
      );
      const visibleSampleStart = Math.floor(viewStartRatio * sampleCount);
      const visibleSampleEnd = Math.max(
        visibleSampleStart + 1,
        Math.ceil(viewEndRatio * sampleCount),
      );
      const visibleSampleSpan = Math.max(1, visibleSampleEnd - visibleSampleStart);

      context.strokeStyle = 'rgba(45, 212, 191, 0.86)';
      context.lineWidth = 1;
      context.beginPath();

      for (let pixel = 0; pixel < width; pixel += 1) {
        const segmentStart = visibleSampleStart + Math.floor((pixel / width) * visibleSampleSpan);
        const segmentEnd = Math.max(
          segmentStart + 1,
          visibleSampleStart + Math.floor(((pixel + 1) / width) * visibleSampleSpan),
        );
        let min = 1;
        let max = -1;

        for (let sampleIndex = segmentStart; sampleIndex < segmentEnd; sampleIndex += 1) {
          for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
            const sampleValue = channels[channelIndex][sampleIndex] ?? 0;

            if (sampleValue < min) {
              min = sampleValue;
            }

            if (sampleValue > max) {
              max = sampleValue;
            }
          }
        }

        const top = centerY - max * halfWaveHeight;
        const bottom = centerY - min * halfWaveHeight;

        context.moveTo(pixel + 0.5, top);
        context.lineTo(pixel + 0.5, bottom);
      }

      context.stroke();
    });

    return () => {
      window.cancelAnimationFrame(drawFrame);
    };
  }, [
    bufferWindow,
    resolvedViewDuration,
    resolvedViewEnd,
    resolvedViewStart,
    selectionRange,
    snapshot,
    timeToX,
    viewportSize.height,
    viewportSize.width,
  ]);

  const positionedWords = useMemo(() => {
    if (viewportSize.width <= 0 || timelineWords.length === 0) {
      return [] as PositionedWord[];
    }

    const laneEnds = [-Infinity, -Infinity];

    return timelineWords
      .filter((word) => word.end >= resolvedViewStart && word.start <= resolvedViewEnd)
      .map((word) => {
        const startX = clamp(timeToX(word.start), 0, viewportSize.width);
        const endX = clamp(timeToX(word.end), startX + 10, viewportSize.width);
        const barWidth = Math.max(10, endX - startX);
        const labelWidth = Math.max(52, Math.min(156, 20 + word.word.length * 7));
        const centerX = startX + barWidth / 2;
        let laneIndex = laneEnds.findIndex(
          (laneEnd) => centerX - labelWidth / 2 >= laneEnd + 10,
        );

        if (laneIndex === -1) {
          const shortestLane = Math.min(...laneEnds);
          laneIndex = laneEnds.indexOf(shortestLane);
        }

        laneEnds[laneIndex] = centerX + labelWidth / 2;

        return {
          id: word.id,
          word: word.word,
          barLeft: startX,
          barWidth,
          labelLeft: clamp(centerX - labelWidth / 2, 0, Math.max(0, viewportSize.width - labelWidth)),
          labelWidth,
          laneIndex,
          isInSelection: selectionRange
            ? word.end >= selectionRange.start && word.start <= selectionRange.end
            : false,
        };
      });
  }, [
    resolvedViewEnd,
    resolvedViewStart,
    selectionRange,
    timeToX,
    timelineWords,
    viewportSize.width,
  ]);

  const visibleSelection = useMemo(() => {
    if (!selectionRange) {
      return null;
    }

    const clampedStart = clamp(selectionRange.start, resolvedViewStart, resolvedViewEnd);
    const clampedEnd = clamp(selectionRange.end, resolvedViewStart, resolvedViewEnd);

    if (clampedEnd - clampedStart < 0.0001) {
      return null;
    }

    return {
      left: timeToX(clampedStart),
      width: Math.max(8, timeToX(clampedEnd) - timeToX(clampedStart)),
    };
  }, [resolvedViewEnd, resolvedViewStart, selectionRange, timeToX]);

  const statusLabel = getTranscriptStatusLabel(transcriptStatus, hasLiveInterimWords);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current;

      if (!viewport) {
        return;
      }

      const target = event.target as HTMLElement;
      const role = target.closest<HTMLElement>('[data-timeline-role]')?.dataset.timelineRole;

      if (event.button === 1) {
        event.preventDefault();
        detachFromLive();
        onInteractionChange(true);
        interactionRef.current = {
          type: 'pan',
          pointerId: event.pointerId,
          startX: event.clientX,
          startViewStart: followLiveRef.current
            ? getLiveViewStart(
                bufferWindowRef.current,
                getViewDuration(viewportWidthRef.current, zoomLevelRef.current),
              )
            : viewStartRef.current,
          visibleDuration: getViewDuration(viewportWidthRef.current, zoomLevelRef.current),
        };
        viewport.setPointerCapture(event.pointerId);
        return;
      }

      if (event.button !== 0) {
        return;
      }

      if (role === 'handle-start' && selectionRangeRef.current) {
        event.preventDefault();
        detachFromLive();
        onInteractionChange(true);
        interactionRef.current = {
          type: 'resize-start',
          pointerId: event.pointerId,
          anchorEnd: selectionRangeRef.current.end,
        };
        viewport.setPointerCapture(event.pointerId);
        return;
      }

      if (role === 'handle-end' && selectionRangeRef.current) {
        event.preventDefault();
        detachFromLive();
        onInteractionChange(true);
        interactionRef.current = {
          type: 'resize-end',
          pointerId: event.pointerId,
          anchorStart: selectionRangeRef.current.start,
        };
        viewport.setPointerCapture(event.pointerId);
        return;
      }

      if (role === 'selection-body' && selectionRangeRef.current) {
        event.preventDefault();
        detachFromLive();
        onInteractionChange(true);
        interactionRef.current = {
          type: 'move',
          pointerId: event.pointerId,
          dragOffset: clientXToTime(event.clientX) - selectionRangeRef.current.start,
          duration: selectionRangeRef.current.end - selectionRangeRef.current.start,
        };
        viewport.setPointerCapture(event.pointerId);
        return;
      }

      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();
      detachFromLive();
      onInteractionChange(true);

      const anchorTime = clientXToTime(event.clientX);
      const nextSelection = {
        start: anchorTime,
        end: anchorTime + MIN_SELECTION_SECONDS,
      };

      interactionRef.current = {
        type: 'paint',
        pointerId: event.pointerId,
        anchorTime,
      };

      onSelectionChange(nextSelection);
      viewport.setPointerCapture(event.pointerId);
    },
    [
      clientXToTime,
      detachFromLive,
      onInteractionChange,
      onSelectionChange,
    ],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const interaction = interactionRef.current;

      if (!interaction || interaction.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();

      if (interaction.type === 'pan') {
        const deltaRatio =
          viewportWidthRef.current > 0
            ? (event.clientX - interaction.startX) / viewportWidthRef.current
            : 0;
        const nextViewStart =
          interaction.startViewStart - deltaRatio * interaction.visibleDuration;

        setClampedDetachedViewStart(nextViewStart, interaction.visibleDuration);
        return;
      }

      const pointerTime = clientXToTime(event.clientX);
      const currentBuffer = bufferWindowRef.current;

      if (interaction.type === 'paint') {
        const nextStart = Math.max(currentBuffer.start, Math.min(interaction.anchorTime, pointerTime));
        const nextEnd = Math.min(
          currentBuffer.end,
          Math.max(interaction.anchorTime, pointerTime, nextStart + MIN_SELECTION_SECONDS),
        );

        onSelectionChange({ start: nextStart, end: nextEnd });
        return;
      }

      if (interaction.type === 'resize-start') {
        const nextStart = Math.max(
          currentBuffer.start,
          Math.min(pointerTime, interaction.anchorEnd - MIN_SELECTION_SECONDS),
        );

        onSelectionChange({
          start: nextStart,
          end: interaction.anchorEnd,
        });
        return;
      }

      if (interaction.type === 'resize-end') {
        const nextEnd = Math.min(
          currentBuffer.end,
          Math.max(pointerTime, interaction.anchorStart + MIN_SELECTION_SECONDS),
        );

        onSelectionChange({
          start: interaction.anchorStart,
          end: nextEnd,
        });
        return;
      }

      const nextStart = clamp(
        pointerTime - interaction.dragOffset,
        currentBuffer.start,
        currentBuffer.end - interaction.duration,
      );

      onSelectionChange({
        start: nextStart,
        end: nextStart + interaction.duration,
      });
    },
    [clientXToTime, onSelectionChange, setClampedDetachedViewStart],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const interaction = interactionRef.current;

      if (!interaction || interaction.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();

      if (viewportRef.current?.hasPointerCapture(event.pointerId)) {
        viewportRef.current.releasePointerCapture(event.pointerId);
      }

      interactionRef.current = null;
      onInteractionChange(false);

      if (interaction.type === 'pan') {
        maybeReattachLive();
        return;
      }

      onSelectionCommit();
    },
    [maybeReattachLive, onInteractionChange, onSelectionCommit],
  );

  const handleWheel = useCallback(
    (event: WheelEvent | React.WheelEvent<HTMLDivElement>) => {
      if (viewportWidthRef.current <= 0 || bufferWindowRef.current.duration <= 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const viewport = viewportRef.current;

      if (!viewport) {
        return;
      }

      const rect = viewport.getBoundingClientRect();
      const anchorX = clamp(event.clientX - rect.left, 0, rect.width);
      const anchorTime = clientXToTime(event.clientX);
      const currentZoom = zoomLevelRef.current;
      const nextZoom =
        event.deltaY < 0
          ? Math.min(MAX_ZOOM, currentZoom * 1.18)
          : Math.max(MIN_ZOOM, currentZoom / 1.18);

      if (Math.abs(nextZoom - currentZoom) < 0.01) {
        return;
      }

      const nextViewDuration = getViewDuration(viewportWidthRef.current, nextZoom);
      const nextViewStart = clampViewStart(
        anchorTime - (anchorX / Math.max(rect.width, 1)) * nextViewDuration,
        nextViewDuration,
        bufferWindowRef.current,
      );

      if (followLiveRef.current) {
        onFollowLiveChange(false);
      }

      setClampedDetachedViewStart(nextViewStart, nextViewDuration);
      onZoomChange(Number(nextZoom.toFixed(2)));
    },
    [clientXToTime, onFollowLiveChange, onZoomChange, setClampedDetachedViewStart],
  );

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const nativeWheelHandler = (event: WheelEvent) => {
      handleWheel(event);
    };

    viewport.addEventListener('wheel', nativeWheelHandler, { passive: false });

    return () => {
      viewport.removeEventListener('wheel', nativeWheelHandler);
    };
  }, [handleWheel]);

  return (
    <div
      ref={viewportRef}
      className="relative h-[20rem] overflow-hidden rounded-[1.15rem] border border-[var(--line)] bg-[rgba(4,8,14,0.9)] overscroll-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: 'none' }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-3 py-2">
        <div className="rounded-full border border-[rgba(143,162,184,0.16)] bg-[rgba(4,8,14,0.74)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
          {resolvedViewStart.toFixed(2)}s - {resolvedViewEnd.toFixed(2)}s
        </div>
        {statusLabel ? (
          <div className="rounded-full border border-[rgba(143,162,184,0.16)] bg-[rgba(4,8,14,0.74)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
            {statusLabel}
          </div>
        ) : null}
      </div>

      {visibleSelection ? (
        <div
          className="pointer-events-none absolute inset-y-[12px] rounded-[1rem] border border-[rgba(45,212,191,0.45)] bg-[rgba(45,212,191,0.08)]"
          style={{
            left: `${visibleSelection.left}px`,
            width: `${visibleSelection.width}px`,
          }}
        >
          <div
            data-timeline-role="selection-body"
            className="pointer-events-auto absolute inset-0 cursor-grab"
          />
          <div
            data-timeline-role="handle-start"
            className="pointer-events-auto absolute inset-y-0 left-0 w-4 -translate-x-1/2 cursor-ew-resize"
          >
            <div className="absolute inset-y-5 left-1/2 w-1 -translate-x-1/2 rounded-full bg-[rgba(45,212,191,0.95)] shadow-[0_0_18px_rgba(45,212,191,0.42)]" />
          </div>
          <div
            data-timeline-role="handle-end"
            className="pointer-events-auto absolute inset-y-0 right-0 w-4 translate-x-1/2 cursor-ew-resize"
          >
            <div className="absolute inset-y-5 left-1/2 w-1 -translate-x-1/2 rounded-full bg-[rgba(45,212,191,0.95)] shadow-[0_0_18px_rgba(45,212,191,0.42)]" />
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[5.1rem] border-t border-[rgba(143,162,184,0.08)] bg-gradient-to-b from-transparent to-[rgba(4,8,14,0.9)]">
        {positionedWords.map((word) => (
          <div key={word.id} className="absolute inset-y-0">
            <div
              className={`absolute h-[3px] rounded-full ${
                word.isInSelection
                  ? 'bg-[rgba(247,185,85,0.92)]'
                  : 'bg-[rgba(45,212,191,0.85)]'
              }`}
              style={{
                left: `${word.barLeft}px`,
                width: `${word.barWidth}px`,
                bottom: `${12 + word.laneIndex * 26}px`,
              }}
            />
            <div
              className={`absolute rounded-full border px-2 py-1 text-[11px] font-semibold leading-none shadow-[0_10px_24px_rgba(0,0,0,0.18)] backdrop-blur ${
                word.isInSelection
                  ? 'border-[rgba(247,185,85,0.38)] bg-[rgba(57,33,8,0.9)] text-[rgba(255,227,173,0.95)]'
                  : 'border-[rgba(45,212,191,0.24)] bg-[rgba(4,8,14,0.82)] text-[rgba(223,252,245,0.95)]'
              }`}
              style={{
                left: `${word.labelLeft}px`,
                width: `${word.labelWidth}px`,
                bottom: `${18 + word.laneIndex * 26}px`,
              }}
            >
              <span className="block truncate text-center">{word.word}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
