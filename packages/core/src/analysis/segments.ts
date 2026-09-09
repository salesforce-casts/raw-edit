import {
  DEFAULT_SEGMENTATION,
  type SegmentationOptions,
  type SpeechSegment,
  type TranscriptWord,
} from '../types/transcript.js';
import { buildFillerMatcher, endsWithTerminator, tokenize } from '../text/normalize.js';

/**
 * Group word-level transcript output into utterances.
 *
 * Split when the gap to the next word reaches `gapSeconds`, or when the current word
 * ends a sentence and the gap reaches the smaller `sentenceGapSeconds` — a speaker who
 * finishes a sentence and takes a short breath has started a new thought.
 */
export function segmentWords(
  words: readonly TranscriptWord[],
  options: Partial<SegmentationOptions> = {},
): SpeechSegment[] {
  const opts: SegmentationOptions = { ...DEFAULT_SEGMENTATION, ...options };
  const usable = words.filter((word) => word.text.trim() !== '' && word.end > word.start);
  if (usable.length === 0) return [];

  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [usable[0]!];

  for (let i = 1; i < usable.length; i += 1) {
    const previous = usable[i - 1]!;
    const word = usable[i]!;
    const gap = word.start - previous.end;
    const terminated = endsWithTerminator(previous.text);
    const shouldSplit = gap >= opts.gapSeconds || (terminated && gap >= opts.sentenceGapSeconds);
    if (shouldSplit) {
      groups.push(current);
      current = [word];
    } else {
      current.push(word);
    }
  }
  groups.push(current);

  return groups.map((group, index) => buildSegment(group, index, opts));
}

function buildSegment(words: TranscriptWord[], index: number, opts: SegmentationOptions): SpeechSegment {
  const text = words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
  const tokens = tokenize(text);

  let internalPauseCount = 0;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i]!.start - words[i - 1]!.end >= opts.internalPauseSeconds) internalPauseCount += 1;
  }

  const { fillerCount, fillerWordIndices } = tagFillers(words, opts.fillerPhrases);
  const confidence =
    words.length === 0 ? 0 : words.reduce((sum, word) => sum + word.confidence, 0) / words.length;

  return {
    index,
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text,
    normalizedText: tokens.join(' '),
    tokens,
    contentTokens: stripFillers(tokens, opts.fillerPhrases),
    words,
    confidence,
    endsWithTerminator: endsWithTerminator(words[words.length - 1]!.text),
    internalPauseCount,
    fillerCount,
    fillerWordIndices,
  };
}

/** Remove filler phrases from a token list. Used for comparison, never for cutting. */
export function stripFillers(tokens: readonly string[], phrases: readonly string[]): string[] {
  const matcher = buildFillerMatcher(phrases);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const length = matcher(tokens, i);
    if (length > 0) {
      i += length;
    } else {
      out.push(tokens[i]!);
      i += 1;
    }
  }
  return out;
}

/**
 * One normalised token per word, so the index maps straight back to a timestamp.
 * Contractions expand to several tokens ("i'll" -> "i will"), which would break that
 * mapping, so the expansion is joined back into a single comparable string.
 */
export function perWordTokens(words: readonly TranscriptWord[]): string[] {
  return words.map((word) => tokenize(word.text).join(''));
}

/**
 * Tag filler words/phrases against the *word array* (not the joined text) so we keep
 * the mapping back to timestamps, which is what makes filler removal possible at all.
 */
export function tagFillers(
  words: readonly TranscriptWord[],
  phrases: readonly string[],
): { fillerCount: number; fillerWordIndices: number[] } {
  const matcher = buildFillerMatcher(phrases);
  const tokens = perWordTokens(words);

  const indices: number[] = [];
  let i = 0;
  while (i < tokens.length) {
    const length = matcher(tokens, i);
    if (length > 0) {
      for (let k = 0; k < length; k += 1) indices.push(i + k);
      i += length;
    } else {
      i += 1;
    }
  }
  return { fillerCount: indices.length, fillerWordIndices: indices };
}

/** Words-per-second, used to spot a rushed, aborted take. */
export function speechRate(segment: SpeechSegment): number {
  const duration = segment.end - segment.start;
  if (duration <= 0) return 0;
  return segment.words.length / duration;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
