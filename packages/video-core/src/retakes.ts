import {
  RETAKE_AUTO_REMOVE_MIN_CONFIDENCE,
  RETAKE_CANDIDATE_THRESHOLD,
  RETAKE_CANDIDATE_WINDOW_MS,
  RETAKE_MIN_WORDS,
  type EditSegment,
  type TakeCandidate,
  type TakeCandidateGroup,
  type TakeDecision,
  type TranscriptSegment,
} from "@raw-edit/contracts";
import {
  contentTokens,
  countFillers,
  endsLikeSentence,
  jaccard,
  looksIncomplete,
  prefixSimilarity,
  semanticSimilarity,
  sequenceSimilarity,
  tokenize,
} from "./text";

export type CombinedScore = {
  lexical: number;
  prefix: number;
  sequence: number;
  semantic: number;
  combined: number;
};

export function scorePair(a: string, b: string): CombinedScore {
  const left = tokenize(a);
  const right = tokenize(b);
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  const prefix = prefixSimilarity(left, right);
  const sequence = sequenceSimilarity(left, right);
  const alignedLonger = longer.slice(0, Math.max(shorter.length, 1));
  const lexical = Math.max(
    jaccard(contentTokens(a), contentTokens(b)),
    jaccard(shorter, alignedLonger),
  );
  const semantic = Math.max(semanticSimilarity(left, right), semanticSimilarity(shorter, alignedLonger));
  let combined = 0.35 * semantic + 0.3 * sequence + 0.2 * prefix + 0.15 * lexical;
  if (prefix >= 0.8 && shorter.length >= RETAKE_MIN_WORDS) {
    combined = Math.max(combined, 0.82);
  }
  return {
    lexical,
    prefix,
    sequence,
    semantic,
    combined,
  };
}

export function completenessScore(segment: TranscriptSegment): number {
  let score = 0.45;
  if (endsLikeSentence(segment.text)) score += 0.3;
  if (!looksIncomplete(segment.text)) score += 0.15;
  const tokens = tokenize(segment.text);
  score += Math.min(0.2, tokens.length / 40);
  return Math.min(1, score);
}

export function fluencyScore(segment: TranscriptSegment): number {
  const fillers = countFillers(segment.text);
  const interruptions = looksIncomplete(segment.text) ? 1 : 0;
  return Math.max(0, 1 - fillers * 0.12 - interruptions * 0.2);
}

export function groupRetakeCandidates(
  segments: TranscriptSegment[],
  threshold = RETAKE_CANDIDATE_THRESHOLD,
): TakeCandidateGroup[] {
  const usable = segments.filter((segment) => contentTokens(segment.text).length >= RETAKE_MIN_WORDS);
  const assigned = new Set<number>();
  const groups: TakeCandidateGroup[] = [];

  for (let i = 0; i < usable.length; i += 1) {
    if (assigned.has(i)) continue;
    const seed = usable[i];
    const members: Array<{ segment: TranscriptSegment; index: number; score: number }> = [
      { segment: seed, index: i, score: 1 },
    ];
    for (let j = i + 1; j < usable.length; j += 1) {
      if (assigned.has(j)) continue;
      const candidate = usable[j];
      if (candidate.startMs - seed.startMs > RETAKE_CANDIDATE_WINDOW_MS) break;
      const scored = scorePair(seed.text, candidate.text);
      if (scored.combined >= threshold) {
        members.push({ segment: candidate, index: j, score: scored.combined });
      }
    }
    if (members.length < 2) continue;
    for (const member of members) assigned.add(member.index);
    const candidates: TakeCandidate[] = members.map((member, order) => ({
      id: `${member.segment.startMs}-${order}`,
      startMs: member.segment.startMs,
      endMs: member.segment.endMs,
      text: member.segment.text,
      completenessScore: completenessScore(member.segment),
      fluencyScore: fluencyScore(member.segment),
      semanticScore: member.score,
    }));
    const similarity = members.slice(1).reduce((sum, member) => sum + member.score, 0) / (members.length - 1);
    groups.push({
      id: `group-${seed.startMs}`,
      similarityScore: similarity,
      confidence: similarity,
      candidates,
    });
  }
  return groups;
}

export function heuristicJudge(group: TakeCandidateGroup): TakeDecision {
  const ranked = [...group.candidates].sort((a, b) => {
    const aScore =
      a.completenessScore * 0.45 + a.fluencyScore * 0.25 + a.semanticScore * 0.1 + a.startMs / 1_000_000;
    const bScore =
      b.completenessScore * 0.45 + b.fluencyScore * 0.25 + b.semanticScore * 0.1 + b.startMs / 1_000_000;
    if (Math.abs(aScore - bScore) < 0.04) return b.startMs - a.startMs;
    return bScore - aScore;
  });
  const keep = ranked[0];
  const remove = ranked.slice(1);
  const confidence = Math.min(0.98, 0.7 + group.similarityScore * 0.25 + (keep.completenessScore - 0.5) * 0.2);
  return {
    keepCandidateId: keep.id,
    removeCandidateIds: remove.map((candidate) => candidate.id),
    confidence,
    reason: `${keep.text.slice(0, 80)} is the most complete later delivery of the repeated sentence.`,
  };
}

export function retakeRemovals(
  groups: TakeCandidateGroup[],
  decisions: TakeDecision[],
): EditSegment[] {
  const removals: EditSegment[] = [];
  for (const group of groups) {
    const decision = decisions.find((item) => item.keepCandidateId && group.candidates.some((c) => c.id === item.keepCandidateId));
    if (!decision || decision.confidence < RETAKE_AUTO_REMOVE_MIN_CONFIDENCE) continue;
    const keep = group.candidates.find((candidate) => candidate.id === decision.keepCandidateId);
    for (const id of decision.removeCandidateIds) {
      const candidate = group.candidates.find((item) => item.id === id);
      if (!candidate) continue;
      removals.push({
        startMs: candidate.startMs,
        endMs: candidate.endMs,
        action: "REMOVE",
        source: "AUTO_RETAKE",
        confidence: decision.confidence,
        reason: `${decision.reason} More complete version ${keep ? `follows at ${(keep.startMs / 1000).toFixed(1)}s.` : "was selected."}`,
      });
    }
  }
  return removals;
}
