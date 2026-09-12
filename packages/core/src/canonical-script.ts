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

const WORD_ID = /^w_(\d+)$/;
const UNIT_GAP_MS = 900;
const UNIT_MAX_WORDS = 60;

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
