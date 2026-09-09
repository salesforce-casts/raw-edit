/**
 * The Edit Decision List: the only description of an edit that anything renders from.
 * Nothing here mutates the source; a decision is a proposal about a time range.
 */

export type DecisionAction = 'keep' | 'remove';
export type DecisionKind = 'silence' | 'retake' | 'filler' | 'manual';
export type DecisionSource = 'auto' | 'user';

export interface EditDecision {
  id: string;
  startTime: number;
  endTime: number;
  decision: DecisionAction;
  kind: DecisionKind;
  /** Human-readable justification shown verbatim in the review UI. */
  reason: string;
  /** 0..1. */
  confidence: number;
  source: DecisionSource;
  /** Set for `retake` decisions — links back to the detected group. */
  takeId?: string;
  /** Set when the decision came from a single transcript segment. */
  segmentId?: string;
  segmentIndex?: number;
}

export interface EditSettings {
  /** Remove silences strictly longer than this. */
  silenceThresholdSeconds: number;
  /** Keep this much audio before speech resumes. */
  padPreMs: number;
  /** Keep this much audio after speech stops. */
  padPostMs: number;
  removeFillerWords: boolean;
  detectRetakes: boolean;
  removeSilence: boolean;
  /** Keep ranges shorter than this are dropped rather than producing a click. */
  minSegmentSeconds: number;
  /** Keep ranges closer than this are merged. */
  mergeGapMs: number;
  /** Pair score required to call two segments the same sentence. */
  retakeSimilarityThreshold: number;
  /** Shared opening tokens required to call two segments the same sentence. */
  retakeMinOpeningTokens: number;
  retakeLookaheadSegments: number;
  retakeLookaheadSeconds: number;
}

/** Sensible defaults for talking-head social video. */
export const DEFAULT_EDIT_SETTINGS: EditSettings = {
  silenceThresholdSeconds: 1.0,
  padPreMs: 160,
  padPostMs: 200,
  removeFillerWords: false,
  detectRetakes: true,
  removeSilence: true,
  minSegmentSeconds: 0.35,
  mergeGapMs: 120,
  retakeSimilarityThreshold: 0.72,
  retakeMinOpeningTokens: 3,
  retakeLookaheadSegments: 6,
  retakeLookaheadSeconds: 60,
};

export const SILENCE_THRESHOLD_CHOICES = [0.5, 1, 1.5, 2, 3] as const;

export interface TimeRange {
  start: number;
  end: number;
}

export interface EdlSummary {
  originalDuration: number;
  proposedDuration: number;
  removedDuration: number;
  removedBySilence: number;
  removedByRetake: number;
  removedByFiller: number;
  removedByManual: number;
  cutCount: number;
}
