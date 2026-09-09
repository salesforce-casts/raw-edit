import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@raw-edit/contracts";
import { groupRetakeCandidates, heuristicJudge, retakeRemovals } from "./retakes";

function seg(startMs: number, endMs: number, text: string): TranscriptSegment {
  return { startMs, endMs, text, words: [] };
}

describe("retake detection", () => {
  it("groups the three business-ideas takes and keeps the complete final delivery", () => {
    const segments = [
      seg(0, 4200, "Today I'm going to explain three business"),
      seg(6000, 8100, "Today I'm going to explain"),
      seg(
        10000,
        16500,
        "Today I'm going to explain three businesses you can start under fifty thousand rupees.",
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
  });

  it("does not group unrelated nearby sentences", () => {
    const segments = [
      seg(0, 3000, "Welcome back to the channel everyone"),
      seg(4000, 8000, "Today the weather is unusually cold in Mumbai"),
    ];
    expect(groupRetakeCandidates(segments)).toHaveLength(0);
  });
});
