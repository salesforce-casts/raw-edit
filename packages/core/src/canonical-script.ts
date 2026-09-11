import {
  CANONICAL_SCRIPT_PROMPT_VERSION,
  SCRIPT_PASS_CONFIDENCE_FLOOR,
  type CanonicalScriptPlan,
  type CanonicalSourceSpan,
  type EditSegment,
  type Word,
} from "./types";
import { mergeRanges, type MsRange } from "./ranges";
import { contentTokens, endsLikeSentence } from "./text";
import { scorePair } from "./retakes";

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

const WORD_ID = /^w_(\d+)$/;
const UNIT_GAP_MS = 900;
const UNIT_MAX_WORDS = 60;
const COVERAGE_SIMILARITY = 0.66;

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

function unitSimilarity(left: CanonicalNarrativeUnit, right: CanonicalNarrativeUnit): number {
  return scorePair(left.text, right.text).combined;
}

function bestRepresentative(indexes: number[], units: CanonicalNarrativeUnit[]): number {
  return [...indexes].sort((left, right) => {
    const a = units[left];
    const b = units[right];
    const completeA = endsLikeSentence(a.text) ? 1 : 0;
    const completeB = endsLikeSentence(b.text) ? 1 : 0;
    if (completeA !== completeB) return completeB - completeA;
    const lengthA = contentTokens(a.text).length;
    const lengthB = contentTokens(b.text).length;
    if (lengthA !== lengthB) return lengthB - lengthA;
    return b.startMs - a.startMs;
  })[0];
}

function restoreUncoveredInformation(units: CanonicalNarrativeUnit[], selected: Set<number>): number {
  const meaningful = units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit, index }) => !selected.has(index) && contentTokens(unit.text).length >= 3);
  const uncovered = meaningful.filter(({ unit }) =>
    ![...selected].some((selectedIndex) => unitSimilarity(unit, units[selectedIndex]) >= COVERAGE_SIMILARITY),
  );
  if (uncovered.length === 0) return 0;

  const parent = uncovered.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  for (let left = 0; left < uncovered.length; left += 1) {
    for (let right = left + 1; right < uncovered.length; right += 1) {
      if (unitSimilarity(uncovered[left].unit, uncovered[right].unit) >= COVERAGE_SIMILARITY) union(left, right);
    }
  }
  const families = new Map<number, number[]>();
  for (let index = 0; index < uncovered.length; index += 1) {
    const root = find(index);
    const members = families.get(root) ?? [];
    members.push(uncovered[index].index);
    families.set(root, members);
  }
  for (const members of families.values()) selected.add(bestRepresentative(members, units));
  return families.size;
}

function sourceRangesForSelectedUnits(units: CanonicalNarrativeUnit[], selected: Set<number>): MsRange[] {
  return mergeRanges(
    [...selected]
      .sort((a, b) => a - b)
      .map((index) => ({ startMs: units[index].startMs, endMs: units[index].endMs })),
  );
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

  const units = buildNarrativeUnits(words);
  const selectedUnits = new Set<number>();
  for (const [unitIndex, unit] of units.entries()) {
    if (accepted.some((span) => span.fromWord <= unit.toWord && span.toWord >= unit.fromWord)) selectedUnits.add(unitIndex);
  }
  const restoredUnitCount = restoreUncoveredInformation(units, selectedUnits);
  const keepWordIndexes = new Set<number>();
  for (const unitIndex of selectedUnits) {
    const unit = units[unitIndex];
    for (let index = unit.fromWord; index <= unit.toWord; index += 1) keepWordIndexes.add(index);
  }
  const removals = removalSegmentsFromWords(
    words,
    keepWordIndexes,
    durationMs,
    options.preRollMs ?? 100,
    options.postRollMs ?? 100,
  );
  const warningParts: string[] = [];
  if (restoredUnitCount > 0) warningParts.push(`Safety validation restored ${restoredUnitCount} omitted information ${restoredUnitCount === 1 ? "family" : "families"}.`);
  if (rejectedSpans.length > 0) warningParts.push(`${rejectedSpans.length} invalid or uncertain source ${rejectedSpans.length === 1 ? "span was" : "spans were"} ignored.`);
  return {
    removals,
    keepWordIndexes: [...keepWordIndexes].sort((a, b) => a - b),
    keptSourceRanges: sourceRangesForSelectedUnits(units, selectedUnits),
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
