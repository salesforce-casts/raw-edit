import type { EditDecision, EditSettings, EdlSummary, TimeRange } from '../types/edl.js';
import { DEFAULT_EDIT_SETTINGS } from '../types/edl.js';
import type { DetectedTakeGroup, EditAdvisor, TakeGroupForReview } from '../types/takes.js';
import type { SpeechSegment } from '../types/transcript.js';
import { detectIntraSegmentRestarts, detectRetakes, removalConfidence, removalReason } from './takes.js';
import { detectSilenceRemovals } from './silence.js';
import { normalizeRanges, overlapDuration } from '../util/ranges.js';
import { formatTimecode, round } from '../util/time.js';

export interface BuildEdlInput {
  segments: SpeechSegment[];
  acousticSilence: TimeRange[];
  duration: number;
  settings?: Partial<EditSettings>;
  /** Deterministic id prefix so ids are stable across re-runs. */
  idPrefix?: string;
}

export interface BuildEdlResult {
  decisions: EditDecision[];
  takes: DetectedTakeGroup[];
  settings: EditSettings;
  summary: EdlSummary;
}

/**
 * Turn a transcript plus acoustic silence into the proposed edit.
 *
 * Order matters: retakes are decided first (they own whole utterances), then silence,
 * then fillers, and overlapping proposals are resolved so the highest-value reason
 * survives. Nothing here mutates media — the output is a list of proposals.
 */
export function buildEdl(input: BuildEdlInput): BuildEdlResult {
  const settings: EditSettings = { ...DEFAULT_EDIT_SETTINGS, ...input.settings };
  const prefix = input.idPrefix ?? 'ed';
  const decisions: EditDecision[] = [];
  let counter = 0;
  const nextId = () => `${prefix}_${(counter++).toString().padStart(4, '0')}`;

  const takes = settings.detectRetakes
    ? detectRetakes({
        segments: input.segments,
        similarityThreshold: settings.retakeSimilarityThreshold,
        minOpeningTokens: settings.retakeMinOpeningTokens,
        lookaheadSegments: settings.retakeLookaheadSegments,
        lookaheadSeconds: settings.retakeLookaheadSeconds,
      })
    : [];

  const removedSegmentIndices = new Set<number>();

  for (const group of takes) {
    for (const member of group.members) {
      if (member.isChosen) continue;
      removedSegmentIndices.add(member.segmentIndex);
      decisions.push({
        id: nextId(),
        startTime: round(member.start, 4),
        endTime: round(member.end, 4),
        decision: 'remove',
        kind: 'retake',
        reason: removalReason(group, member),
        confidence: removalConfidence(group, member),
        source: 'auto',
        takeId: group.id,
        segmentIndex: member.segmentIndex,
      });
    }
  }

  // Restarts inside a single utterance, which segmentation could not split.
  if (settings.detectRetakes) {
    for (const segment of input.segments) {
      if (removedSegmentIndices.has(segment.index)) continue;
      const restart = detectIntraSegmentRestarts(segment, settings.retakeMinOpeningTokens);
      if (!restart || restart.end - restart.start < 0.2) continue;
      decisions.push({
        id: nextId(),
        startTime: round(restart.start, 4),
        endTime: round(restart.end, 4),
        decision: 'remove',
        kind: 'retake',
        reason: `False start — the line restarts at ${formatTimecode(restart.end)} without a pause.`,
        confidence: 0.82,
        source: 'auto',
        segmentIndex: segment.index,
      });
    }
  }

  if (settings.removeSilence) {
    const silenceRemovals = detectSilenceRemovals(input.segments, input.acousticSilence, input.duration, {
      thresholdSeconds: settings.silenceThresholdSeconds,
      padPreMs: settings.padPreMs,
      padPostMs: settings.padPostMs,
    });
    for (const removal of silenceRemovals) {
      decisions.push({
        id: nextId(),
        startTime: removal.start,
        endTime: removal.end,
        decision: 'remove',
        kind: 'silence',
        reason: `${removal.gapDuration.toFixed(1)}s pause removed (longer than the ${settings.silenceThresholdSeconds}s threshold).`,
        confidence: silenceConfidence(removal.gapDuration, settings.silenceThresholdSeconds, removal.agreement),
        source: 'auto',
      });
    }
  }

  if (settings.removeFillerWords) {
    for (const segment of input.segments) {
      if (removedSegmentIndices.has(segment.index)) continue;
      for (const wordIndex of segment.fillerWordIndices) {
        const word = segment.words[wordIndex];
        if (!word) continue;
        if (word.end - word.start < 0.05) continue;
        decisions.push({
          id: nextId(),
          startTime: round(word.start, 4),
          endTime: round(word.end, 4),
          decision: 'remove',
          kind: 'filler',
          reason: `Filler word "${word.text.trim()}" removed.`,
          confidence: 0.7,
          source: 'auto',
          segmentIndex: segment.index,
        });
      }
    }
  }

  const deduped = dedupeDecisions(decisions, input.duration);
  return {
    decisions: deduped,
    takes,
    settings,
    summary: summarizeEdl(deduped, input.duration),
  };
}

function silenceConfidence(gap: number, threshold: number, agreement: number): number {
  const over = Math.min(1, (gap - threshold) / Math.max(threshold, 0.5));
  return Number(Math.min(0.99, 0.7 + 0.2 * over + 0.09 * agreement).toFixed(4));
}

/**
 * Two detectors can propose overlapping cuts (a retake that ends in a long pause, for
 * example). Keep the higher-priority reason and trim the other rather than emitting
 * overlapping rows, which would make the review UI lie about what is removed.
 */
const KIND_PRIORITY: Record<EditDecision['kind'], number> = {
  manual: 4,
  retake: 3,
  silence: 2,
  filler: 1,
};

export function dedupeDecisions(decisions: readonly EditDecision[], duration: number): EditDecision[] {
  const removals = decisions
    .filter((decision) => decision.decision === 'remove')
    .sort((a, b) => KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] || a.startTime - b.startTime);

  const accepted: EditDecision[] = [];
  for (const candidate of removals) {
    let start = Math.max(0, candidate.startTime);
    let end = Math.min(duration, candidate.endTime);
    if (end - start <= 0.02) continue;

    for (const existing of accepted) {
      const existingRange = { start: existing.startTime, end: existing.endTime };
      if (overlapDuration({ start, end }, existingRange) <= 0) continue;
      if (start >= existing.startTime && end <= existing.endTime) {
        start = end; // fully covered
        break;
      }
      if (start >= existing.startTime && start < existing.endTime) start = existing.endTime;
      if (end > existing.startTime && end <= existing.endTime) end = existing.startTime;
    }
    if (end - start <= 0.02) continue;
    accepted.push({ ...candidate, startTime: round(start, 4), endTime: round(end, 4) });
  }

  const keeps = decisions.filter((decision) => decision.decision === 'keep');
  return [...accepted, ...keeps].sort((a, b) => a.startTime - b.startTime);
}

export function summarizeEdl(decisions: readonly EditDecision[], duration: number): EdlSummary {
  const removals = decisions.filter((decision) => decision.decision === 'remove');
  const byKind = (kind: EditDecision['kind']) =>
    round(
      removals
        .filter((decision) => decision.kind === kind)
        .reduce((sum, decision) => sum + (decision.endTime - decision.startTime), 0),
      3,
    );

  const merged = normalizeRanges(
    removals.map((decision) => ({ start: decision.startTime, end: decision.endTime })),
    duration,
  );
  const removedDuration = round(merged.reduce((sum, range) => sum + (range.end - range.start), 0), 3);

  return {
    originalDuration: round(duration, 3),
    proposedDuration: round(Math.max(0, duration - removedDuration), 3),
    removedDuration,
    removedBySilence: byKind('silence'),
    removedByRetake: byKind('retake'),
    removedByFiller: byKind('filler'),
    removedByManual: byKind('manual'),
    cutCount: merged.length,
  };
}

/**
 * Hand ambiguous take groups to an advisor (an LLM, if configured) and apply any
 * verdict that names a real candidate. The advisor can only change *which* member of
 * an already-detected group is kept — it cannot create, move or delete a cut.
 */
export async function applyAdvisor(
  result: BuildEdlResult,
  advisor: EditAdvisor,
  marginThreshold = 0.6,
): Promise<BuildEdlResult> {
  const ambiguous: TakeGroupForReview[] = [];
  for (const group of result.takes) {
    const scores = group.members.map((member) => member.score).sort((a, b) => b - a);
    const margin = scores.length > 1 ? scores[0]! - scores[1]! : Number.POSITIVE_INFINITY;
    if (margin >= marginThreshold) continue;
    ambiguous.push({
      groupId: group.id,
      candidates: group.members.map((member, index) => ({ index, text: member.text })),
      deterministicChoice: group.members.findIndex((member) => member.isChosen),
      margin: round(margin, 4),
    });
  }
  if (ambiguous.length === 0) return result;

  let verdicts;
  try {
    verdicts = await advisor.arbitrate(ambiguous);
  } catch {
    // The deterministic pick is always a valid answer; an advisor failure is not fatal.
    return result;
  }

  const byGroup = new Map(verdicts.map((verdict) => [verdict.groupId, verdict]));
  const takes = result.takes.map((group) => {
    const verdict = byGroup.get(group.id);
    if (!verdict) return group;
    const index = verdict.chosenIndex;
    // Discard anything outside the candidate list rather than trusting the model.
    if (!Number.isInteger(index) || index < 0 || index >= group.members.length) return group;
    const currentIndex = group.members.findIndex((member) => member.isChosen);
    if (index === currentIndex) return group;
    return {
      ...group,
      chosenSegmentIndex: group.members[index]!.segmentIndex,
      canonicalText: group.members[index]!.text,
      members: group.members.map((member, position) => ({ ...member, isChosen: position === index })),
      reason: verdict.reason || group.reason,
      confidence: Math.min(group.confidence, Math.max(0, Math.min(1, verdict.confidence))),
    };
  });

  // Rebuild only the retake decisions; silence and filler decisions are unaffected.
  const nonRetake = result.decisions.filter((decision) => decision.kind !== 'retake' || decision.takeId == null);
  const retakeDecisions: EditDecision[] = [];
  let counter = 0;
  for (const group of takes) {
    for (const member of group.members) {
      if (member.isChosen) continue;
      retakeDecisions.push({
        id: `adv_${(counter++).toString().padStart(4, '0')}`,
        startTime: member.start,
        endTime: member.end,
        decision: 'remove',
        kind: 'retake',
        reason: removalReason(group, member),
        confidence: removalConfidence(group, member),
        source: 'auto',
        takeId: group.id,
        segmentIndex: member.segmentIndex,
      });
    }
  }

  const decisions = dedupeDecisions([...retakeDecisions, ...nonRetake], result.summary.originalDuration);
  return { ...result, takes, decisions, summary: summarizeEdl(decisions, result.summary.originalDuration) };
}

/**
 * A user action on the review screen. The UI keeps a stack of these for undo/redo and
 * replays them over the automatic proposal, which is why "Reset automatic edits" is
 * simply an empty override list rather than a re-analysis.
 */
export type EdlOverride =
  | { type: 'restore'; decisionId: string }
  | { type: 'remove'; startTime: number; endTime: number; reason?: string; segmentIndex?: number }
  | { type: 'adjust'; decisionId: string; startTime: number; endTime: number }
  | { type: 'keepTake'; takeId: string; segmentIndex: number };

export function applyEdlOverrides(
  base: readonly EditDecision[],
  overrides: readonly EdlOverride[],
  duration: number,
): EditDecision[] {
  let decisions = base.map((decision) => ({ ...decision }));
  let manualCounter = 0;

  for (const override of overrides) {
    switch (override.type) {
      case 'restore': {
        decisions = decisions.filter((decision) => decision.id !== override.decisionId);
        break;
      }
      case 'remove': {
        decisions.push({
          id: `man_${(manualCounter++).toString().padStart(4, '0')}_${Math.round(override.startTime * 1000)}`,
          startTime: round(Math.max(0, override.startTime), 4),
          endTime: round(Math.min(duration, override.endTime), 4),
          decision: 'remove',
          kind: 'manual',
          reason: override.reason ?? 'Removed by you.',
          confidence: 1,
          source: 'user',
          segmentIndex: override.segmentIndex,
        });
        break;
      }
      case 'adjust': {
        decisions = decisions.map((decision) =>
          decision.id === override.decisionId
            ? {
                ...decision,
                startTime: round(Math.max(0, override.startTime), 4),
                endTime: round(Math.min(duration, override.endTime), 4),
                source: 'user' as const,
                confidence: 1,
              }
            : decision,
        );
        break;
      }
      case 'keepTake': {
        // Keeping one member of a group means dropping its removal and removing every
        // other member of the same group instead.
        const group = decisions.filter((decision) => decision.takeId === override.takeId);
        if (group.length === 0) break;
        decisions = decisions.filter((decision) => decision.takeId !== override.takeId);
        for (const member of group) {
          if (member.segmentIndex === override.segmentIndex) continue;
          decisions.push({ ...member, source: 'user', confidence: 1 });
        }
        break;
      }
      default:
        break;
    }
  }

  return dedupeDecisions(decisions, duration);
}

/** The default advisor: no network, keeps the deterministic decision. */
export class HeuristicEditAdvisor implements EditAdvisor {
  readonly name = 'heuristic';

  async arbitrate(groups: TakeGroupForReview[]) {
    return groups.map((group) => ({
      groupId: group.groupId,
      chosenIndex: group.deterministicChoice,
      reason: '',
      confidence: 0.7,
    }));
  }
}
