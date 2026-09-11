import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "./types";
import {
  decisionFromIndex,
  deriveRetakeUtterances,
  groupRetakeCandidates,
  heuristicJudge,
  needsAiArbitration,
  retakeRemovals,
  scorePair,
} from "./retakes";

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

  it("tolerates a small insertion in an otherwise repeated opening", () => {
    const score = scorePair(
      "To start this business you would need chocolate base gold foil decorative papers.",
      "To start this business you would need chocolate base and gold foil decorative paper.",
    );
    expect(score.combined).toBeGreaterThanOrEqual(0.8);
  });

  it("rebuilds utterances across provider boundaries and splits retries inside a long segment", () => {
    const words = [
      ["I", 0, 200], ["have", 200, 450], ["a", 450, 550], ["simple", 550, 900],
      ["business", 900, 1300], ["for", 1300, 1500], ["you", 1500, 1700], ["that", 1700, 1900],
      ["you", 1900, 2100], ["can", 2100, 2300], ["start", 2300, 2600], ["in", 2600, 2750],
      ["two", 2750, 2950], ["weeks", 2950, 3300], ["and", 3300, 3500], ["generate", 3500, 3900],
      ["a", 3900, 4000], ["minimum", 4000, 4400], ["of", 4500, 4650], ["50,000", 4650, 5050],
      ["rupees.", 5050, 5400],
      ["I", 7000, 7200], ["have", 7200, 7450], ["a", 7450, 7550], ["simple", 7550, 7900],
      ["business", 7900, 8300], ["for", 8300, 8500], ["you.", 8500, 8800],
    ].map(([text, startMs, endMs]) => ({ text: String(text), startMs: Number(startMs), endMs: Number(endMs) }));
    const utterances = deriveRetakeUtterances([
      { startMs: 0, endMs: 4400, text: "provider part one", words: words.slice(0, 18) },
      { startMs: 4500, endMs: 5400, text: "provider continuation", words: words.slice(18, 21) },
      { startMs: 7000, endMs: 8800, text: "provider segment containing another take", words: words.slice(21) },
    ]);
    expect(utterances).toHaveLength(2);
    expect(utterances[0].text).toContain("minimum of 50,000 rupees.");
    expect(utterances[0]).toMatchObject({ startMs: 0, endMs: 5400 });
    expect(utterances[1].text).toBe("I have a simple business for you.");
  });

  it("splits repeated takes when the final restart inserts a word", () => {
    const transcript = [
      "month and that business is 3D chocolates business.",
      "Instead of creating regular chocolates and competing with rest of the other market,",
      "instead of creating regular chocolates and competing with rest of the other market,",
      "instead of creating regular homemade chocolates and competing with rest of the other market,",
      "you need to create 3D chocolates. For this, you need a machine.",
    ].join(" ");
    const words = transcript.split(" ").map((text, index) => ({
      text,
      startMs: index * 320,
      endMs: index * 320 + 280,
    }));

    const utterances = deriveRetakeUtterances([
      { startMs: 0, endMs: words.at(-1)!.endMs, text: transcript, words },
    ]);
    const retries = utterances.filter((utterance) => /^instead\b/i.test(utterance.text));

    expect(retries).toHaveLength(3);
    expect(retries[0].text.match(/instead of creating regular chocolates/gi)).toHaveLength(1);
    expect(retries[1].text).not.toContain("homemade");
    expect(retries[2].text).toContain("homemade chocolates");

    const groups = groupRetakeCandidates(utterances);
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates).toHaveLength(3);
    const decision = heuristicJudge(groups[0]);
    const keep = groups[0].candidates.find((candidate) => candidate.id === decision.keepCandidateId);
    expect(keep?.text).toContain("homemade chocolates");
    expect(decision.removeCandidateIds).toHaveLength(2);
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
