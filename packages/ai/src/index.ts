import { loadConfig } from "@raw-edit/config";
import type { TakeCandidateGroup, TakeDecision } from "@raw-edit/contracts";
import { heuristicJudge } from "@raw-edit/video-core";

export interface TakeJudge {
  judge(group: TakeCandidateGroup): Promise<TakeDecision>;
}

export interface BillingProvider {
  createCustomer(input: { userId: string; email: string }): Promise<{ customerId: string }>;
  createCheckout(input: { customerId: string; plan: string }): Promise<{ url: string }>;
  cancelSubscription(input: { subscriptionId: string }): Promise<void>;
  handleWebhook(payload: unknown, signature: string): Promise<void>;
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
      if (!apiKey) return heuristicJudge(group);
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
                "You choose which already-timestamped take to keep. Never invent or change timestamps. Return JSON {keepCandidateId,removeCandidateIds,confidence,reason}.",
            },
            {
              role: "user",
              content: JSON.stringify({
                candidates: group.candidates.map((candidate) => ({
                  id: candidate.id,
                  text: candidate.text,
                  startMs: candidate.startMs,
                  endMs: candidate.endMs,
                  completenessScore: candidate.completenessScore,
                  fluencyScore: candidate.fluencyScore,
                })),
              }),
            },
          ],
        }),
      });
      if (!response.ok) return heuristicJudge(group);
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as TakeDecision;
      if (!parsed.keepCandidateId || !Array.isArray(parsed.removeCandidateIds)) {
        return heuristicJudge(group);
      }
      const ids = new Set(group.candidates.map((candidate) => candidate.id));
      if (!ids.has(parsed.keepCandidateId)) return heuristicJudge(group);
      return parsed;
    },
  };
}

export function getTakeJudge(provider = loadConfig().aiProvider): TakeJudge {
  if (provider === "openai" && loadConfig().aiApiKey) return createOpenAiTakeJudge();
  return createHeuristicTakeJudge();
}

export function createNoopBillingProvider(): BillingProvider {
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
