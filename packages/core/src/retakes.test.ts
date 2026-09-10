import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "./types";
import { decisionFromIndex, groupRetakeCandidates, heuristicJudge, needsAiArbitration, retakeRemovals, scorePair } from "./retakes";

function seg(startMs: number, endMs: number, text: string): TranscriptSegment {
  return { startMs, endMs, text, words: [] };
}

describe("retake detection", () => {
  it("scores a strict prefix at or above the 0.93 floor", () => {
    const score = scorePair("Today I'll show you", "Today I'll show you three business ideas.");
    expect(score.isPrefixOf).toBe(true);
    expect(score.combined).toBeGreaterThanOrEqual(0.93);
  });

  it("groups the three business-ideas takes and keeps the complete final delivery", () => {
    const segments = [
      seg(0, 2000, "Today I'll show you three business ideas."),
      seg(4000, 6000, "Today I'll show you"),
      seg(
        8000,
        13000,
        "Today I'll show you three business ideas that you can start under fifty thousand rupees.",
      ),
    ];
    const groups = groupRetakeCandidates(segments);
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates).toHaveLength(3);
    const decision = heuristicJudge(groups[0]);
    const keep = groups[0].candidates.find((candidate) => candidate.id === decision.keepCandidateId);
    expect(keep?.text).toContain("fifty thousand");
    expect(decision.removeCandidateIds).toHaveLength(2);
    const removals = retakeRemovals(groups, [decision]);
    expect(removals).toHaveLength(2);
    expect(removals.every((item) => item.source === "AUTO_RETAKE")).toBe(true);
    expect(decision.reason).toContain("fifty thousand");
  });

  it("does not group unrelated nearby sentences", () => {
    const segments = [
      seg(0, 3000, "Welcome back to the channel everyone"),
      seg(4000, 8000, "Today the weather is unusually cold in Mumbai"),
    ];
    expect(groupRetakeCandidates(segments)).toHaveLength(0);
  });

  it("tolerates a contraction expansion and a plural", () => {
    const score = scorePair("Today I will show you three business ideas", "Today I'll show you three business idea");
    expect(score.combined).toBeGreaterThan(0.8);
  });

  it("unions three attempts that only match pairwise", () => {
    const groups = groupRetakeCandidates([
      seg(0, 3000, "Let me explain the pricing model quickly"),
      seg(4000, 6500, "Let me explain the pricing"),
      seg(8000, 12000, "Let me explain the pricing model quickly for new customers."),
    ]);
    expect(groups[0]?.candidates).toHaveLength(3);
  });

  it("asks for AI only when the top two keeper scores are within 0.6", () => {
    const close = groupRetakeCandidates([
      seg(0, 4000, "This is the best way to start a company this year."),
      seg(5000, 9000, "This is the best way to start a company this year for sure."),
    ]);
    expect(close).toHaveLength(1);
    expect(typeof needsAiArbitration(close[0])).toBe("boolean");
    const fromIndex = decisionFromIndex(close[0], 99);
    expect(fromIndex).toBeNull();
    expect(decisionFromIndex(close[0], 0)?.keepCandidateIndex).toBe(0);
  });
});
