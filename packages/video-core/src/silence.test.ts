import { describe, expect, it } from "vitest";
import { parseSilencedetect, silenceRemovals } from "./silence";

describe("silence detector", () => {
  it("keeps 200ms after speech and 150ms before the next phrase", () => {
    const [cut] = silenceRemovals([{ startMs: 12000, endMs: 15000 }], 20000, {
      minSilenceMs: 1000,
      preRollMs: 150,
      postRollMs: 200,
    });
    expect(cut.startMs).toBe(12200);
    expect(cut.endMs).toBe(14850);
    expect(cut.source).toBe("AUTO_SILENCE");
  });

  it("does not remove natural pauses shorter than the threshold", () => {
    expect(
      silenceRemovals([{ startMs: 1000, endMs: 1400 }], 5000, {
        minSilenceMs: 1000,
        preRollMs: 150,
        postRollMs: 200,
      }),
    ).toHaveLength(0);
  });

  it("parses ffmpeg silencedetect output", () => {
    const regions = parseSilencedetect(`
      [silencedetect @ 0] silence_start: 12.000
      [silencedetect @ 0] silence_end: 15.000 | silence_duration: 3.000
    `);
    expect(regions).toEqual([{ startMs: 12000, endMs: 15000 }]);
  });
});
