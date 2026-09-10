import { describe, expect, it } from "vitest";
import { applyOverrides, buildCoveringEdl, resolveOverlappingRemovals, undoOverrides } from "./edl";
import { fillerRemovals } from "./fillers";

describe("edit decision list", () => {
  it("lets a manual restore win over an automatic retake", () => {
    const resolved = resolveOverlappingRemovals([
      { startMs: 0, endMs: 2000, action: "REMOVE", source: "AUTO_RETAKE", confidence: 0.98 },
      { startMs: 0, endMs: 2000, action: "REMOVE", source: "USER", confidence: 1 },
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].source).toBe("USER");
  });

  it("drops a lower-priority filler that overlaps a retake", () => {
    const resolved = resolveOverlappingRemovals([
      { startMs: 1000, endMs: 4000, action: "REMOVE", source: "AUTO_RETAKE" },
      { startMs: 2000, endMs: 2500, action: "REMOVE", source: "AUTO_FILLER" },
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].source).toBe("AUTO_RETAKE");
  });

  it("covers the timeline with KEEP ranges around removals", () => {
    const edl = buildCoveringEdl(10_000, [
      { startMs: 2000, endMs: 4000, action: "REMOVE", source: "AUTO_SILENCE" },
    ]);
    expect(edl.filter((segment) => segment.action === "KEEP").map((segment) => [segment.startMs, segment.endMs])).toEqual([
      [0, 2000],
      [4000, 10000],
    ]);
  });

  it("replays an override stack and undoes by dropping the last override", () => {
    const auto = buildCoveringEdl(10_000, [
      { startMs: 2000, endMs: 4000, action: "REMOVE", source: "AUTO_SILENCE" },
    ]);
    const overrides = [
      { startMs: 2000, endMs: 4000, action: "KEEP" as const, reason: "restore pause" },
      { startMs: 7000, endMs: 8000, action: "REMOVE" as const, reason: "manual cut" },
    ];
    const applied = applyOverrides(auto, overrides);
    expect(applied.some((segment) => segment.startMs === 2000 && segment.action === "KEEP")).toBe(true);
    expect(applied.some((segment) => segment.startMs === 7000 && segment.action === "REMOVE")).toBe(true);
    const undone = applyOverrides(auto, undoOverrides(overrides));
    expect(undone.some((segment) => segment.startMs === 7000 && segment.action === "REMOVE" && segment.source === "USER")).toBe(
      false,
    );
  });

  it("keeps filler detection off by default and never treats like/I mean as fillers", () => {
    const segments = [
      {
        startMs: 0,
        endMs: 3000,
        text: "um like I mean this is the plan",
        words: [
          { text: "um", startMs: 0, endMs: 200 },
          { text: "like", startMs: 200, endMs: 400 },
          { text: "I", startMs: 400, endMs: 500 },
          { text: "mean", startMs: 500, endMs: 700 },
          { text: "this", startMs: 700, endMs: 900 },
        ],
      },
    ];
    expect(fillerRemovals(segments, false)).toHaveLength(0);
    const enabled = fillerRemovals(segments, true);
    expect(enabled.some((item) => item.reason?.includes("um"))).toBe(true);
    expect(enabled.some((item) => item.reason?.includes("like"))).toBe(false);
  });
});
