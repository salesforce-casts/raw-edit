import { loadConfig } from "@raw-edit/config";
import {
  CANONICAL_SCRIPT_PROMPT_VERSION,
  SCRIPT_PASS_PROMPT_VERSION,
  applyScriptPassGuards,
  buildCanonicalReviewScript,
  buildSourceLinkedTranscript,
  chunkWordRanges,
  decisionFromIndex,
  flattenWords,
  heuristicJudge,
  maskScriptForPassB,
  needsAiArbitration,
  type CanonicalScriptPlan,
  type CanonicalSourceSpan,
  type PaymentProvider,
  type ScriptPassDecision,
  type TakeCandidateGroup,
  type TakeDecision,
  type TranscriptSegment,
  type Word,
} from "@raw-edit/core";

export interface TakeJudge {
  judge(group: TakeCandidateGroup): Promise<TakeDecision>;
}

const DEFAULT_AI_MODEL = "gpt-5.4-mini";
const DEFAULT_REASONING_EFFORT = "high";

function reasoningOptions(model: string) {
  return /^gpt-[56](?:\.|-|$)/.test(model)
    ? { reasoning_effort: process.env.AI_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT }
    : {};
}

export function createHeuristicTakeJudge(): TakeJudge {
  return {
    async judge(group) {
      return heuristicJudge(group);
    },
  };
}

export function createOpenAiTakeJudge(apiKey = loadConfig().aiApiKey): TakeJudge {
  return {
    async judge(group) {
      const fallback = heuristicJudge(group);
      if (!apiKey || !needsAiArbitration(group)) return fallback;
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL ?? DEFAULT_AI_MODEL,
          ...reasoningOptions(process.env.AI_MODEL ?? DEFAULT_AI_MODEL),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You choose which already-timestamped take to keep. Never invent or change timestamps. Return JSON {keepIndex,reason}. keepIndex is a 0-based index into candidates.",
            },
            {
              role: "user",
              content: JSON.stringify({
                candidates: group.candidates.map((candidate, index) => ({
                  index,
                  text: candidate.text,
                  completenessScore: candidate.completenessScore,
                  fluencyScore: candidate.fluencyScore,
                })),
              }),
            },
          ],
        }),
      });
      if (!response.ok) return fallback;
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as {
        keepIndex?: number;
        reason?: string;
      };
      return decisionFromIndex(group, parsed.keepIndex ?? -1, parsed.reason) ?? fallback;
    },
  };
}

export function getTakeJudge(provider = loadConfig().aiProvider): TakeJudge {
  if (provider === "openai" && loadConfig().aiApiKey) return createOpenAiTakeJudge();
  return createHeuristicTakeJudge();
}

const CLEANUP_PROMPT = `You edit a talking-head transcript addressed by word index.
The outcome is a coherent first-to-last delivery with abandoned attempts removed.
Return JSON {"decisions":[{"fromWord":0,"toWord":0,"category":"falseStart","reason":"...","confidence":0.9}]}
Categories: retake | falseStart | filler | tangent.
Mark fillers, false starts, stumbles, and verbal delete markers ("sorry", "cut that", "again").
Retakes are often adjacent repeated openings and may differ by one inserted, deleted, or corrected word.
For a restart, remove each earlier abandoned attempt through the word immediately before the next attempt; keep the final complete continuation.
Do not remove a unique introduction merely because a later sentence discusses the same topic.
Never emit timestamps. Indices are inclusive ordinals from the script. Every decision needs a reason.`;

const STRUCTURE_PROMPT = `You edit a talking-head transcript addressed by word index.
Lines marked [CUT] were already removed. Do not recut them.
Find duplicate coverage — the same point delivered twice — and remove the worse delivery.
Treat adjacent near-duplicate phrases as separate takes even when punctuation is missing or one take inserts a correction.
Prefer the take that continues coherently into the unrepeated material; delete the complete earlier take, not a fragment of the kept take.
Keep deliberate callbacks. Return JSON {"decisions":[{"fromWord":0,"toWord":3,"category":"retake","reason":"...","confidence":0.9}]}
Never emit timestamps. Indices are inclusive ordinals from the original script. Every decision needs a reason.`;

const CANONICAL_SELECTION_PROMPT = `You are the lead editor of a talking-head recording.
You receive the complete transcript in chronological order. Every line has a stable source word ID and the exact word spoken.
First determine the concise, coherent final script. Then source that script by selecting only words that were actually spoken. Do not rewrite, paraphrase, invent, or reorder words.

Return JSON exactly as {"keepSpans":[{"fromWordId":"w_000000","toWordId":"w_000010","reason":"complete final delivery","confidence":0.95}],"summary":"..."}.
Each keep span is inclusive and must reference one exact contiguous source passage. The concatenated keep spans are the final edited transcript.
Return spans in chronological source order and include every unique introduction, explanation, instruction, numbered step, and conclusion that belongs in the presentation.
When several attempts express the same idea, keep the most complete and fluent occurrence, normally the final corrected take.
Remove repeated phrases, abandoned restarts, corrections, filler, and malformed partial statements even when they occur inside one long passage without punctuation.
If an otherwise useful passage contains a repeated or wrong phrase, split it into multiple keep spans around that phrase. Jump cuts inside a spoken take are allowed and expected.
Never return a keep span that contains two versions of the same phrase or an abandoned restart. Prefer short clause-level spans over one broad span; keep spans should normally be no longer than 35 words.
Never stitch together incompatible sentence fragments. Read the concatenated selected words as one script and ensure it is grammatical and coherent.
Keep transition words such as "first", "then", "because", and "for this" with the clause they introduce.
Preserve unique facts, steps, requirements, pricing, and the call to action. Do not target a duration; length must follow the unique content.
Do not select silence, production directions, explicit delete markers, or abandoned partial attempts when a complete replacement exists.`;

const CANONICAL_VERIFIER_PROMPT = `You are the final editor and safety reviewer for a source-linked talking-head edit.
Every line contains a source word ID, its proposed state (KEEP or CUT), and the exact spoken word.
Audit the entire proposed edit, then return the complete corrected KEEP span list. Your output replaces the first editor's selection.

Return JSON exactly as {"keepSpans":[{"fromWordId":"w_000000","toWordId":"w_000010","reason":"verified final delivery","confidence":0.95}]}.
Read all KEEP words concatenated as the proposed final script. Remove any repeated phrase, duplicate idea, abandoned restart, filler, malformed partial statement, or word fragment that remains.
Restore a CUT passage only when it contains a unique fact, step, requirement, conclusion, or necessary clause that has no equivalent in the proposed KEEP script.
Split spans around errors and repetitions. Jump cuts inside a take are allowed. Never keep two versions of the same phrase in one span; spans should normally be no longer than 35 words.
Keep transitions with their clauses and ensure the concatenated result is grammatical, complete, and chronological.
Do not target a duration. Do not rewrite, paraphrase, reorder, or emit timestamps.`;

async function completeJson(apiKey: string, system: string, user: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.AI_MODEL ?? DEFAULT_AI_MODEL,
        ...reasoningOptions(process.env.AI_MODEL ?? DEFAULT_AI_MODEL),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`script pass http ${response.status}`);
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function parseDecisionList(payload: unknown): Partial<ScriptPassDecision>[] {
  if (!payload || typeof payload !== "object") return [];
  const decisions = (payload as { decisions?: unknown }).decisions;
  return Array.isArray(decisions) ? (decisions as Partial<ScriptPassDecision>[]) : [];
}

function parseCanonicalSpans(payload: unknown, key: "keepSpans" | "restoreSpans"): CanonicalSourceSpan[] {
  if (!payload || typeof payload !== "object") return [];
  const spans = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(spans)) return [];
  return spans.filter((span): span is CanonicalSourceSpan => {
    if (!span || typeof span !== "object") return false;
    const candidate = span as Partial<CanonicalSourceSpan>;
    return (
      typeof candidate.fromWordId === "string" &&
      typeof candidate.toWordId === "string" &&
      typeof candidate.reason === "string" &&
      typeof candidate.confidence === "number"
    );
  });
}

export type CanonicalScriptRun = {
  plan: CanonicalScriptPlan;
  model: string;
  status: "success" | "disabled" | "failed";
  error?: string;
};

export async function runCanonicalScriptPass(transcript: TranscriptSegment[] | Word[]): Promise<CanonicalScriptRun> {
  const words = flattenWords(
    Array.isArray(transcript) && transcript[0] && "words" in transcript[0]
      ? (transcript as TranscriptSegment[])
      : [{ startMs: 0, endMs: 0, text: "", words: transcript as Word[] }],
  );
  const model = process.env.AI_MODEL ?? DEFAULT_AI_MODEL;
  const emptyPlan: CanonicalScriptPlan = {
    version: CANONICAL_SCRIPT_PROMPT_VERSION,
    keepSpans: [],
    restoreSpans: [],
  };
  const apiKey = loadConfig().aiApiKey;
  if (words.length === 0) return { plan: emptyPlan, model, status: "success" };
  if (!apiKey) {
    return {
      plan: emptyPlan,
      model,
      status: "disabled",
      error: "AI_API_KEY, OPENAI_API_KEY, or TRANSCRIPTION_API_KEY is not configured",
    };
  }
  try {
    const selection = await completeJson(apiKey, CANONICAL_SELECTION_PROMPT, buildSourceLinkedTranscript(words));
    const keepSpans = parseCanonicalSpans(selection, "keepSpans");
    if (keepSpans.length === 0) throw new Error("canonical selection returned no source spans");
    const review = await completeJson(apiKey, CANONICAL_VERIFIER_PROMPT, buildCanonicalReviewScript(words, keepSpans));
    const verifiedKeepSpans = parseCanonicalSpans(review, "keepSpans");
    return {
      plan: {
        version: CANONICAL_SCRIPT_PROMPT_VERSION,
        keepSpans: verifiedKeepSpans.length > 0 ? verifiedKeepSpans : keepSpans,
        restoreSpans: [],
        summary:
          selection && typeof selection === "object" && typeof (selection as { summary?: unknown }).summary === "string"
            ? (selection as { summary: string }).summary
            : undefined,
      },
      model,
      status: "success",
    };
  } catch (error) {
    return {
      plan: emptyPlan,
      model,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown canonical-script failure",
    };
  }
}

export type ScriptPassRun = {
  decisions: Partial<ScriptPassDecision>[];
  model: string;
  promptVersion: string;
  status: "success" | "disabled" | "failed";
  error?: string;
};

export async function runScriptPass(transcript: TranscriptSegment[] | Word[]): Promise<ScriptPassRun> {
  const words = flattenWords(
    Array.isArray(transcript) && transcript[0] && "words" in transcript[0]
      ? (transcript as TranscriptSegment[])
      : [{ startMs: 0, endMs: 0, text: "", words: transcript as Word[] }],
  );
  const model = process.env.AI_MODEL ?? DEFAULT_AI_MODEL;
  const apiKey = loadConfig().aiApiKey;
  if (words.length === 0) {
    return { decisions: [], model, promptVersion: SCRIPT_PASS_PROMPT_VERSION, status: "success" };
  }
  if (!apiKey) {
    return {
      decisions: [],
      model,
      promptVersion: SCRIPT_PASS_PROMPT_VERSION,
      status: "disabled",
      error: "AI_API_KEY, OPENAI_API_KEY, or TRANSCRIPTION_API_KEY is not configured",
    };
  }
  try {
    const cleanup: Partial<ScriptPassDecision>[] = [];
    for (const chunk of chunkWordRanges(words.length)) {
      const slice = words.slice(chunk.fromWord, chunk.toWord + 1);
      const script = slice.map((word, offset) => `${chunk.fromWord + offset}\t${word.text}`).join("\n");
      cleanup.push(...parseDecisionList(await completeJson(apiKey, CLEANUP_PROMPT, script)));
    }
    const guarded = applyScriptPassGuards(cleanup, words, words.at(-1)?.endMs ?? 0);
    const appliedCleanup = guarded.applied.map((segment) => ({
      fromWord: words.findIndex((word) => word.startMs === segment.startMs),
      toWord: words.findIndex((word) => word.endMs === segment.endMs),
      category: "falseStart" as const,
      reason: segment.reason ?? "cleanup",
      confidence: segment.confidence ?? 1,
    })).filter((decision) => decision.fromWord >= 0 && decision.toWord >= 0);
    const structure = await completeJson(apiKey, STRUCTURE_PROMPT, maskScriptForPassB(words, appliedCleanup));
    return {
      decisions: [...cleanup, ...parseDecisionList(structure)],
      model,
      promptVersion: SCRIPT_PASS_PROMPT_VERSION,
      status: "success",
    };
  } catch (error) {
    return {
      decisions: [],
      model,
      promptVersion: SCRIPT_PASS_PROMPT_VERSION,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown script-pass failure",
    };
  }
}

export function createNoopPaymentProvider(): PaymentProvider {
  return {
    async createCustomer(input) {
      return { customerId: `local_${input.userId}` };
    },
    async createCheckout() {
      throw new Error("Billing is not enabled in V1");
    },
    async cancelSubscription() {
      throw new Error("Billing is not enabled in V1");
    },
    async handleWebhook() {
      throw new Error("Billing is not enabled in V1");
    },
  };
}

export const createNoopBillingProvider = createNoopPaymentProvider;
