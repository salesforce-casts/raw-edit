import type { Word } from "./types";
import { KEYFRAME_SNAP_MS } from "./types";
import type { MsRange } from "./ranges";

export type SnapTargets = {
  wordBoundaryMs: number[];
  keyframeMs: number[];
  silentGaps: MsRange[];
  windowMs?: number;
};

function nearest(value: number, candidates: number[], windowMs: number): number | undefined {
  let best: number | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance <= windowMs && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function insideSilentGap(fromMs: number, toMs: number, gaps: MsRange[]): boolean {
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  return gaps.some((gap) => lo >= gap.startMs && hi <= gap.endMs);
}

export function wordBoundaryMs(words: Word[]): number[] {
  const times = new Set<number>();
  for (const word of words) {
    times.add(word.startMs);
    times.add(word.endMs);
  }
  return [...times].sort((a, b) => a - b);
}

export function snapCutMs(timeMs: number, targets: SnapTargets): number {
  const windowMs = targets.windowMs ?? KEYFRAME_SNAP_MS;
  const wordHit = nearest(timeMs, targets.wordBoundaryMs, windowMs);
  if (wordHit != null) return wordHit;
  const keyHit = nearest(timeMs, targets.keyframeMs, windowMs);
  if (keyHit != null && insideSilentGap(timeMs, keyHit, targets.silentGaps)) return keyHit;
  return timeMs;
}

export function snapSegmentBounds<T extends { startMs: number; endMs: number }>(segment: T, targets: SnapTargets): T {
  const startMs = snapCutMs(segment.startMs, targets);
  const endMs = snapCutMs(segment.endMs, targets);
  if (endMs <= startMs) return segment;
  return { ...segment, startMs, endMs };
}
