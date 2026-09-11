import {
  ACOUSTIC_MIN_SILENCE_MS,
  DEFAULT_PACING_PRESET,
  HEAD_TAIL_KEEP_MS,
  type EditSegment,
  type PacingPreset,
  type TranscriptSegment,
  type Word,
} from "./types";
import { clampRange, intersectRanges, type MsRange } from "./ranges";

export type SilenceSettings = {
  minSilenceMs: number;
  preRollMs: number;
  postRollMs: number;
  headTailKeepMs: number;
};

export const PACING_SETTINGS: Record<PacingPreset, SilenceSettings> = {
  natural: { minSilenceMs: 400, preRollMs: 80, postRollMs: 60, headTailKeepMs: HEAD_TAIL_KEEP_MS },
  tight: { minSilenceMs: 350, preRollMs: 80, postRollMs: 60, headTailKeepMs: HEAD_TAIL_KEEP_MS },
  very_tight: { minSilenceMs: 250, preRollMs: 40, postRollMs: 30, headTailKeepMs: 80 },
};

export const DEFAULT_SILENCE_SETTINGS: SilenceSettings = PACING_SETTINGS[DEFAULT_PACING_PRESET];

const SENTENCE_END = /[.!?…]["'”’)]*$/;

export function flattenWords(segments: TranscriptSegment[]): Word[] {
  const nested = segments.flatMap((segment) => segment.words ?? []);
  if (nested.length > 0) return nested;
  return segments.map((segment) => ({
    text: segment.text,
    startMs: segment.startMs,
    endMs: segment.endMs,
    confidence: segment.confidence,
  }));
}

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

export function transcriptGaps(segments: TranscriptSegment[], durationMs: number): MsRange[] {
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs);
  const gaps: MsRange[] = [];
  let cursor = 0;
  for (const segment of ordered) {
    if (segment.startMs - cursor >= 1) gaps.push({ startMs: cursor, endMs: segment.startMs });
    cursor = Math.max(cursor, segment.endMs);
  }
  if (durationMs - cursor >= 1) gaps.push({ startMs: cursor, endMs: durationMs });
  return gaps;
}

export function confirmedSilence(
  acoustic: MsRange[],
  transcript: TranscriptSegment[],
  durationMs: number,
): MsRange[] {
  return intersectRanges(acoustic, transcriptGaps(transcript, durationMs));
}

export type GapKind = "head" | "tail" | "inter-sentence" | "intra-sentence";

export function classifyGap(gap: MsRange, words: Word[], durationMs: number): GapKind {
  const first = words[0];
  const last = words[words.length - 1];
  if (!first || !last) {
    if (gap.startMs <= 0) return "head";
    if (gap.endMs >= durationMs) return "tail";
    return "inter-sentence";
  }
  if (gap.endMs <= first.startMs) return "head";
  if (gap.startMs >= last.endMs) return "tail";
  const before = [...words].reverse().find((word) => word.endMs <= gap.startMs + 1);
  if (before && endsSentence(before.text)) return "inter-sentence";
  return "intra-sentence";
}

function padRemoval(
  region: MsRange,
  settings: SilenceSettings,
  speechBefore: boolean,
  speechAfter: boolean,
): MsRange | null {
  let startMs = region.startMs;
  let endMs = region.endMs;
  if (speechBefore) startMs += settings.postRollMs;
  if (speechAfter) endMs -= settings.preRollMs;
  if (endMs - startMs < 120) return null;
  return { startMs, endMs };
}

export function silenceRemovals(
  silences: MsRange[],
  durationMs: number,
  transcript: TranscriptSegment[] = [],
  pacing: PacingPreset | SilenceSettings = DEFAULT_PACING_PRESET,
): EditSegment[] {
  const settings = typeof pacing === "string" ? PACING_SETTINGS[pacing] : pacing;
  const words = flattenWords(transcript);
  const decisions: EditSegment[] = [];
  for (const silence of silences) {
    const region = clampRange(silence, durationMs);
    const kind = classifyGap(region, words, durationMs);
    if (kind === "intra-sentence") continue;

    if (kind === "head") {
      const keepFrom = Math.max(region.startMs, region.endMs - settings.headTailKeepMs);
      if (keepFrom - region.startMs < 120) continue;
      decisions.push({
        startMs: region.startMs,
        endMs: keepFrom,
        action: "REMOVE",
        source: "AUTO_SILENCE",
        reason: `Head gap trimmed to ${settings.headTailKeepMs}ms before speech.`,
        confidence: 0.9,
      });
      continue;
    }

    if (kind === "tail") {
      const keepTo = Math.min(region.endMs, region.startMs + settings.headTailKeepMs);
      if (region.endMs - keepTo < 120) continue;
      decisions.push({
        startMs: keepTo,
        endMs: region.endMs,
        action: "REMOVE",
        source: "AUTO_SILENCE",
        reason: `Tail gap trimmed to ${settings.headTailKeepMs}ms after speech.`,
        confidence: 0.9,
      });
      continue;
    }

    const length = region.endMs - region.startMs;
    if (length < settings.minSilenceMs) continue;
    const speechBefore = words.some((word) => word.endMs <= region.startMs + 1);
    const speechAfter = words.some((word) => word.startMs >= region.endMs - 1);
    const padded = padRemoval(region, settings, speechBefore, speechAfter);
    if (!padded) continue;
    decisions.push({
      startMs: padded.startMs,
      endMs: padded.endMs,
      action: "REMOVE",
      source: "AUTO_SILENCE",
      reason: `Inter-sentence silence longer than ${settings.minSilenceMs}ms.`,
      confidence: Math.min(0.99, 0.72 + (length - settings.minSilenceMs) / 8000),
    });
  }
  return decisions;
}

export function dualSignalSilenceRemovals(
  acoustic: MsRange[],
  transcript: TranscriptSegment[],
  durationMs: number,
  pacing: PacingPreset | SilenceSettings = DEFAULT_PACING_PRESET,
): EditSegment[] {
  return silenceRemovals(confirmedSilence(acoustic, transcript, durationMs), durationMs, transcript, pacing);
}

export function parseSilencedetect(stderr: string): MsRange[] {
  const starts: number[] = [];
  const regions: MsRange[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) starts.push(Number(start[1]) * 1000);
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end) {
      const endMs = Number(end[1]) * 1000;
      const startMs = starts.shift() ?? endMs;
      regions.push({ startMs, endMs });
    }
  }
  return regions;
}

export function parseRmsLevels(text: string): number[] {
  const levels: number[] = [];
  for (const match of text.matchAll(/RMS_level=(-?[0-9.]+)/g)) {
    levels.push(Number(match[1]));
  }
  return levels.filter((value) => Number.isFinite(value));
}

export function noiseFloorDbFromRms(rmsDb: number[]): number | undefined {
  if (rmsDb.length === 0) return undefined;
  const sorted = [...rmsDb].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1)));
  return sorted[index];
}

export function acousticMinSilenceSeconds(): number {
  return ACOUSTIC_MIN_SILENCE_MS / 1000;
}
