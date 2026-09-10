'use client';

import * as React from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { formatTimecode, type TimeRange } from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface PlayerHandle {
  seek: (time: number) => void;
  play: () => void;
  pause: () => void;
}

/**
 * The review player.
 *
 * "Preview edit" is the feature that matters here: rather than rendering anything, it
 * plays the source and skips the removed ranges as it reaches them, so the creator
 * hears the actual cut before spending a render on it.
 */
export const Player = React.forwardRef<
  PlayerHandle,
  {
    src: string | null;
    poster?: string | null;
    /** Portrait iPhone footage is landscape pixels plus a rotation flag. */
    aspect: number;
    keepRanges: TimeRange[];
    previewEdit: boolean;
    onTimeUpdate: (time: number) => void;
    onDurationKnown?: (duration: number) => void;
    className?: string;
  }
>(function Player(
  { src, poster, aspect, keepRanges, previewEdit, onTimeUpdate, onDurationKnown, className },
  ref,
) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [time, setTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [ready, setReady] = React.useState(false);

  React.useImperativeHandle(ref, () => ({
    seek: (value: number) => {
      const element = videoRef.current;
      if (!element) return;
      element.currentTime = Math.max(0, value);
      setTime(value);
      onTimeUpdate(value);
    },
    play: () => void videoRef.current?.play(),
    pause: () => videoRef.current?.pause(),
  }));

  /** Skip over a removed range the moment playback enters it. */
  const skipIfRemoved = React.useCallback(
    (current: number): boolean => {
      if (!previewEdit || keepRanges.length === 0) return false;
      const inside = keepRanges.some((range) => current >= range.start && current < range.end);
      if (inside) return false;

      const next = keepRanges.find((range) => range.start > current);
      const element = videoRef.current;
      if (!element) return false;

      if (next) {
        element.currentTime = next.start;
      } else {
        element.pause();
        element.currentTime = keepRanges[keepRanges.length - 1]!.end;
      }
      return true;
    },
    [previewEdit, keepRanges],
  );

  React.useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    const onTime = () => {
      const current = element.currentTime;
      if (skipIfRemoved(current)) return;
      setTime(current);
      onTimeUpdate(current);
    };
    const onLoaded = () => {
      setDuration(element.duration);
      setReady(true);
      onDurationKnown?.(element.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    element.addEventListener('timeupdate', onTime);
    element.addEventListener('loadedmetadata', onLoaded);
    element.addEventListener('play', onPlay);
    element.addEventListener('pause', onPause);
    return () => {
      element.removeEventListener('timeupdate', onTime);
      element.removeEventListener('loadedmetadata', onLoaded);
      element.removeEventListener('play', onPlay);
      element.removeEventListener('pause', onPause);
    };
  }, [skipIfRemoved, onTimeUpdate, onDurationKnown]);

  // Turning on preview while sitting inside a cut should jump out of it immediately.
  React.useEffect(() => {
    if (previewEdit) skipIfRemoved(videoRef.current?.currentTime ?? 0);
  }, [previewEdit, skipIfRemoved]);

  const nudge = (delta: number) => {
    const element = videoRef.current;
    if (!element) return;
    element.currentTime = Math.max(0, Math.min(duration || 0, element.currentTime + delta));
  };

  return (
    <div className={cn('overflow-hidden rounded-card border border-border bg-black', className)}>
      <div className="relative w-full bg-black" style={{ aspectRatio: aspect }}>
        {src ? (
          <video
            ref={videoRef}
            src={src}
            poster={poster ?? undefined}
            className="h-full w-full object-contain"
            playsInline
            preload="metadata"
            controls={false}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-white/60">
            No preview is available for this video.
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 bg-surface px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => (playing ? videoRef.current?.pause() : void videoRef.current?.play())}
          disabled={!ready}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={() => nudge(-5)} disabled={!ready} aria-label="Back 5 seconds">
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => nudge(5)} disabled={!ready} aria-label="Forward 5 seconds">
          <SkipForward className="h-4 w-4" />
        </Button>

        <input
          type="range"
          className="scrubber min-w-0 flex-1"
          min={0}
          max={duration || 0}
          step={0.05}
          value={time}
          disabled={!ready}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (videoRef.current) videoRef.current.currentTime = value;
            setTime(value);
            onTimeUpdate(value);
          }}
          aria-label="Seek"
        />

        <span className="shrink-0 text-xs tabular-nums text-ink-muted">
          {formatTimecode(time)} / {formatTimecode(duration || 0)}
        </span>
      </div>
    </div>
  );
});
