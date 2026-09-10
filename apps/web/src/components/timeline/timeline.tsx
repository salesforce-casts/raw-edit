'use client';

import * as React from 'react';
import type { EditDecision } from '@rawedit/core';
import { formatTimecode } from '@rawedit/core';
import { CUT_STYLES } from '@/components/review/edit-colors';
import { cn } from '@/lib/utils';

/**
 * A deliberately small timeline: one video track, the audio waveform, the proposed
 * removals, a playhead and draggable cut handles. It is not trying to be Premiere —
 * it exists so a creator can see the shape of the edit and nudge a boundary.
 */
export function Timeline({
  duration,
  currentTime,
  decisions,
  peaks,
  selectedId,
  onSeek,
  onSelect,
  onAdjust,
  className,
}: {
  duration: number;
  currentTime: number;
  decisions: EditDecision[];
  peaks: number[] | null;
  selectedId: string | null;
  onSeek: (time: number) => void;
  onSelect: (id: string | null) => void;
  onAdjust: (id: string, startTime: number, endTime: number) => void;
  className?: string;
}) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<{ id: string; edge: 'start' | 'end' } | null>(null);
  const [preview, setPreview] = React.useState<{ id: string; start: number; end: number } | null>(null);

  const toTime = React.useCallback(
    (clientX: number): number => {
      const element = trackRef.current;
      if (!element || duration <= 0) return 0;
      const rect = element.getBoundingClientRect();
      const ratio = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(duration, ratio * duration));
    },
    [duration],
  );

  // Dragging is bound to the window, not the handle, so the pointer can leave the
  // narrow handle without the drag stopping — which on a phone it always does.
  React.useEffect(() => {
    if (!drag) return;
    const decision = decisions.find((item) => item.id === drag.id);
    if (!decision) return;

    const onMove = (event: PointerEvent) => {
      const time = toTime(event.clientX);
      const next =
        drag.edge === 'start'
          ? { start: Math.min(time, decision.endTime - 0.05), end: decision.endTime }
          : { start: decision.startTime, end: Math.max(time, decision.startTime + 0.05) };
      setPreview({ id: drag.id, ...next });
    };

    const onUp = () => {
      if (preview && preview.id === drag.id) onAdjust(drag.id, preview.start, preview.end);
      setDrag(null);
      setPreview(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, decisions, preview, toTime, onAdjust]);

  const removals = decisions.filter((decision) => decision.decision === 'remove');
  const percent = (time: number) => (duration > 0 ? (time / duration) * 100 : 0);

  return (
    <div className={cn('select-none', className)}>
      <div
        ref={trackRef}
        className="relative h-20 w-full cursor-pointer overflow-hidden rounded-xl border border-border bg-surface-muted"
        onPointerDown={(event) => {
          // A click on empty track seeks; a click on a handle is stopped there.
          if ((event.target as HTMLElement).dataset['handle']) return;
          onSeek(toTime(event.clientX));
        }}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={currentTime}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') onSeek(Math.max(0, currentTime - (event.shiftKey ? 5 : 1)));
          if (event.key === 'ArrowRight')
            onSeek(Math.min(duration, currentTime + (event.shiftKey ? 5 : 1)));
        }}
      >
        <Waveform peaks={peaks} />

        {removals.map((decision) => {
          const live = preview?.id === decision.id ? preview : null;
          const start = live ? live.start : decision.startTime;
          const end = live ? live.end : decision.endTime;
          const style = CUT_STYLES[decision.kind];
          const selected = selectedId === decision.id;

          return (
            <div
              key={decision.id}
              className={cn(
                'absolute inset-y-0 border-x-2 transition-opacity',
                style.bar,
                selected ? 'opacity-70 ring-2 ring-inset ring-ink/30' : 'opacity-45',
              )}
              style={{ left: `${percent(start)}%`, width: `${Math.max(0.3, percent(end - start))}%` }}
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelect(decision.id);
              }}
              title={`${style.label}: ${decision.reason}`}
            >
              {selected ? (
                <>
                  <Handle
                    edge="start"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setDrag({ id: decision.id, edge: 'start' });
                    }}
                  />
                  <Handle
                    edge="end"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setDrag({ id: decision.id, edge: 'end' });
                    }}
                  />
                </>
              ) : null}
            </div>
          );
        })}

        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-ink"
          style={{ left: `${percent(currentTime)}%` }}
        >
          <span className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-ink" />
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between text-xs tabular-nums text-ink-subtle">
        <span>{formatTimecode(currentTime)}</span>
        <span>{formatTimecode(duration)}</span>
      </div>
    </div>
  );
}

function Handle({
  edge,
  onPointerDown,
}: {
  edge: 'start' | 'end';
  onPointerDown: (event: React.PointerEvent) => void;
}) {
  return (
    <span
      data-handle={edge}
      onPointerDown={onPointerDown}
      className={cn(
        // Wider than it looks: a 4px handle is unusable with a thumb.
        'absolute inset-y-0 z-20 w-4 cursor-ew-resize touch-none',
        edge === 'start' ? '-left-2' : '-right-2',
      )}
    >
      <span className="absolute inset-y-2 left-1/2 w-1 -translate-x-1/2 rounded-full bg-ink/70" />
    </span>
  );
}

/** Peak envelope rendered as an SVG polyline; cheap and crisp at any width. */
function Waveform({ peaks }: { peaks: number[] | null }) {
  if (!peaks || peaks.length === 0) {
    return <div className="absolute inset-0 bg-[repeating-linear-gradient(90deg,transparent,transparent_3px,var(--color-border)_3px,var(--color-border)_4px)] opacity-30" />;
  }

  // One point per peak, mirrored around the centre line.
  const width = 1000;
  const height = 100;
  const step = width / peaks.length;
  const top = peaks.map((peak, index) => `${index * step},${height / 2 - peak * (height / 2) * 0.9}`);
  const bottom = [...peaks]
    .reverse()
    .map((peak, index) => `${(peaks.length - index) * step},${height / 2 + peak * (height / 2) * 0.9}`);

  return (
    <svg
      className="absolute inset-0 h-full w-full text-ink-subtle"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polygon points={[...top, ...bottom].join(' ')} fill="currentColor" opacity={0.35} />
    </svg>
  );
}
