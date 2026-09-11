import {
  INTERNAL_PAUSE_MS,
  RETAKE_AI_MARGIN,
  RETAKE_AUTO_REMOVE_MIN_CONFIDENCE,
  RETAKE_CANDIDATE_THRESHOLD,
  RETAKE_CANDIDATE_WINDOW_MS,
  RETAKE_MIN_WORDS,
  RETAKE_PREFIX_FLOOR,
  type EditSegment,
  type TakeCandidate,
  type TakeCandidateGroup,
  type TakeDecision,
  type TranscriptSegment,
} from "./types";
import {
  containment,
  contentTokens,
  countFillers,
  countInternalPauses,
  diceBigram,
  endsLikeSentence,
  fuzzyPrefixSimilarity,
  isFuzzyPrefix,
  longestCommonPrefix,
  tokenEditSimilarity,
  tokenize,
} from "./text";

export type PairScore = {
  openingScore: number;
  dice: number;
  containment: number;
  isPrefixOf: boolean;
  sequenceSimilarity: number;
  combined: number;
};

function strongerSignal(raw: string[], stripped: string[], otherRaw: string[], otherStripped: string[]) {
  const rawScore = scoreTokenPair(raw, otherRaw);
  const strippedScore = scoreTokenPair(stripped, otherStripped);
  return rawScore.combined >= strippedScore.combined ? rawScore : strippedScore;
}

export function scoreTokenPair(left: string[], right: string[]): PairScore {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  const lcp = longestCommonPrefix(left, right);
  const openingScore = shorter.length === 0 ? 0 : lcp / shorter.length;
  const dice = diceBigram(left, right);
  const contained = containment(shorter, longer);
  const prefixSimilarity = fuzzyPrefixSimilarity(shorter, longer);
  const prefix =
    shorter.length >= RETAKE_MIN_WORDS &&
    (isFuzzyPrefix(shorter, longer) || prefixSimilarity >= 0.82);
  const sequenceSimilarity = tokenEditSimilarity(left, right);
  let combined = Math.max(
    0.5 * openingScore + 0.25 * dice + 0.25 * contained,
    0.5 * prefixSimilarity + 0.25 * dice + 0.25 * contained,
    0.55 * sequenceSimilarity + 0.2 * dice + 0.25 * contained,
  );
  if (prefix) combined = Math.max(combined, RETAKE_PREFIX_FLOOR);
  return { openingScore, dice, containment: contained, isPrefixOf: prefix, sequenceSimilarity, combined };
}

export function scorePair(a: string, b: string): PairScore {
  return strongerSignal(tokenize(a), contentTokens(a), tokenize(b), contentTokens(b));
}

export function completenessDelta(segment: TranscriptSegment, others: TranscriptSegment[]): number {
  let score = endsLikeSentence(segment.text) ? 3.0 : 0;
  const tokens = contentTokens(segment.text);
  for (const other of others) {
    if (other.startMs <= segment.startMs) continue;
    const shorter = tokens;
    const longer = contentTokens(other.text);
    if (isFuzzyPrefix(shorter, longer) && shorter.length < longer.length) {
      score -= 4.0;
      break;
    }
  }
  return score;
}

export function contentShare(segment: TranscriptSegment, group: TranscriptSegment[]): number {
  const longest = Math.max(...group.map((item) => contentTokens(item.text).length), 1);
  return contentTokens(segment.text).length / longest;
}

export function fluencyPenalty(segment: TranscriptSegment): number {
  return countFillers(segment.text) * 0.35 + countInternalPauses(segment.words, INTERNAL_PAUSE_MS) * 0.5;
}

export function keeperScore(segment: TranscriptSegment, group: TranscriptSegment[], index: number): number {
  return (
    completenessDelta(segment, group) +
    1.2 * contentShare(segment, group) -
    fluencyPenalty(segment) -
    0.05 * index
  );
}

export function completenessScore(segment: TranscriptSegment, group: TranscriptSegment[] = []): number {
  const raw = completenessDelta(segment, group);
  return Math.max(0, Math.min(1, (raw + 4) / 7));
}

export function fluencyScore(segment: TranscriptSegment): number {
  return Math.max(0, 1 - fluencyPenalty(segment) / 3);
}

const RETAKE_UTTERANCE_GAP_MS = 800;
const RETAKE_UTTERANCE_MAX_WORDS = 55;
const RETAKE_RESTART_WINDOW_WORDS = 7;
const RETAKE_RESTART_SCAN_WORDS = RETAKE_RESTART_WINDOW_WORDS + 2;
const RETAKE_RESTART_ANCHOR_WORDS = 3;
const RETAKE_RESTART_SIMILARITY = 0.7;
const RETAKE_RESTART_MIN_GAP_MS = 1_200;
const RETAKE_RESTART_MAX_GAP_MS = 90_000;
const RETAKE_RESTART_PAUSE_MS = 400;

type OpeningOccurrence = {
  index: number;
  startMs: number;
  tokens: string[];
};

function transcriptSegmentFromWords(words: TranscriptSegment["words"]): TranscriptSegment {
  return {
    startMs: words[0].startMs,
    endMs: words[words.length - 1].endMs,
    text: words.map((word) => word.text).join(" ").trim(),
    words,
    confidence:
      words.some((word) => word.confidence != null)
        ? words.reduce((sum, word) => sum + (word.confidence ?? 1), 0) / words.length
        : undefined,
  };
}

function repeatedOpeningBoundaries(words: TranscriptSegment["words"]): Set<number> {
  const occurrencesByAnchor = new Map<string, OpeningOccurrence[]>();
  const boundaries = new Set<number>();
  let lastRestartCurrent = -RETAKE_RESTART_WINDOW_WORDS;
  for (let index = 0; index + RETAKE_RESTART_WINDOW_WORDS <= words.length; index += 1) {
    const previousWord = words[index - 1];
    const startsAfterBreak =
      !previousWord ||
      /[,.!?;:…]$/.test(previousWord.text.trim()) ||
      words[index].startMs - previousWord.endMs >= RETAKE_RESTART_PAUSE_MS;
    if (!startsAfterBreak) continue;
    const opening = contentTokens(
      words
        .slice(index, index + RETAKE_RESTART_SCAN_WORDS)
        .map((word) => word.text)
        .join(" "),
    ).slice(0, RETAKE_RESTART_WINDOW_WORDS);
    if (opening.length < RETAKE_RESTART_WINDOW_WORDS) continue;
    const anchor = opening.slice(0, RETAKE_RESTART_ANCHOR_WORDS).join(" ");
    const occurrences = occurrencesByAnchor.get(anchor) ?? [];
    const previous = [...occurrences].reverse().find((occurrence) => {
      const elapsed = words[index].startMs - occurrence.startMs;
      return (
        elapsed >= RETAKE_RESTART_MIN_GAP_MS &&
        elapsed <= RETAKE_RESTART_MAX_GAP_MS &&
        tokenEditSimilarity(occurrence.tokens, opening) >= RETAKE_RESTART_SIMILARITY
      );
    });
    occurrences.push({ index, startMs: words[index].startMs, tokens: opening });
    occurrencesByAnchor.set(
      anchor,
      occurrences.filter(
        (occurrence) => words[index].startMs - occurrence.startMs <= RETAKE_RESTART_MAX_GAP_MS,
      ),
    );
    if (!previous) continue;
    if (index - lastRestartCurrent < RETAKE_RESTART_WINDOW_WORDS) continue;
    boundaries.add(previous.index);
    boundaries.add(index);
    lastRestartCurrent = index;
  }
  return boundaries;
}

/** Rebuild take-sized utterances from words rather than trusting provider segment boundaries. */
export function deriveRetakeUtterances(segments: TranscriptSegment[]): TranscriptSegment[] {
  const orderedSegments = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const words = orderedSegments
    .flatMap((segment) => segment.words ?? [])
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (words.length === 0) return orderedSegments;
  const restartBoundaries = repeatedOpeningBoundaries(words);

  const utterances: TranscriptSegment[] = [];
  let current: TranscriptSegment["words"] = [];
  const flush = () => {
    if (current.length > 0) utterances.push(transcriptSegmentFromWords(current));
    current = [];
  };

  for (const [wordIndex, word] of words.entries()) {
    const previous = current.at(-1);
    if (
      previous &&
      (restartBoundaries.has(wordIndex) ||
        word.startMs - previous.endMs >= RETAKE_UTTERANCE_GAP_MS ||
        endsLikeSentence(previous.text) ||
        current.length >= RETAKE_UTTERANCE_MAX_WORDS)
    ) {
      flush();
    }
    current.push(word);
  }
  flush();

  const merged: TranscriptSegment[] = [];
  for (const utterance of utterances) {
    const previous = merged.at(-1);
    if (
      previous &&
      contentTokens(utterance.text).length < RETAKE_MIN_WORDS &&
      !endsLikeSentence(previous.text) &&
      utterance.startMs - previous.endMs < RETAKE_UTTERANCE_GAP_MS
    ) {
      merged[merged.length - 1] = transcriptSegmentFromWords([...previous.words, ...utterance.words]);
    } else {
      merged.push(utterance);
    }
  }
  return merged;
}

export function groupRetakeCandidates(
  segments: TranscriptSegment[],
  threshold = RETAKE_CANDIDATE_THRESHOLD,
): TakeCandidateGroup[] {
  const usable = segments.filter((segment) => contentTokens(segment.text).length >= RETAKE_MIN_WORDS);
  const parent = usable.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const union = (a: number, b: number) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent[right] = left;
  };

  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      if (usable[j].startMs - usable[i].startMs > RETAKE_CANDIDATE_WINDOW_MS) break;
      if (scorePair(usable[i].text, usable[j].text).combined >= threshold) union(i, j);
    }
  }

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < usable.length; i += 1) {
    const root = find(i);
    const list = buckets.get(root) ?? [];
    list.push(i);
    buckets.set(root, list);
  }

  const groups: TakeCandidateGroup[] = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    const groupSegments = members.map((index) => usable[index]);
    const candidates: TakeCandidate[] = groupSegments.map((segment, order) => ({
      id: `${segment.startMs}-${order}`,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      completenessScore: completenessScore(segment, groupSegments),
      fluencyScore: fluencyScore(segment),
      semanticScore: members.length === 1 ? 1 : 0,
      keeperScore: keeperScore(segment, groupSegments, order),
    }));
    let similarity = 0;
    let pairs = 0;
    for (let i = 0; i < groupSegments.length; i += 1) {
      for (let j = i + 1; j < groupSegments.length; j += 1) {
        similarity += scorePair(groupSegments[i].text, groupSegments[j].text).combined;
        pairs += 1;
      }
    }
    const mean = pairs === 0 ? 1 : similarity / pairs;
    groups.push({
      id: `group-${groupSegments[0].startMs}`,
      similarityScore: mean,
      confidence: mean,
      candidates: candidates.map((candidate) => ({ ...candidate, semanticScore: mean })),
    });
  }
  return groups.sort((a, b) => a.candidates[0].startMs - b.candidates[0].startMs);
}

export function heuristicJudge(group: TakeCandidateGroup): TakeDecision {
  const ranked = [...group.candidates].sort((a, b) => {
    if (Math.abs(b.keeperScore - a.keeperScore) > 0.0001) return b.keeperScore - a.keeperScore;
    return a.startMs - b.startMs;
  });
  const keep = ranked[0];
  const remove = ranked.slice(1);
  const confidence = Math.min(0.98, 0.7 + group.similarityScore * 0.25 + Math.max(0, keep.completenessScore - 0.5) * 0.2);
  return {
    keepCandidateId: keep.id,
    keepCandidateIndex: group.candidates.findIndex((candidate) => candidate.id === keep.id),
    removeCandidateIds: remove.map((candidate) => candidate.id),
    confidence,
    reason: keep.text,
  };
}

export function needsAiArbitration(group: TakeCandidateGroup): boolean {
  if (group.candidates.length < 2) return false;
  const ranked = [...group.candidates].sort((a, b) => b.keeperScore - a.keeperScore);
  return ranked[0].keeperScore - ranked[1].keeperScore <= RETAKE_AI_MARGIN;
}

export function decisionFromIndex(group: TakeCandidateGroup, keepIndex: number, reason?: string): TakeDecision | null {
  const keep = group.candidates[keepIndex];
  if (!keep) return null;
  return {
    keepCandidateId: keep.id,
    keepCandidateIndex: keepIndex,
    removeCandidateIds: group.candidates.filter((candidate) => candidate.id !== keep.id).map((candidate) => candidate.id),
    confidence: 0.9,
    reason: reason ?? keep.text,
  };
}

export function retakeRemovals(groups: TakeCandidateGroup[], decisions: TakeDecision[]): EditSegment[] {
  const removals: EditSegment[] = [];
  for (const group of groups) {
    const decision = decisions.find(
      (item) => item.keepCandidateId && group.candidates.some((candidate) => candidate.id === item.keepCandidateId),
    );
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
        reason: decision.reason,
      });
    }
    void keep;
  }
  return removals;
}
