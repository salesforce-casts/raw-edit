/** Word-level transcription output. Word timings are mandatory across all providers. */
export interface TranscriptWord {
  /** Verbatim word as the provider emitted it, punctuation included. */
  text: string;
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  /** 0..1 where the provider supplies it, otherwise 1. */
  confidence: number;
}

export interface TranscriptResult {
  words: TranscriptWord[];
  /** BCP-47 where known. */
  language: string | null;
  provider: string;
  model: string | null;
  /** Mean word confidence. */
  confidence: number;
  /** Provider payload, kept for debugging and re-segmentation without re-billing. */
  raw?: unknown;
}

/** A speech utterance: consecutive words with no long pause between them. */
export interface SpeechSegment {
  /** Stable index within the transcript, 0-based. */
  index: number;
  start: number;
  end: number;
  /** Original text with punctuation. */
  text: string;
  /** Lowercased, punctuation-stripped, contraction-expanded. */
  normalizedText: string;
  /** Normalised tokens used by all comparison code. */
  tokens: string[];
  /**
   * `tokens` with filler phrases removed. Comparison uses whichever of the two gives
   * the stronger signal, so an "um" in the middle of a retake cannot hide it.
   */
  contentTokens: string[];
  words: TranscriptWord[];
  confidence: number;
  /** Ends in `.`, `!` or `?`. */
  endsWithTerminator: boolean;
  /** Internal gaps of >= 0.8s — a proxy for stumbling. */
  internalPauseCount: number;
  /** Number of words tagged as filler. */
  fillerCount: number;
  /** Indices into `words` that are fillers. */
  fillerWordIndices: number[];
}

export interface SegmentationOptions {
  /** Split when the gap between two words reaches this. */
  gapSeconds: number;
  /** Split after sentence-final punctuation once the gap reaches this. */
  sentenceGapSeconds: number;
  /** Gaps at least this long count towards `internalPauseCount`. */
  internalPauseSeconds: number;
  /** Filler phrases, already normalised. Multi-word phrases are supported. */
  fillerPhrases: string[];
}

/**
 * Deliberately conservative. "like" and "i mean" are excluded because a lexical match
 * cannot tell filler from meaning ("I like this"), and removing them would butcher
 * real sentences.
 */
export const DEFAULT_FILLER_PHRASES = [
  'um',
  'umm',
  'uh',
  'uhh',
  'erm',
  'err',
  'hmm',
  'mmm',
  'you know',
] as const;

export const DEFAULT_SEGMENTATION: SegmentationOptions = {
  gapSeconds: 0.45,
  sentenceGapSeconds: 0.2,
  internalPauseSeconds: 0.8,
  fillerPhrases: [...DEFAULT_FILLER_PHRASES],
};
