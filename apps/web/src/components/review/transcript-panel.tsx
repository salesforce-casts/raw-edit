'use client';

import * as React from 'react';
import { Check, RotateCcw, Scissors, Undo2 } from 'lucide-react';
import { formatPreciseTimecode, type EditDecision } from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { CUT_STYLES } from '@/components/review/edit-colors';
import type { ReviewSegment, TakeRow } from '@/components/review/types';
import { cn } from '@/lib/utils';

/**
 * The timestamped transcript.
 *
 * Removed text is struck through and tinted by the reason it was removed, so the
 * creator can read the edit as prose rather than as a list of timecodes. Every
 * segment carries the removal's own explanation, because "why is this being cut?"
 * is the question the whole review screen exists to answer.
 */
export function TranscriptPanel({
  segments,
  decisions,
  takes,
  currentTime,
  onSeek,
  onRestore,
  onRemoveSegment,
  onKeepTake,
  className,
}: {
  segments: ReviewSegment[];
  decisions: EditDecision[];
  takes: TakeRow[];
  currentTime: number;
  onSeek: (time: number) => void;
  onRestore: (decisionId: string) => void;
  onRemoveSegment: (segment: ReviewSegment) => void;
  onKeepTake: (takeId: string, segmentIndex: number) => void;
  className?: string;
}) {
  const activeRef = React.useRef<HTMLLIElement>(null);
  const [followPlayhead, setFollowPlayhead] = React.useState(true);

  /** The removal covering most of a segment, if any. */
  const removalFor = React.useCallback(
    (segment: ReviewSegment): EditDecision | null => {
      const span = segment.endTime - segment.startTime;
      if (span <= 0) return null;
      let best: EditDecision | null = null;
      let bestOverlap = 0;
      for (const decision of decisions) {
        if (decision.decision !== 'remove') continue;
        const overlap =
          Math.min(decision.endTime, segment.endTime) - Math.max(decision.startTime, segment.startTime);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = decision;
        }
      }
      return bestOverlap / span > 0.6 ? best : null;
    },
    [decisions],
  );

  const takeForSegment = React.useCallback(
    (index: number): TakeRow | null =>
      takes.find((take) => take.members.some((member) => member.segmentIndex === index)) ?? null,
    [takes],
  );

  const activeIndex = segments.findIndex(
    (segment) => currentTime >= segment.startTime && currentTime <= segment.endTime,
  );

  React.useEffect(() => {
    if (!followPlayhead || activeIndex < 0) return;
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIndex, followPlayhead]);

  if (segments.length === 0) {
    return (
      <div className={cn('rounded-card border border-dashed border-border p-6 text-center', className)}>
        <p className="text-sm text-ink-muted">
          No speech was found in this recording, so there is no transcript to review.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-2 pb-2">
        <h2 className="text-sm font-medium text-ink">Transcript</h2>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-subtle">
          <input
            type="checkbox"
            checked={followPlayhead}
            onChange={(event) => setFollowPlayhead(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
          />
          Follow playback
        </label>
      </div>

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {segments.map((segment, index) => {
          const removal = removalFor(segment);
          const take = takeForSegment(segment.index);
          const style = removal ? CUT_STYLES[removal.kind] : null;
          const isActive = index === activeIndex;

          return (
            <li
              key={segment.id}
              ref={isActive ? activeRef : null}
              className={cn(
                'group rounded-xl border p-2.5 transition-colors',
                isActive ? 'border-accent/50 bg-accent-soft/40' : 'border-transparent',
                removal ? cn(style!.bg, style!.border) : 'hover:bg-surface-muted',
              )}
            >
              <div className="flex items-start gap-2.5">
                <button
                  type="button"
                  onClick={() => onSeek(segment.startTime)}
                  className="shrink-0 pt-0.5 text-xs tabular-nums text-ink-subtle hover:text-accent"
                  aria-label={`Jump to ${formatPreciseTimecode(segment.startTime)}`}
                >
                  {formatPreciseTimecode(segment.startTime)}
                </button>

                <button
                  type="button"
                  onClick={() => onSeek(segment.startTime)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p
                    className={cn(
                      'text-sm leading-relaxed',
                      removal ? cn('line-through decoration-2', style!.text) : 'text-ink',
                    )}
                  >
                    {segment.text}
                  </p>
                </button>

                <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:opacity-60">
                  {removal ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => onRestore(removal.id)}
                      aria-label="Keep this segment"
                      title="Keep this segment"
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => onRemoveSegment(segment)}
                      aria-label="Remove this segment"
                      title="Remove this segment"
                    >
                      <Scissors className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              {removal ? (
                <p className={cn('mt-1.5 pl-[3.4rem] text-xs', style!.text)}>
                  {removal.reason}
                  {removal.source === 'auto' ? (
                    <span className="text-ink-subtle">
                      {' '}
                      · {Math.round(removal.confidence * 100)}% confident
                    </span>
                  ) : null}
                </p>
              ) : null}

              {take && take.memberCount > 1 ? (
                <TakeControls
                  take={take}
                  segmentIndex={segment.index}
                  onKeepTake={onKeepTake}
                  onSeek={onSeek}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * When several attempts at one line are grouped, each shows which take is kept and
 * offers a one-tap switch — the fastest correction on the whole screen.
 */
function TakeControls({
  take,
  segmentIndex,
  onKeepTake,
  onSeek,
}: {
  take: TakeRow;
  segmentIndex: number;
  onKeepTake: (takeId: string, segmentIndex: number) => void;
  onSeek: (time: number) => void;
}) {
  const member = take.members.find((item) => item.segmentIndex === segmentIndex);
  if (!member) return null;
  const position = take.members.findIndex((item) => item.segmentIndex === segmentIndex) + 1;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 pl-[3.4rem]">
      <span className="text-xs text-ink-subtle">
        Take {position} of {take.memberCount}
      </span>
      {member.isChosen ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-xs font-medium text-success">
          <Check className="h-3 w-3" aria-hidden />
          Keeping this one
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onKeepTake(take.id, segmentIndex)}
        >
          <RotateCcw className="h-3 w-3" aria-hidden />
          Keep this take instead
        </Button>
      )}
      <button
        type="button"
        onClick={() => onSeek(member.startTime)}
        className="text-xs text-ink-subtle underline-offset-2 hover:underline"
      >
        Play it
      </button>
    </div>
  );
}
