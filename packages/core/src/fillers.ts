import type { EditSegment, TranscriptSegment, Word } from "./types";
import { fillerTokens, tokenize } from "./text";

const FILLER_MAX_MS = 900;

export function fillerRemovals(segments: TranscriptSegment[], enabled: boolean): EditSegment[] {
  if (!enabled) return [];
  const removals: EditSegment[] = [];
  for (const segment of segments) {
    const fillers = fillerTokens(segment.text);
    if (fillers.length === 0) continue;
    const words = segment.words.length > 0 ? segment.words : estimateWords(segment);
    for (const word of words) {
      const token = tokenize(word.text)[0];
      if (!token || !fillers.includes(token)) continue;
      if (word.endMs - word.startMs > FILLER_MAX_MS) continue;
      removals.push({
        startMs: word.startMs,
        endMs: word.endMs,
        action: "REMOVE",
        source: "AUTO_FILLER",
        reason: `Filler “${word.text}”`,
        confidence: 0.6,
      });
    }
  }
  return removals;
}

function estimateWords(segment: TranscriptSegment): Word[] {
  const tokens = tokenize(segment.text);
  if (tokens.length === 0) return [];
  const span = Math.max(1, segment.endMs - segment.startMs);
  return tokens.map((token, index) => ({
    text: token,
    startMs: segment.startMs + Math.round((index / tokens.length) * span),
    endMs: segment.startMs + Math.round(((index + 1) / tokens.length) * span),
  }));
}
