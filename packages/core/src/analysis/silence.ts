import type { TimeRange } from '../types/edl.js';
import type { SpeechSegment } from '../types/transcript.js';
import { normalizeRanges, overlapDuration } from '../util/ranges.js';
import { round } from '../util/time.js';

export interface SilenceOptions {
  /** Only gaps strictly longer than this are candidates. */
  thresholdSeconds: number;
  /** Audio kept before speech resumes, in milliseconds. */
  padPreMs: number;
  /** Audio kept after speech stops, in milliseconds. */
  padPostMs: number;
  /**
   * A gap is only cut when this fraction of it is also flagged by ffmpeg's
   * `silencedetect`. Requiring both signals is what stops breaths, quiet consonants
   * and low-volume asides from being treated as dead air.
   */
  minAcousticAgreement: number;
}

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  thresholdSeconds: 1.0,
  padPreMs: 160,
  padPostMs: 200,
  minAcousticAgreement: 0.6,
};

export interface SilenceRemoval extends TimeRange {
  /** Length of the original gap before padding was applied. */
  gapDuration: number;
  /** Fraction of the gap that ffmpeg also considered silent. */
  agreement: number;
}

/**
 * Find removable dead air between speech.
 *
 * Two independent signals must agree: the transcript says nobody is speaking, and the
 * audio itself is quiet. Short natural pauses are never touched, and every cut keeps
 * `padPost` after the previous word and `padPre` before the next one so the result
 * breathes like speech rather than a jump cut.
 */
export function detectSilenceRemovals(
  segments: readonly SpeechSegment[],
  acousticSilence: readonly TimeRange[],
  duration: number,
  options: Partial<SilenceOptions> = {},
): SilenceRemoval[] {
  const opts: SilenceOptions = { ...DEFAULT_SILENCE_OPTIONS, ...options };
  if (segments.length === 0 || duration <= 0) return [];

  const silence = normalizeRanges(acousticSilence, duration);
  const padPre = opts.padPreMs / 1000;
  const padPost = opts.padPostMs / 1000;

  // Speech intervals come from the segments; gaps between them are the candidates,
  // plus the head before the first word and the tail after the last one.
  const speech = normalizeRanges(
    segments.map((segment) => ({ start: segment.start, end: segment.end })),
    duration,
  );

  const gaps: TimeRange[] = [];
  if (speech.length > 0 && speech[0]!.start > 0) gaps.push({ start: 0, end: speech[0]!.start });
  for (let i = 1; i < speech.length; i += 1) {
    gaps.push({ start: speech[i - 1]!.end, end: speech[i]!.start });
  }
  const lastSpeech = speech[speech.length - 1];
  if (lastSpeech && lastSpeech.end < duration) gaps.push({ start: lastSpeech.end, end: duration });

  const removals: SilenceRemoval[] = [];
  for (const gap of gaps) {
    const gapDuration = gap.end - gap.start;
    if (gapDuration <= opts.thresholdSeconds) continue;

    const silentInGap = silence.reduce((sum, range) => sum + overlapDuration(range, gap), 0);
    const agreement = gapDuration > 0 ? silentInGap / gapDuration : 0;
    // Leading/trailing dead air has no speech on one side, so there is nothing for
    // the acoustic check to disagree with; a bare threshold is enough there.
    const isEdgeGap = gap.start === 0 || gap.end === duration;
    if (!isEdgeGap && silence.length > 0 && agreement < opts.minAcousticAgreement) continue;

    const start = gap.start === 0 ? 0 : gap.start + padPost;
    const end = gap.end === duration ? duration : gap.end - padPre;
    if (end - start <= 0.05) continue;

    removals.push({
      start: round(start, 4),
      end: round(end, 4),
      gapDuration: round(gapDuration, 4),
      agreement: round(agreement, 4),
    });
  }

  return removals;
}

/**
 * Parse the stderr of `ffmpeg -af silencedetect`.
 * Exported here (rather than in the media package) so it can be unit-tested without
 * spawning ffmpeg.
 */
export function parseSilenceDetect(stderr: string, duration: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  let pendingStart: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (startMatch) {
      pendingStart = Math.max(0, Number.parseFloat(startMatch[1]!));
      continue;
    }
    const endMatch = /silence_end:\s*([\d.]+)/.exec(line);
    if (endMatch && pendingStart !== null) {
      const end = Number.parseFloat(endMatch[1]!);
      if (Number.isFinite(end) && end > pendingStart) ranges.push({ start: pendingStart, end });
      pendingStart = null;
    }
  }
  // A trailing `silence_start` with no `silence_end` means the file ends in silence.
  if (pendingStart !== null && duration > pendingStart) {
    ranges.push({ start: pendingStart, end: duration });
  }
  return normalizeRanges(ranges, duration);
}
