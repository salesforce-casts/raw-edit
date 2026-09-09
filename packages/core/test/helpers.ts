import type { TranscriptWord } from '../src/types/transcript.js';

/**
 * Build word-level transcript output from a script.
 *
 * `utterance(start, "Today I'll show you.", { wps })` lays the words out evenly across
 * the utterance, which is enough for the analysis layer — it only ever looks at word
 * boundaries and the gaps between them.
 */
export function utterance(
  start: number,
  text: string,
  options: { wordsPerSecond?: number; confidence?: number } = {},
): TranscriptWord[] {
  const wps = options.wordsPerSecond ?? 3;
  const confidence = options.confidence ?? 0.95;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const perWord = 1 / wps;
  return tokens.map((token, index) => ({
    text: token,
    start: Number((start + index * perWord).toFixed(4)),
    end: Number((start + index * perWord + perWord * 0.85).toFixed(4)),
    confidence,
  }));
}

/** Concatenate utterances, each starting at its own absolute time. */
export function script(...groups: TranscriptWord[][]): TranscriptWord[] {
  return groups.flat();
}

export function lastEnd(words: TranscriptWord[]): number {
  return words.length === 0 ? 0 : words[words.length - 1]!.end;
}
