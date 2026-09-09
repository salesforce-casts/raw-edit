import type { SpeechSegment } from './transcript.js';

/** Why one member of a take group beat the others. Surfaced in the UI. */
export interface TakeScoreBreakdown {
  completeness: number;
  content: number;
  fluency: number;
  recency: number;
  speechRate: number;
  total: number;
  /** True when this segment is a fuzzy prefix of a later member. */
  isPrefixOfLater: boolean;
}

export interface TakeMember {
  segmentIndex: number;
  start: number;
  end: number;
  text: string;
  score: number;
  breakdown: TakeScoreBreakdown;
  isChosen: boolean;
  /** Best pair score linking this member to the rest of the group. */
  pairScore: number;
}

export interface DetectedTakeGroup {
  id: string;
  groupIndex: number;
  /** Text of the chosen member — what the sentence "is". */
  canonicalText: string;
  members: TakeMember[];
  chosenSegmentIndex: number;
  /** Mean pair score across the group. */
  similarity: number;
  /** 0..1 confidence that these really are attempts at one sentence. */
  confidence: number;
  reason: string;
}

export interface PairScore {
  /** Longest common prefix in fuzzy-matched tokens. */
  lcp: number;
  openingScore: number;
  dice: number;
  containment: number;
  isPrefixOf: boolean;
  score: number;
}

/** What an EditAdvisor is shown. Text only — advisors never see timestamps. */
export interface TakeGroupForReview {
  groupId: string;
  candidates: { index: number; text: string }[];
  /** The deterministic layer's pick, as a fallback and as a hint. */
  deterministicChoice: number;
  /** Score gap between first and second place; small means genuinely ambiguous. */
  margin: number;
}

export interface AdvisorVerdict {
  groupId: string;
  /** Must be one of the candidate indices, or the verdict is discarded. */
  chosenIndex: number;
  reason: string;
  confidence: number;
}

/**
 * Optional AI layer. It arbitrates ambiguous English; it never touches the timeline.
 * A verdict that names an index outside the candidate list is discarded.
 */
export interface EditAdvisor {
  readonly name: string;
  arbitrate(groups: TakeGroupForReview[]): Promise<AdvisorVerdict[]>;
}

export interface RetakeDetectionInput {
  segments: SpeechSegment[];
  similarityThreshold: number;
  minOpeningTokens: number;
  lookaheadSegments: number;
  lookaheadSeconds: number;
}
