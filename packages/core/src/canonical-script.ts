import {
  CANONICAL_SCRIPT_PROMPT_VERSION,
  SCRIPT_PASS_CONFIDENCE_FLOOR,
  type CanonicalScriptPlan,
  type CanonicalSourceSpan,
  type EditSegment,
  type Word,
} from "./types";
import { mergeRanges, type MsRange } from "./ranges";
import { endsLikeSentence } from "./text";

export type CanonicalNarrativeUnit = {
  fromWord: number;
  toWord: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type CompiledCanonicalScript = {
  removals: EditSegment[];
  keepWordIndexes: number[];
  keptSourceRanges: MsRange[];
  rejectedSpans: Array<{ span: CanonicalSourceSpan; reason: string }>;
  restoredUnitCount: number;
  warning?: string;
};

export type CanonicalScriptAlignment = {
  spans: CanonicalSourceSpan[];
  sourceWordIndexes: number[];
  canonicalWordCount: number;
  coverage: number;
  error?: string;
};

type ContiguousClipCandidate = {
  startSourceTokenIndex: number;
  endSourceTokenIndex: number;
  startWordIndex: number;
  endWordIndex: number;
};

type ClipAlignmentState = ContiguousClipCandidate & {
  skipped: number;
  firstSourceTokenIndex: number;
  previousStateIndex: number;
};

const WORD_ID = /^w_(\d+)$/;
const UNIT_GAP_MS = 900;
const UNIT_MAX_WORDS = 60;

function normalizedToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function canonicalTokens(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .map(normalizedToken)
    .filter(Boolean);
}

function sourceTokenList(words: Word[]) {
  return words
    .map((word, wordIndex) => ({ token: normalizedToken(word.text), wordIndex }))
    .filter((item) => item.token.length > 0);
}

function spansFromWordIndexes(sourceWordIndexes: number[]): CanonicalSourceSpan[] {
  if (sourceWordIndexes.length === 0) return [];
  const spans: CanonicalSourceSpan[] = [];
  let spanStart = sourceWordIndexes[0];
  let spanEnd = sourceWordIndexes[0];
  const flush = () => {
    spans.push({
      fromWordId: sourceWordId(spanStart),
      toWordId: sourceWordId(spanEnd),
      reason: "Verbatim match to the verified cleaned script",
      confidence: 1,
    });
  };
  for (let index = 1; index < sourceWordIndexes.length; index += 1) {
    const current = sourceWordIndexes[index];
    if (current <= spanEnd + 1) {
      spanEnd = Math.max(spanEnd, current);
    } else {
      flush();
      spanStart = current;
      spanEnd = current;
    }
  }
  flush();
  return spans;
}

function betterClipAlignment(left: ClipAlignmentState, right: ClipAlignmentState): boolean {
  if (left.skipped !== right.skipped) return left.skipped < right.skipped;
  const leftSpan = left.endSourceTokenIndex - left.firstSourceTokenIndex;
  const rightSpan = right.endSourceTokenIndex - right.firstSourceTokenIndex;
  if (leftSpan !== rightSpan) return leftSpan < rightSpan;
  return left.endSourceTokenIndex > right.endSourceTokenIndex;
}

/**
 * Maps an ordered list of verbatim source clips back to transcript words.
 * Every clip must match one contiguous source passage, which prevents the
 * aligner from assembling a sentence from pieces of different retakes.
 */
export function alignCanonicalClips(cleanedClips: string[], words: Word[]): CanonicalScriptAlignment {
  const clips = cleanedClips.map(canonicalTokens).filter((clip) => clip.length > 0);
  const sourceTokens = sourceTokenList(words);
  const canonicalWordCount = clips.reduce((total, clip) => total + clip.length, 0);
  if (clips.length === 0) {
    return {
      spans: [],
      sourceWordIndexes: [],
      canonicalWordCount: 0,
      coverage: 0,
      error: "cleaned clips were empty",
    };
  }

  const candidatesByClip = clips.map((clip) => {
    const candidates: ContiguousClipCandidate[] = [];
    for (let start = 0; start + clip.length <= sourceTokens.length; start += 1) {
      let matches = true;
      for (let offset = 0; offset < clip.length; offset += 1) {
        if (sourceTokens[start + offset].token !== clip[offset]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const end = start + clip.length - 1;
      candidates.push({
        startSourceTokenIndex: start,
        endSourceTokenIndex: end,
        startWordIndex: sourceTokens[start].wordIndex,
        endWordIndex: sourceTokens[end].wordIndex,
      });
    }
    return candidates;
  });

  const missingClip = candidatesByClip.findIndex((candidates) => candidates.length === 0);
  if (missingClip >= 0) {
    return {
      spans: [],
      sourceWordIndexes: [],
      canonicalWordCount,
      coverage: missingClip / clips.length,
      error: `cleaned clip ${missingClip + 1} of ${clips.length} was not a contiguous source passage`,
    };
  }

  const layers: ClipAlignmentState[][] = [];
  for (let clipIndex = 0; clipIndex < candidatesByClip.length; clipIndex += 1) {
    const states: ClipAlignmentState[] = [];
    for (const candidate of candidatesByClip[clipIndex]) {
      if (clipIndex === 0) {
        states.push({
          ...candidate,
          skipped: 0,
          firstSourceTokenIndex: candidate.startSourceTokenIndex,
          previousStateIndex: -1,
        });
        continue;
      }
      let best: ClipAlignmentState | null = null;
      let bestPreviousIndex = -1;
      const previousLayer = layers[clipIndex - 1];
      for (let previousIndex = 0; previousIndex < previousLayer.length; previousIndex += 1) {
        const previous = previousLayer[previousIndex];
        if (previous.endSourceTokenIndex >= candidate.startSourceTokenIndex) continue;
        const next: ClipAlignmentState = {
          ...candidate,
          skipped: previous.skipped + candidate.startSourceTokenIndex - previous.endSourceTokenIndex - 1,
          firstSourceTokenIndex: previous.firstSourceTokenIndex,
          previousStateIndex: previousIndex,
        };
        if (!best || betterClipAlignment(next, best)) {
          best = next;
          bestPreviousIndex = previousIndex;
        }
      }
      if (best) states.push({ ...best, previousStateIndex: bestPreviousIndex });
    }
    if (states.length === 0) {
      return {
        spans: [],
        sourceWordIndexes: [],
        canonicalWordCount,
        coverage: clipIndex / clips.length,
        error: `cleaned clips stopped matching chronologically at clip ${clipIndex + 1} of ${clips.length}`,
      };
    }
    layers.push(states);
  }

  const lastLayer = layers.at(-1)!;
  let stateIndex = 0;
  for (let index = 1; index < lastLayer.length; index += 1) {
    if (betterClipAlignment(lastLayer[index], lastLayer[stateIndex])) stateIndex = index;
  }
  const selected = Array<ClipAlignmentState>(layers.length);
  for (let clipIndex = layers.length - 1; clipIndex >= 0; clipIndex -= 1) {
    const state = layers[clipIndex][stateIndex];
    selected[clipIndex] = state;
    stateIndex = state.previousStateIndex;
  }
  const sourceWordIndexes = selected.flatMap((candidate) => {
    const indexes: number[] = [];
    for (let index = candidate.startWordIndex; index <= candidate.endWordIndex; index += 1) indexes.push(index);
    return indexes;
  });
  return {
    spans: spansFromWordIndexes(sourceWordIndexes),
    sourceWordIndexes,
    canonicalWordCount,
    coverage: 1,
  };
}

type AlignmentState = {
  sourceTokenIndex: number;
  jumps: number;
  skipped: number;
  firstSourceTokenIndex: number;
  previousStateIndex: number;
};

function betterAlignment(left: AlignmentState, right: AlignmentState): boolean {
  if (left.jumps !== right.jumps) return left.jumps < right.jumps;
  if (left.skipped !== right.skipped) return left.skipped < right.skipped;
  const leftSpan = left.sourceTokenIndex - left.firstSourceTokenIndex;
  const rightSpan = right.sourceTokenIndex - right.firstSourceTokenIndex;
  if (leftSpan !== rightSpan) return leftSpan < rightSpan;
  // When two source passages are otherwise identical, prefer the later delivery.
  return left.sourceTokenIndex > right.sourceTokenIndex;
}

/**
 * Maps a verbatim cleaned script back to the source transcript. The cleaned
 * script must be an ordered subsequence of source words. Dynamic programming
 * minimizes jump cuts first and skipped source words second, so repeated text
 * resolves to the most coherent contiguous delivery without asking the model
 * to reason about timestamps or word IDs.
 */
export function alignCanonicalScript(cleanedScript: string, words: Word[]): CanonicalScriptAlignment {
  const targetTokens = canonicalTokens(cleanedScript);
  const sourceTokens = sourceTokenList(words);
  if (targetTokens.length === 0) {
    return {
      spans: [],
      sourceWordIndexes: [],
      canonicalWordCount: 0,
      coverage: 0,
      error: "cleaned script was empty",
    };
  }

  let layers: AlignmentState[][] = [];
  for (let targetIndex = 0; targetIndex < targetTokens.length; targetIndex += 1) {
    const candidates: AlignmentState[] = [];
    for (let sourceTokenIndex = 0; sourceTokenIndex < sourceTokens.length; sourceTokenIndex += 1) {
      if (sourceTokens[sourceTokenIndex].token !== targetTokens[targetIndex]) continue;
      if (targetIndex === 0) {
        candidates.push({
          sourceTokenIndex,
          jumps: 0,
          skipped: 0,
          firstSourceTokenIndex: sourceTokenIndex,
          previousStateIndex: -1,
        });
        continue;
      }
      let best: AlignmentState | null = null;
      let bestPreviousIndex = -1;
      const previousLayer = layers[targetIndex - 1];
      for (let previousIndex = 0; previousIndex < previousLayer.length; previousIndex += 1) {
        const previous = previousLayer[previousIndex];
        if (previous.sourceTokenIndex >= sourceTokenIndex) continue;
        const gap = sourceTokenIndex - previous.sourceTokenIndex - 1;
        const next: AlignmentState = {
          sourceTokenIndex,
          jumps: previous.jumps + (gap > 0 ? 1 : 0),
          skipped: previous.skipped + gap,
          firstSourceTokenIndex: previous.firstSourceTokenIndex,
          previousStateIndex: previousIndex,
        };
        if (!best || betterAlignment(next, best)) {
          best = next;
          bestPreviousIndex = previousIndex;
        }
      }
      if (best) candidates.push({ ...best, previousStateIndex: bestPreviousIndex });
    }
    if (candidates.length === 0) {
      return {
        spans: [],
        sourceWordIndexes: [],
        canonicalWordCount: targetTokens.length,
        coverage: targetIndex / targetTokens.length,
        error: `cleaned script stopped matching at word ${targetIndex + 1} of ${targetTokens.length}`,
      };
    }
    layers.push(candidates);
  }

  const finalLayer = layers.at(-1)!;
  let finalStateIndex = 0;
  for (let index = 1; index < finalLayer.length; index += 1) {
    if (betterAlignment(finalLayer[index], finalLayer[finalStateIndex])) finalStateIndex = index;
  }
  const matchedSourceTokenIndexes = Array<number>(targetTokens.length);
  for (let targetIndex = targetTokens.length - 1; targetIndex >= 0; targetIndex -= 1) {
    const state = layers[targetIndex][finalStateIndex];
    matchedSourceTokenIndexes[targetIndex] = state.sourceTokenIndex;
    finalStateIndex = state.previousStateIndex;
  }
  const sourceWordIndexes = matchedSourceTokenIndexes.map((index) => sourceTokens[index].wordIndex);
  return {
    spans: spansFromWordIndexes(sourceWordIndexes),
    sourceWordIndexes,
    canonicalWordCount: targetTokens.length,
    coverage: 1,
  };
}

export function sourceWordId(index: number): string {
  return `w_${String(index).padStart(6, "0")}`;
}

export function sourceWordIndex(id: string): number | null {
  const match = WORD_ID.exec(id);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : null;
}

export function buildSourceLinkedTranscript(words: Word[]): string {
  return words.map((word, index) => `${sourceWordId(index)}\t${word.text}`).join("\n");
}

export function isCanonicalScriptPlan(value: unknown): value is CanonicalScriptPlan {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CanonicalScriptPlan>;
  return (
    candidate.version === CANONICAL_SCRIPT_PROMPT_VERSION &&
    Array.isArray(candidate.keepSpans) &&
    Array.isArray(candidate.restoreSpans)
  );
}

export function buildNarrativeUnits(words: Word[]): CanonicalNarrativeUnit[] {
  if (words.length === 0) return [];
  const units: CanonicalNarrativeUnit[] = [];
  let fromWord = 0;
  const flush = (toWord: number) => {
    if (toWord < fromWord) return;
    units.push({
      fromWord,
      toWord,
      startMs: words[fromWord].startMs,
      endMs: words[toWord].endMs,
      text: words.slice(fromWord, toWord + 1).map((word) => word.text).join(" ").trim(),
    });
    fromWord = toWord + 1;
  };
  for (let index = 0; index < words.length; index += 1) {
    const next = words[index + 1];
    const wordCount = index - fromWord + 1;
    if (
      endsLikeSentence(words[index].text) ||
      !next ||
      next.startMs - words[index].endMs >= UNIT_GAP_MS ||
      wordCount >= UNIT_MAX_WORDS
    ) {
      flush(index);
    }
  }
  return units;
}

function validateSpan(span: CanonicalSourceSpan, wordCount: number): { fromWord: number; toWord: number } | string {
  const fromWord = sourceWordIndex(span.fromWordId);
  const toWord = sourceWordIndex(span.toWordId);
  if (fromWord == null || toWord == null) return "invalid source word ID";
  if (fromWord < 0 || toWord >= wordCount || fromWord > toWord) return "source word range is out of bounds";
  if (!span.reason?.trim()) return "reason is required";
  if (!Number.isFinite(span.confidence)) return "confidence is required";
  return { fromWord, toWord };
}

function sourceRangesForKeptWords(words: Word[], kept: Set<number>): MsRange[] {
  const ranges: MsRange[] = [];
  let fromWord: number | null = null;
  const flush = (toWord: number) => {
    if (fromWord == null) return;
    ranges.push({ startMs: words[fromWord].startMs, endMs: words[toWord].endMs });
    fromWord = null;
  };
  for (let index = 0; index < words.length; index += 1) {
    if (kept.has(index) && fromWord == null) fromWord = index;
    if (!kept.has(index) && fromWord != null) flush(index - 1);
  }
  if (fromWord != null) flush(words.length - 1);
  return mergeRanges(ranges);
}

function removalSegmentsFromWords(
  words: Word[],
  keepWordIndexes: Set<number>,
  durationMs: number,
  preRollMs: number,
  postRollMs: number,
): EditSegment[] {
  const removals: EditSegment[] = [];
  let startIndex: number | null = null;
  const flush = (endIndex: number) => {
    if (startIndex == null) return;
    const previousKept = words[startIndex - 1];
    const nextKept = words[endIndex + 1];
    const startMs = previousKept
      ? Math.min(words[startIndex].startMs, previousKept.endMs + postRollMs)
      : 0;
    const endMs = nextKept
      ? Math.max(words[endIndex].endMs, nextKept.startMs - preRollMs)
      : durationMs;
    if (endMs - startMs >= 20) {
      removals.push({
        startMs: Math.max(0, startMs),
        endMs: Math.min(durationMs, endMs),
        action: "REMOVE",
        source: "AUTO_SCRIPT",
        reason: "Excluded from the source-linked canonical script",
        confidence: 0.95,
      });
    }
    startIndex = null;
  };
  for (let index = 0; index < words.length; index += 1) {
    if (!keepWordIndexes.has(index) && startIndex == null) startIndex = index;
    if (keepWordIndexes.has(index) && startIndex != null) flush(index - 1);
  }
  if (startIndex != null) flush(words.length - 1);
  return removals;
}

export function compileCanonicalScript(
  plan: CanonicalScriptPlan,
  words: Word[],
  durationMs: number,
  options: { preRollMs?: number; postRollMs?: number; confidenceFloor?: number } = {},
): CompiledCanonicalScript {
  const rejectedSpans: CompiledCanonicalScript["rejectedSpans"] = [];
  if (words.length === 0 || !isCanonicalScriptPlan(plan)) {
    return {
      removals: [],
      keepWordIndexes: words.map((_, index) => index),
      keptSourceRanges: words.length ? [{ startMs: words[0].startMs, endMs: words.at(-1)!.endMs }] : [],
      rejectedSpans,
      restoredUnitCount: 0,
      warning: "Canonical script was invalid, so all speech was kept.",
    };
  }

  const floor = options.confidenceFloor ?? SCRIPT_PASS_CONFIDENCE_FLOOR;
  const accepted: Array<{ fromWord: number; toWord: number }> = [];
  for (const span of [...plan.keepSpans, ...plan.restoreSpans]) {
    const checked = validateSpan(span, words.length);
    if (typeof checked === "string") {
      rejectedSpans.push({ span, reason: checked });
      continue;
    }
    if (span.confidence < floor) {
      rejectedSpans.push({ span, reason: "confidence below safety floor" });
      continue;
    }
    accepted.push(checked);
  }
  if (accepted.length === 0) {
    return {
      removals: [],
      keepWordIndexes: words.map((_, index) => index),
      keptSourceRanges: [{ startMs: words[0].startMs, endMs: words.at(-1)!.endMs }],
      rejectedSpans,
      restoredUnitCount: 0,
      warning: "Canonical selection contained no safe source spans, so all speech was kept.",
    };
  }

  const keepWordIndexes = new Set<number>();
  for (const span of accepted) {
    for (let index = span.fromWord; index <= span.toWord; index += 1) keepWordIndexes.add(index);
  }
  const removals = removalSegmentsFromWords(
    words,
    keepWordIndexes,
    durationMs,
    options.preRollMs ?? 100,
    options.postRollMs ?? 100,
  );
  const warningParts: string[] = [];
  const restoredUnitCount = plan.restoreSpans.filter((span) => {
    const checked = validateSpan(span, words.length);
    return typeof checked !== "string" && span.confidence >= floor;
  }).length;
  if (restoredUnitCount > 0) warningParts.push(`Safety review restored ${restoredUnitCount} exact source ${restoredUnitCount === 1 ? "passage" : "passages"}.`);
  if (rejectedSpans.length > 0) warningParts.push(`${rejectedSpans.length} invalid or uncertain source ${rejectedSpans.length === 1 ? "span was" : "spans were"} ignored.`);
  return {
    removals,
    keepWordIndexes: [...keepWordIndexes].sort((a, b) => a - b),
    keptSourceRanges: sourceRangesForKeptWords(words, keepWordIndexes),
    rejectedSpans,
    restoredUnitCount,
    warning: warningParts.join(" ") || undefined,
  };
}

export function buildCanonicalReviewScript(words: Word[], keepSpans: CanonicalSourceSpan[]): string {
  const kept = new Set<number>();
  for (const span of keepSpans) {
    const checked = validateSpan(span, words.length);
    if (typeof checked === "string") continue;
    for (let index = checked.fromWord; index <= checked.toWord; index += 1) kept.add(index);
  }
  return words
    .map((word, index) => `${sourceWordId(index)}\t${kept.has(index) ? "KEEP" : "CUT"}\t${word.text}`)
    .join("\n");
}
