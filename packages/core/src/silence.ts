import {
  DEFAULT_MIN_SILENCE_MS,
  DEFAULT_POST_ROLL_MS,
  DEFAULT_PRE_ROLL_MS,
  type EditSegment,
  type TranscriptSegment,
} from "./types";
import { clampRange, intersectRanges, type MsRange } from "./ranges";

export type SilenceSettings = {
  minSilenceMs: number;
  preRollMs: number;
  postRollMs: number;
};

export const DEFAULT_SILENCE_SETTINGS: SilenceSettings = {
  minSilenceMs: DEFAULT_MIN_SILENCE_MS,
  preRollMs: DEFAULT_PRE_ROLL_MS,
  postRollMs: DEFAULT_POST_ROLL_MS,
};

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

export function silenceRemovals(
  silences: MsRange[],
  durationMs: number,
  settings: SilenceSettings = DEFAULT_SILENCE_SETTINGS,
): EditSegment[] {
  const decisions: EditSegment[] = [];
  for (const silence of silences) {
    const region = clampRange(silence, durationMs);
    const length = region.endMs - region.startMs;
    if (length < settings.minSilenceMs) continue;
    const startMs = region.startMs + settings.postRollMs;
    const endMs = region.endMs - settings.preRollMs;
    if (endMs - startMs < 120) continue;
    decisions.push({
      startMs,
      endMs,
      action: "REMOVE",
      source: "AUTO_SILENCE",
      reason: `Silence longer than ${settings.minSilenceMs}ms; kept ${settings.postRollMs}ms after speech and ${settings.preRollMs}ms before the next phrase.`,
      confidence: Math.min(0.99, 0.72 + (length - settings.minSilenceMs) / 8000),
    });
  }
  return decisions;
}

export function dualSignalSilenceRemovals(
  acoustic: MsRange[],
  transcript: TranscriptSegment[],
  durationMs: number,
  settings: SilenceSettings = DEFAULT_SILENCE_SETTINGS,
): EditSegment[] {
  return silenceRemovals(confirmedSilence(acoustic, transcript, durationMs), durationMs, settings);
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
