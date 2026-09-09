import type { EditSegment } from "@raw-edit/contracts";

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
    segments.filter((segment) => segment.action === "KEEP").map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
    })),
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

export function buildCoveringEdl(
  durationMsValue: number,
  removals: Array<EditSegment & { action: "REMOVE" }>,
): EditSegment[] {
  const keep = subtractRanges({ startMs: 0, endMs: durationMsValue }, removals);
  const pieces: EditSegment[] = [
    ...keep.map((range) => ({
      startMs: range.startMs,
      endMs: range.endMs,
      action: "KEEP" as const,
      source: "SYSTEM" as const,
      reason: "Retained speech",
      confidence: 1,
    })),
    ...removals,
  ].sort((a, b) => a.startMs - b.startMs || (a.action === "REMOVE" ? -1 : 1));
  return pieces;
}
