import {
  SCRIPT_PASS_BATCH_REMOVAL_BUDGET,
  SCRIPT_PASS_CHUNK_OVERLAP_WORDS,
  SCRIPT_PASS_CHUNK_WORDS,
  SCRIPT_PASS_CONFIDENCE_FLOOR,
  SCRIPT_PASS_PROMPT_VERSION,
  SCRIPT_PASS_SINGLE_REMOVAL_BUDGET,
  type EditSegment,
  type ScriptPassDecision,
  type TranscriptSegment,
  type Word,
} from "./types";
import { flattenWords } from "./silence";
import { sha256Hex } from "./sha256";

export { SCRIPT_PASS_PROMPT_VERSION };

export type ScriptPassValidation =
  | { ok: true; decision: ScriptPassDecision }
  | { ok: false; reason: string };

export type ScriptPassBatchResult = {
  applied: EditSegment[];
  unapplied: EditSegment[];
  rejected: Array<{ decision: Partial<ScriptPassDecision>; reason: string }>;
  warning?: string;
};

export function indexedWords(transcript: TranscriptSegment[] | Word[]): Word[] {
  if (Array.isArray(transcript) && transcript.length > 0 && "words" in transcript[0]) {
    return flattenWords(transcript as TranscriptSegment[]);
  }
  return transcript as Word[];
}

export function buildIndexedScript(words: Word[]): string {
  return words.map((word, index) => `${index}\t${word.text}`).join("\n");
}

export function chunkWordRanges(
  wordCount: number,
  size = SCRIPT_PASS_CHUNK_WORDS,
  overlap = SCRIPT_PASS_CHUNK_OVERLAP_WORDS,
): Array<{ fromWord: number; toWord: number }> {
  if (wordCount <= 0) return [];
  if (wordCount <= size) return [{ fromWord: 0, toWord: wordCount - 1 }];
  const chunks: Array<{ fromWord: number; toWord: number }> = [];
  let start = 0;
  while (start < wordCount) {
    const end = Math.min(wordCount - 1, start + size - 1);
    chunks.push({ fromWord: start, toWord: end });
    if (end >= wordCount - 1) break;
    start = end - overlap + 1;
  }
  return chunks;
}

export function validateScriptPassDecision(decision: Partial<ScriptPassDecision>, wordCount: number): ScriptPassValidation {
  if (decision.fromWord == null || decision.toWord == null) {
    return { ok: false, reason: "missing indices" };
  }
  if (!Number.isInteger(decision.fromWord) || !Number.isInteger(decision.toWord)) {
    return { ok: false, reason: "indices must be integers" };
  }
  if (decision.fromWord < 0 || decision.toWord < 0 || decision.fromWord >= wordCount || decision.toWord >= wordCount) {
    return { ok: false, reason: "index out of range" };
  }
  if (decision.fromWord > decision.toWord) {
    return { ok: false, reason: "indices not ordered" };
  }
  const reason = typeof decision.reason === "string" ? decision.reason.trim() : "";
  if (!reason) {
    return { ok: false, reason: "reason required" };
  }
  const category = decision.category;
  if (category !== "retake" && category !== "falseStart" && category !== "filler" && category !== "tangent") {
    return { ok: false, reason: "invalid category" };
  }
  const confidence = typeof decision.confidence === "number" && Number.isFinite(decision.confidence) ? decision.confidence : 0;
  return {
    ok: true,
    decision: {
      fromWord: decision.fromWord,
      toWord: decision.toWord,
      category,
      reason,
      confidence,
    },
  };
}

export function mapDecisionToSegment(decision: ScriptPassDecision, words: Word[]): EditSegment {
  return {
    startMs: words[decision.fromWord].startMs,
    endMs: words[decision.toWord].endMs,
    action: "REMOVE",
    source: "AUTO_SCRIPT",
    reason: decision.reason,
    confidence: decision.confidence,
  };
}

export function dedupeDecisionsByIndex(decisions: ScriptPassDecision[]): ScriptPassDecision[] {
  const seen = new Set<string>();
  const out: ScriptPassDecision[] = [];
  for (const decision of decisions) {
    const key = `${decision.fromWord}:${decision.toWord}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(decision);
  }
  return out;
}

export function scriptPassCacheKey(input: { words: Word[]; promptVersion: string; model: string }): string {
  const transcript = input.words.map((word) => word.text).join("\u0000");
  return sha256Hex(`${transcript}|${input.promptVersion}|${input.model}`);
}

export function applyScriptPassGuards(
  decisions: Array<Partial<ScriptPassDecision>>,
  words: Word[],
  durationMs: number,
  confidenceFloor = SCRIPT_PASS_CONFIDENCE_FLOOR,
): ScriptPassBatchResult {
  const rejected: ScriptPassBatchResult["rejected"] = [];
  const valid: ScriptPassDecision[] = [];
  for (const decision of decisions) {
    const checked = validateScriptPassDecision(decision, words.length);
    if (!checked.ok) {
      rejected.push({ decision, reason: checked.reason });
      continue;
    }
    valid.push(checked.decision);
  }
  const unique = dedupeDecisionsByIndex(valid);

  const removalMs = (decision: ScriptPassDecision) =>
    Math.max(0, words[decision.toWord].endMs - words[decision.fromWord].startMs);
  const totalRemoval = unique.reduce((sum, decision) => sum + removalMs(decision), 0);
  const overBudget =
    durationMs > 0 &&
    (totalRemoval / durationMs > SCRIPT_PASS_BATCH_REMOVAL_BUDGET ||
      unique.some((decision) => removalMs(decision) / durationMs > SCRIPT_PASS_SINGLE_REMOVAL_BUDGET));
  if (overBudget) {
    return {
      applied: [],
      unapplied: [],
      rejected: unique.map((decision) => ({ decision, reason: "removal budget exceeded" })),
      warning: "Script pass proposed removing too much; using the deterministic edit only.",
    };
  }

  const applied: EditSegment[] = [];
  const unapplied: EditSegment[] = [];
  for (const decision of unique) {
    const segment = mapDecisionToSegment(decision, words);
    if (decision.confidence >= confidenceFloor) applied.push(segment);
    else unapplied.push({ ...segment, action: "KEEP" });
  }
  return { applied, unapplied, rejected };
}

export function maskScriptForPassB(words: Word[], removed: ScriptPassDecision[]): string {
  const cut = new Set<number>();
  for (const decision of removed) {
    for (let index = decision.fromWord; index <= decision.toWord; index += 1) cut.add(index);
  }
  return words
    .map((word, index) => (cut.has(index) ? `${index}\t[CUT]` : `${index}\t${word.text}`))
    .join("\n");
}

export function transcriptTextForRange(words: Word[], startMs: number, endMs: number): string {
  return words
    .filter((word) => word.startMs < endMs && word.endMs > startMs)
    .map((word) => word.text)
    .join(" ")
    .trim();
}
