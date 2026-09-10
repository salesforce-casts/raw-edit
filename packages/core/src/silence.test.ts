import { describe, expect, it } from "vitest";
import { confirmedSilence, dualSignalSilenceRemovals, parseSilencedetect, silenceRemovals, transcriptGaps } from "./silence";

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

  it("requires acoustic silence and a transcript gap to agree", () => {
    const transcript = [
      { startMs: 0, endMs: 10000, text: "hello", words: [] },
      { startMs: 16000, endMs: 20000, text: "again", words: [] },
    ];
    const acoustic = [{ startMs: 11000, endMs: 15500 }];
    const confirmed = confirmedSilence(acoustic, transcript, 20000);
    expect(confirmed[0]?.startMs).toBe(11000);
    expect(confirmed[0]?.endMs).toBe(15500);
    const ignored = dualSignalSilenceRemovals([{ startMs: 2000, endMs: 5000 }], transcript, 20000);
    expect(ignored).toHaveLength(0);
  });

  it("treats a leading transcript gap as silence evidence", () => {
    const gaps = transcriptGaps([{ startMs: 3000, endMs: 5000, text: "hi", words: [] }], 8000);
    expect(gaps[0]).toEqual({ startMs: 0, endMs: 3000 });
    expect(gaps.at(-1)).toEqual({ startMs: 5000, endMs: 8000 });
  });
});
