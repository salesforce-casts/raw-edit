import type { TimeRange } from '../types/edl.js';
import { clamp, round } from './time.js';

/** Sort, clip to bounds and merge overlapping/adjacent ranges. */
export function normalizeRanges(ranges: readonly TimeRange[], duration: number): TimeRange[] {
  const clipped = ranges
    .map((range) => ({
      start: clamp(Math.min(range.start, range.end), 0, duration),
      end: clamp(Math.max(range.start, range.end), 0, duration),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: TimeRange[] = [];
  for (const range of clipped) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Complement of `ranges` within [0, duration]. */
export function invertRanges(ranges: readonly TimeRange[], duration: number): TimeRange[] {
  const normalized = normalizeRanges(ranges, duration);
  const out: TimeRange[] = [];
  let cursor = 0;
  for (const range of normalized) {
    if (range.start > cursor) out.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < duration) out.push({ start: cursor, end: duration });
  return out.filter((range) => range.end > range.start).map((r) => ({ start: round(r.start, 4), end: round(r.end, 4) }));
}

export function totalDuration(ranges: readonly TimeRange[]): number {
  return round(ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0), 4);
}

export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function overlapDuration(a: TimeRange, b: TimeRange): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Merge ranges separated by less than `gap` seconds. */
export function mergeCloseRanges(ranges: readonly TimeRange[], gap: number): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i += 1) {
    const range = sorted[i]!;
    const last = out[out.length - 1]!;
    if (range.start - last.end < gap) {
      last.end = Math.max(last.end, range.end);
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/** Map a time on the original timeline to the corresponding time on the edited one. */
export function mapToEditedTime(keepRanges: readonly TimeRange[], sourceTime: number): number | null {
  let elapsed = 0;
  for (const range of keepRanges) {
    if (sourceTime < range.start) return null;
    if (sourceTime <= range.end) return round(elapsed + (sourceTime - range.start), 4);
    elapsed += range.end - range.start;
  }
  return null;
}

/** Inverse of `mapToEditedTime`. */
export function mapToSourceTime(keepRanges: readonly TimeRange[], editedTime: number): number | null {
  let elapsed = 0;
  for (const range of keepRanges) {
    const length = range.end - range.start;
    if (editedTime <= elapsed + length) return round(range.start + (editedTime - elapsed), 4);
    elapsed += length;
  }
  return null;
}
