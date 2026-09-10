import type { EditOverride, EditSegment } from "./types";
import { mergeRanges, overlaps, subtractRanges, type MsRange } from "./ranges";

const SOURCE_PRIORITY: Record<NonNullable<EditSegment["source"]>, number> = {
  USER: 4,
  AUTO_RETAKE: 3,
  AUTO_SILENCE: 2,
  AUTO_FILLER: 1,
  SYSTEM: 0,
};

export function sourcePriority(source: EditSegment["source"]): number {
  return SOURCE_PRIORITY[source ?? "SYSTEM"];
}

export function resolveOverlappingRemovals(removals: Array<EditSegment & { action: "REMOVE" }>): Array<EditSegment & { action: "REMOVE" }> {
  const sorted = [...removals].sort((a, b) => sourcePriority(b.source) - sourcePriority(a.source) || a.startMs - b.startMs);
  const kept: Array<EditSegment & { action: "REMOVE" }> = [];
  for (const candidate of sorted) {
    if (kept.some((existing) => overlaps(existing, candidate) && sourcePriority(existing.source) >= sourcePriority(candidate.source))) {
      continue;
    }
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.startMs - b.startMs);
}

export function buildCoveringEdl(
  durationMsValue: number,
  removals: Array<EditSegment & { action: "REMOVE" }>,
): EditSegment[] {
  const resolved = resolveOverlappingRemovals(removals);
  const keep = subtractRanges({ startMs: 0, endMs: durationMsValue }, resolved);
  return [
    ...keep.map((range) => ({
      startMs: range.startMs,
      endMs: range.endMs,
      action: "KEEP" as const,
      source: "SYSTEM" as const,
      reason: "Retained speech",
      confidence: 1,
    })),
    ...resolved,
  ].sort((a, b) => a.startMs - b.startMs || (a.action === "REMOVE" ? -1 : 1));
}

export function applyOverrides(auto: EditSegment[], overrides: EditOverride[]): EditSegment[] {
  let current = auto.map((segment) => ({ ...segment }));
  for (const override of overrides) {
    const next: EditSegment[] = [];
    for (const segment of current) {
      if (!overlaps(segment, override)) {
        next.push(segment);
        continue;
      }
      const before = segment.startMs < override.startMs;
      const after = segment.endMs > override.endMs;
      if (before) {
        next.push({ ...segment, endMs: override.startMs });
      }
      if (segment.startMs < override.endMs && segment.endMs > override.startMs) {
        next.push({
          startMs: Math.max(segment.startMs, override.startMs),
          endMs: Math.min(segment.endMs, override.endMs),
          action: override.action,
          source: "USER",
          reason: override.reason ?? "Manual edit",
          confidence: 1,
        });
      }
      if (after) {
        next.push({ ...segment, startMs: override.endMs });
      }
    }
    current = next.filter((segment) => segment.endMs - segment.startMs > 20);
  }
  return current.sort((a, b) => a.startMs - b.startMs);
}

export function undoOverrides(overrides: EditOverride[]): EditOverride[] {
  return overrides.slice(0, -1);
}

export function overrideFromToggle(segment: EditSegment): EditOverride {
  return {
    startMs: segment.startMs,
    endMs: segment.endMs,
    action: segment.action === "REMOVE" ? "KEEP" : "REMOVE",
    reason: "Manual toggle",
  };
}

export function keepAllEdl(durationMs: number): EditSegment[] {
  return [
    {
      startMs: 0,
      endMs: durationMs,
      action: "KEEP",
      source: "SYSTEM",
      reason: "Full timeline kept until automatic detection runs",
      confidence: 1,
    },
  ];
}

export function coveringKeepRanges(segments: EditSegment[]): MsRange[] {
  return mergeRanges(
    segments.filter((segment) => segment.action === "KEEP").map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
    })),
  );
}
