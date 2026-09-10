import { loadConfig } from "@raw-edit/config";
import {
  decisionFromIndex,
  heuristicJudge,
  needsAiArbitration,
  type PaymentProvider,
  type TakeCandidateGroup,
  type TakeDecision,
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
