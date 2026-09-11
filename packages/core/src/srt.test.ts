import { describe, expect, it } from "vitest";
import { buildEditedTimelineSrt, type Word } from "./index";

describe("edited timeline SRT", () => {
  it("maps source words onto the compacted output timeline", () => {
    const words: Word[] = [
      { text: "Hello", startMs: 1_000, endMs: 1_300 },
      { text: "there.", startMs: 1_350, endMs: 1_700 },
      { text: "Next", startMs: 5_000, endMs: 5_300 },
      { text: "step.", startMs: 5_350, endMs: 5_800 },
    ];
    const srt = buildEditedTimelineSrt(words, [
      { startMs: 900, endMs: 1_800 },
      { startMs: 4_900, endMs: 5_900 },
    ]);

    expect(srt).toContain("00:00:00,100 --> 00:00:00,800");
    expect(srt).toContain("Hello there.");
    expect(srt).toContain("00:00:01,000 --> 00:00:01,800");
    expect(srt).toContain("Next step.");
  });
});
