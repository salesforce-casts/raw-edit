import type { EditSegment } from "./types";

export type MsRange = { startMs: number; endMs: number };

export function durationMs(range: MsRange): number {
  return Math.max(0, range.endMs - range.startMs);
}

export function mergeRanges(ranges: MsRange[]): MsRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs);
  const merged: MsRange[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.startMs <= last.endMs + 10) {
      last.endMs = Math.max(last.endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function intersectRanges(left: MsRange[], right: MsRange[]): MsRange[] {
  const a = mergeRanges(left);
  const b = mergeRanges(right);
  const out: MsRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].startMs, b[j].startMs);
    const end = Math.min(a[i].endMs, b[j].endMs);
    if (end > start) out.push({ startMs: start, endMs: end });
    if (a[i].endMs < b[j].endMs) i += 1;
    else j += 1;
  }
  return out;
}

export function subtractRanges(source: MsRange, removals: MsRange[]): MsRange[] {
  let remaining: MsRange[] = [{ ...source }];
  for (const removal of mergeRanges(removals)) {
    const next: MsRange[] = [];
    for (const piece of remaining) {
      if (removal.endMs <= piece.startMs || removal.startMs >= piece.endMs) {
        next.push(piece);
        continue;
      }
      if (removal.startMs > piece.startMs) {
        next.push({ startMs: piece.startMs, endMs: Math.max(piece.startMs, removal.startMs) });
      }
      if (removal.endMs < piece.endMs) {
        next.push({ startMs: Math.min(piece.endMs, removal.endMs), endMs: piece.endMs });
      }
    }
    remaining = next.filter((range) => durationMs(range) > 20);
  }
  return remaining;
}

export function clampRange(range: MsRange, duration: number): MsRange {
  return {
    startMs: Math.max(0, Math.min(range.startMs, duration)),
    endMs: Math.max(0, Math.min(range.endMs, duration)),
  };
}

export function keepRangesFromEdl(segments: EditSegment[]): MsRange[] {
  return mergeRanges(
    segments
      .filter((segment) => segment.action === "KEEP")
      .map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs })),
  );
}

export function originalDuration(segments: EditSegment[]): number {
  return segments.reduce((max, segment) => Math.max(max, segment.endMs), 0);
}

export function proposedDuration(segments: EditSegment[]): number {
  return segments
    .filter((segment) => segment.action === "KEEP")
    .reduce((sum, segment) => sum + durationMs(segment), 0);
}

export function overlaps(a: MsRange, b: MsRange): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}
