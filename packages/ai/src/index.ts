import { loadConfig } from "@raw-edit/config";
import {
  SCRIPT_PASS_PROMPT_VERSION,
  applyScriptPassGuards,
  chunkWordRanges,
  decisionFromIndex,
  flattenWords,
  heuristicJudge,
  maskScriptForPassB,
  needsAiArbitration,
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
          model: process.env.AI_MODEL ?? "gpt-4.1-mini",
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
Return JSON {"decisions":[{"fromWord":0,"toWord":0,"category":"falseStart","reason":"...","confidence":0.9}]}
Categories: retake | falseStart | filler | tangent.
Mark fillers, false starts, stumbles, and verbal delete markers ("sorry", "cut that", "again").
Never emit timestamps. Indices are inclusive ordinals from the script. Every decision needs a reason.`;

const STRUCTURE_PROMPT = `You edit a talking-head transcript addressed by word index.
Lines marked [CUT] were already removed. Do not recut them.
Find duplicate coverage — the same point delivered twice — and remove the worse delivery.
Keep deliberate callbacks. Return JSON {"decisions":[{"fromWord":0,"toWord":3,"category":"retake","reason":"...","confidence":0.9}]}
Never emit timestamps. Indices are inclusive ordinals from the original script. Every decision needs a reason.`;

async function completeJson(apiKey: string, system: string, user: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.AI_MODEL ?? "gpt-4.1-mini",
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

export type ScriptPassRun = {
  decisions: Partial<ScriptPassDecision>[];
  model: string;
  promptVersion: string;
};

export async function runScriptPass(transcript: TranscriptSegment[] | Word[]): Promise<ScriptPassRun> {
  const words = flattenWords(
    Array.isArray(transcript) && transcript[0] && "words" in transcript[0]
      ? (transcript as TranscriptSegment[])
      : [{ startMs: 0, endMs: 0, text: "", words: transcript as Word[] }],
  );
  const model = process.env.AI_MODEL ?? "gpt-4.1-mini";
  const apiKey = loadConfig().aiApiKey;
  if (!apiKey || words.length === 0) return { decisions: [], model, promptVersion: SCRIPT_PASS_PROMPT_VERSION };
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
    };
  } catch {
    return { decisions: [], model, promptVersion: SCRIPT_PASS_PROMPT_VERSION };
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
