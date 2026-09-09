import type { EditDecision, EditSettings, TimeRange } from '../types/edl.js';
import { DEFAULT_EDIT_SETTINGS } from '../types/edl.js';
import { invertRanges, mergeCloseRanges, normalizeRanges } from '../util/ranges.js';
import { round } from '../util/time.js';

export interface RenderPlanOptions {
  duration: number;
  /** Source frame rate; keep ranges are snapped to this grid to protect A/V sync. */
  frameRate: number;
  minSegmentSeconds?: number;
  mergeGapMs?: number;
}

export interface RenderPlan {
  keepRanges: TimeRange[];
  outputDuration: number;
  removedDuration: number;
  /** Number of joins in the output; zero means the whole file is kept. */
  cutCount: number;
  /** True when nothing is removed and the render is a straight re-encode. */
  isPassthrough: boolean;
}

/**
 * Turn the active EDL into the exact set of ranges ffmpeg will keep.
 *
 * The last step — snapping to the frame grid — is what keeps audio and video locked
 * together. With whole-frame ranges, each kept span has an exact number of frames and
 * an exactly matching number of audio samples, so per-cut rounding cannot accumulate
 * into drift over a long recording.
 */
export function buildRenderPlan(
  decisions: readonly EditDecision[],
  options: RenderPlanOptions,
): RenderPlan {
  const duration = Math.max(0, options.duration);
  const minSegment = options.minSegmentSeconds ?? DEFAULT_EDIT_SETTINGS.minSegmentSeconds;
  const mergeGap = (options.mergeGapMs ?? DEFAULT_EDIT_SETTINGS.mergeGapMs) / 1000;
  const fps = options.frameRate > 0 ? options.frameRate : 30;

  const removals = normalizeRanges(
    decisions
      .filter((decision) => decision.decision === 'remove')
      .map((decision) => ({ start: decision.startTime, end: decision.endTime })),
    duration,
  );

  let keep = invertRanges(removals, duration);
  keep = mergeCloseRanges(keep, mergeGap);
  keep = keep.filter((range) => range.end - range.start >= minSegment);
  keep = keep.map((range) => snapToFrameGrid(range, fps, duration));
  keep = mergeCloseRanges(keep, 1 / fps / 2).filter((range) => range.end > range.start);

  const outputDuration = round(keep.reduce((sum, range) => sum + (range.end - range.start), 0), 4);
  return {
    keepRanges: keep,
    outputDuration,
    removedDuration: round(Math.max(0, duration - outputDuration), 4),
    cutCount: Math.max(0, keep.length - 1),
    isPassthrough: keep.length === 1 && keep[0]!.start <= 1 / fps && duration - keep[0]!.end <= 1 / fps,
  };
}

/** Expand a range outwards to the nearest whole frame boundaries. */
export function snapToFrameGrid(range: TimeRange, frameRate: number, duration: number): TimeRange {
  const frame = 1 / frameRate;
  const start = Math.max(0, Math.floor(range.start / frame) * frame);
  const end = Math.min(duration, Math.ceil(range.end / frame) * frame);
  return { start: round(start, 6), end: round(Math.max(end, start + frame), 6) };
}

/**
 * Padding is applied when the EDL is built, but a user who drags a cut handle in the
 * review UI expects the same protection. This re-applies padding around a set of
 * removals without letting neighbouring removals swallow each other.
 */
export function applyPadding(
  removals: readonly TimeRange[],
  settings: Pick<EditSettings, 'padPreMs' | 'padPostMs'>,
  duration: number,
): TimeRange[] {
  const padPre = settings.padPreMs / 1000;
  const padPost = settings.padPostMs / 1000;
  const sorted = normalizeRanges(removals, duration);

  return sorted
    .map((range) => {
      const start = range.start === 0 ? 0 : range.start + padPost;
      const end = range.end >= duration ? duration : range.end - padPre;
      return { start: round(start, 4), end: round(end, 4) };
    })
    .filter((range) => range.end - range.start > 0.02);
}
