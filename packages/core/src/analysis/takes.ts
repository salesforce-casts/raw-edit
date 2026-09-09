import type { SpeechSegment } from '../types/transcript.js';
import type {
  DetectedTakeGroup,
  PairScore,
  RetakeDetectionInput,
  TakeMember,
  TakeScoreBreakdown,
} from '../types/takes.js';
import { bigramDice, containment, isFuzzyPrefix, longestCommonPrefix, tokensMatch } from '../text/similarity.js';
import { median, perWordTokens, speechRate } from './segments.js';
import { formatTimecode } from '../util/time.js';

/**
 * Score how likely it is that two utterances are two attempts at the same sentence.
 *
 * The dominant signal is the shared *opening*: a creator who fluffs a line restarts it
 * from the top, so the beginnings match even when the endings diverge completely.
 */
export function scorePair(a: readonly string[], b: readonly string[]): PairScore {
  if (a.length === 0 || b.length === 0) {
    return { lcp: 0, openingScore: 0, dice: 0, containment: 0, isPrefixOf: false, score: 0 };
  }

  const lcp = longestCommonPrefix(a, b);
  const openingScore = lcp / Math.min(a.length, b.length);
  const dice = bigramDice(a, b);
  const contain = containment(a, b);
  const prefix = isFuzzyPrefix(a, b) || isFuzzyPrefix(b, a);

  let score = 0.5 * openingScore + 0.25 * dice + 0.25 * contain;
  // One utterance being a strict opening fragment of the other is as clear as this
  // signal gets; do not let a low Dice score (short vs long) mask it.
  if (prefix && lcp >= 3) score = Math.max(score, 0.93);

  return { lcp, openingScore, dice, containment: contain, isPrefixOf: prefix, score };
}

/**
 * Compare two utterances on both their raw and filler-stripped tokens, keeping the
 * stronger signal. A retake with an "um" near the front still shares its opening —
 * comparing only raw tokens would miss it.
 */
export function scoreSegmentPair(a: SpeechSegment, b: SpeechSegment): PairScore {
  const raw = scorePair(a.tokens, b.tokens);
  const clean = scorePair(a.contentTokens, b.contentTokens);
  return clean.score > raw.score ? clean : raw;
}

interface Candidate {
  i: number;
  j: number;
  pair: PairScore;
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let cursor = x;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor]!;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

/**
 * Group nearby segments that are attempts at the same sentence and pick the keeper.
 *
 * Deterministic end to end: the same transcript and settings always produce the same
 * groups, which is what makes "Reset automatic edits" reproducible without re-running
 * transcription.
 */
export function detectRetakes(input: RetakeDetectionInput): DetectedTakeGroup[] {
  const { segments, similarityThreshold, minOpeningTokens, lookaheadSegments, lookaheadSeconds } = input;
  if (segments.length < 2) return [];

  const candidates: Candidate[] = [];
  const bestPairScore = new Array<number>(segments.length).fill(0);

  for (let i = 0; i < segments.length; i += 1) {
    const left = segments[i]!;
    for (let j = i + 1; j < Math.min(segments.length, i + 1 + lookaheadSegments); j += 1) {
      const right = segments[j]!;
      if (right.start - left.end > lookaheadSeconds) break;

      const pair = scoreSegmentPair(left, right);
      const shortest = Math.min(left.contentTokens.length, right.contentTokens.length);
      // Very short utterances ("okay", "so") need a lower bar or they never group,
      // but they also need to share essentially everything they have.
      const requiredOpening = shortest <= 3 ? Math.min(2, shortest) : minOpeningTokens;
      if (pair.lcp < requiredOpening) continue;
      if (pair.score < similarityThreshold) continue;

      candidates.push({ i, j, pair });
      bestPairScore[i] = Math.max(bestPairScore[i]!, pair.score);
      bestPairScore[j] = Math.max(bestPairScore[j]!, pair.score);
    }
  }

  if (candidates.length === 0) return [];

  const sets = new DisjointSet(segments.length);
  for (const candidate of candidates) sets.union(candidate.i, candidate.j);

  const buckets = new Map<number, number[]>();
  for (const candidate of candidates) {
    const root = sets.find(candidate.i);
    let bucket = buckets.get(root);
    if (!bucket) {
      bucket = [];
      buckets.set(root, bucket);
    }
    if (!bucket.includes(candidate.i)) bucket.push(candidate.i);
    if (!bucket.includes(candidate.j)) bucket.push(candidate.j);
  }

  const pairScoreByKey = new Map<string, number>();
  for (const candidate of candidates) {
    pairScoreByKey.set(`${candidate.i}:${candidate.j}`, candidate.pair.score);
  }

  const groups: DetectedTakeGroup[] = [];
  let groupIndex = 0;

  for (const memberIndices of buckets.values()) {
    memberIndices.sort((a, b) => segments[a]!.start - segments[b]!.start);
    const members = memberIndices.map((index) => segments[index]!);

    const scored = scoreMembers(members);
    const bestPosition = scored.reduce(
      (best, entry, position) => {
        // Ties go to the later take, which is the rule creators expect.
        return entry.total >= scored[best]!.total ? position : best;
      },
      0,
    );

    const groupPairScores: number[] = [];
    for (let a = 0; a < memberIndices.length; a += 1) {
      for (let b = a + 1; b < memberIndices.length; b += 1) {
        const key = `${Math.min(memberIndices[a]!, memberIndices[b]!)}:${Math.max(memberIndices[a]!, memberIndices[b]!)}`;
        const value = pairScoreByKey.get(key);
        if (value !== undefined) groupPairScores.push(value);
      }
    }
    const similarity =
      groupPairScores.length === 0
        ? 0
        : groupPairScores.reduce((sum, value) => sum + value, 0) / groupPairScores.length;

    const totals = scored.map((entry) => entry.total);
    const bestTotal = totals[bestPosition]!;
    const runnerUp = totals
      .filter((_, position) => position !== bestPosition)
      .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
    const margin = Number.isFinite(runnerUp) ? bestTotal - runnerUp : bestTotal;

    const takeMembers: TakeMember[] = members.map((segment, position) => ({
      segmentIndex: segment.index,
      start: segment.start,
      end: segment.end,
      text: segment.text,
      score: Number(scored[position]!.total.toFixed(4)),
      breakdown: scored[position]!,
      isChosen: position === bestPosition,
      pairScore: Number((bestPairScore[segment.index] ?? similarity).toFixed(4)),
    }));

    groups.push({
      id: `take_${groupIndex}`,
      groupIndex,
      canonicalText: members[bestPosition]!.text,
      members: takeMembers,
      chosenSegmentIndex: members[bestPosition]!.index,
      similarity: Number(similarity.toFixed(4)),
      confidence: groupConfidence(similarity, margin),
      reason: describeGroup(members, bestPosition, scored),
    });
    groupIndex += 1;
  }

  groups.sort((a, b) => a.members[0]!.start - b.members[0]!.start);
  return groups.map((group, index) => ({ ...group, groupIndex: index, id: `take_${index}` }));
}

/**
 * Rank the members of one group. Higher is better; the winner is kept and every other
 * member becomes a proposed removal.
 */
function scoreMembers(members: readonly SpeechSegment[]): TakeScoreBreakdown[] {
  // Content is measured on filler-stripped tokens so a rambling "um"-heavy take
  // cannot win the "most content" bonus it did not earn.
  const maxTokens = Math.max(...members.map((segment) => segment.contentTokens.length), 1);
  const rates = members.map(speechRate).filter((rate) => rate > 0);
  const medianRate = median(rates);

  return members.map((segment, position) => {
    const isPrefixOfLater = members.some(
      (other, otherPosition) =>
        otherPosition > position &&
        (isFuzzyPrefix(segment.tokens, other.tokens) ||
          isFuzzyPrefix(segment.contentTokens, other.contentTokens)),
    );

    let completeness = 0;
    if (segment.endsWithTerminator) completeness += 3;
    if (isPrefixOfLater) completeness -= 4;
    if (segment.contentTokens.length === maxTokens) completeness += 1;

    const content = 1.2 * (segment.contentTokens.length / maxTokens);
    const fluency = -0.35 * segment.fillerCount - 0.5 * segment.internalPauseCount;
    const recency = members.length > 1 ? 0.15 * (position / (members.length - 1)) : 0;

    const rate = speechRate(segment);
    const rushed = medianRate > 0 && rate > medianRate * 1.8;
    const speechRatePenalty = rushed ? -0.4 : 0;

    const total = completeness + content + fluency + recency + speechRatePenalty;
    return {
      completeness,
      content: Number(content.toFixed(4)),
      fluency: Number(fluency.toFixed(4)),
      recency: Number(recency.toFixed(4)),
      speechRate: speechRatePenalty,
      total: Number(total.toFixed(4)),
      isPrefixOfLater,
    };
  });
}

function groupConfidence(similarity: number, margin: number): number {
  const marginTerm = Math.min(1, Math.max(0, margin / 3));
  return Number(Math.min(0.99, 0.55 + 0.35 * similarity + 0.1 * marginTerm).toFixed(4));
}

function describeGroup(
  members: readonly SpeechSegment[],
  bestPosition: number,
  scored: readonly TakeScoreBreakdown[],
): string {
  const winner = members[bestPosition]!;
  const reasons: string[] = [];
  if (winner.endsWithTerminator) reasons.push('it is the complete sentence');
  if (scored[bestPosition]!.content >= 1.19) reasons.push('it has the most content');
  if (winner.fillerCount === 0 && members.some((m) => m.fillerCount > 0)) {
    reasons.push('it has no filler words');
  }
  if (bestPosition === members.length - 1 && reasons.length === 0) reasons.push('it is the final attempt');
  const why = reasons.length > 0 ? reasons.join(' and ') : 'it scored highest overall';
  return `${members.length} attempts at this line; keeping the one at ${formatTimecode(winner.start)} because ${why}.`;
}

/** Per-removal confidence, higher when the case is unambiguous. */
export function removalConfidence(group: DetectedTakeGroup, member: TakeMember): number {
  if (member.breakdown.isPrefixOfLater) {
    return Number(Math.max(0.9, group.confidence).toFixed(4));
  }
  const chosen = group.members.find((m) => m.isChosen);
  const margin = chosen ? Math.min(1, Math.max(0, (chosen.score - member.score) / 3)) : 0;
  return Number(Math.min(0.99, 0.55 + 0.35 * member.pairScore + 0.1 * margin).toFixed(4));
}

/** Reason text for a single proposed removal, shown verbatim in the review UI. */
export function removalReason(group: DetectedTakeGroup, member: TakeMember): string {
  const chosen = group.members.find((m) => m.isChosen);
  const at = chosen ? formatTimecode(chosen.start) : 'later';
  if (member.breakdown.isPrefixOfLater) {
    return `Incomplete retake — the same sentence is finished at ${at}.`;
  }
  if (chosen && chosen.start > member.start) {
    return `Repeated take; a more complete version follows at ${at}.`;
  }
  return `Repeated take; the version at ${at} was kept instead.`;
}

/**
 * Restarts that happen without a pause, so segmentation never split them:
 * "Today I'll show you— today I'll show you three ideas."
 *
 * Looks for the segment's opening n-gram recurring later in the same segment, with a
 * strictly longer continuation after it, and proposes cutting everything before the
 * recurrence.
 */
export function detectIntraSegmentRestarts(
  segment: SpeechSegment,
  minOpeningTokens = 3,
): { start: number; end: number; keptFromWordIndex: number; matchedTokens: number } | null {
  // One token per word, so a match index maps straight back to a timestamp.
  // Contractions are joined rather than expanded, which keeps that mapping exact.
  const tokens = perWordTokens(segment.words);
  if (tokens.length < minOpeningTokens * 2 + 1) return null;

  const maxOpening = Math.min(6, Math.floor(tokens.length / 2));
  let best: { at: number; length: number } | null = null;

  for (let length = maxOpening; length >= minOpeningTokens; length -= 1) {
    const opening = tokens.slice(0, length);
    for (let at = length; at + length <= tokens.length; at += 1) {
      let matched = true;
      for (let k = 0; k < length; k += 1) {
        if (!tokensMatch(opening[k]!, tokens[at + k]!)) {
          matched = false;
          break;
        }
      }
      // Only a restart if what follows the recurrence is longer than what followed
      // the original opening — otherwise it is a rhetorical repetition worth keeping.
      if (matched && tokens.length - (at + length) > at - length) {
        best = { at, length };
        break;
      }
    }
    if (best) break;
  }

  if (!best) return null;
  const word = segment.words[best.at];
  if (!word) return null;
  return {
    start: segment.start,
    end: word.start,
    keptFromWordIndex: best.at,
    matchedTokens: best.length,
  };
}
