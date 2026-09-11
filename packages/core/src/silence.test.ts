import { describe, expect, it } from "vitest";
import {
  classifyGap,
  dualSignalSilenceRemovals,
  noiseFloorDbFromRms,
  parseRmsLevels,
  parseSilencedetect,
  silenceRemovals,
  transcriptGaps,
} from "./silence";

describe("silence detector", () => {
  it("trims a head gap to 120ms and does not pad a side with no speech", () => {
    const transcript = [{ startMs: 3000, endMs: 5000, text: "hi.", words: [{ text: "hi.", startMs: 3000, endMs: 5000 }] }];
    const [cut] = silenceRemovals([{ startMs: 0, endMs: 3000 }], 8000, transcript, "tight");
    expect(cut.startMs).toBe(0);
    expect(cut.endMs).toBe(2880);
    expect(cut.source).toBe("AUTO_SILENCE");
  });

  it("leaves intra-sentence breaths alone", () => {
    const transcript = [
      {
        startMs: 0,
        endMs: 4000,
        text: "today I'll show",
        words: [
          { text: "today", startMs: 0, endMs: 400 },
          { text: "I'll", startMs: 400, endMs: 700 },
          { text: "show", startMs: 2500, endMs: 4000 },
        ],
      },
    ];
    expect(silenceRemovals([{ startMs: 700, endMs: 2500 }], 4000, transcript, "tight")).toHaveLength(0);
  });

  it("cuts inter-sentence silence with 80/60 padding only on speech boundaries", () => {
    const transcript = [
      {
        startMs: 0,
        endMs: 12000,
        text: "Done.",
        words: [{ text: "Done.", startMs: 0, endMs: 12000 }],
      },
      {
        startMs: 15000,
        endMs: 18000,
        text: "Next",
        words: [{ text: "Next", startMs: 15000, endMs: 18000 }],
      },
    ];
    const [cut] = silenceRemovals([{ startMs: 12000, endMs: 15000 }], 20000, transcript, "tight");
    expect(cut.startMs).toBe(12060);
    expect(cut.endMs).toBe(14920);
  });

  it("does not remove an inter-sentence pause shorter than the pacing threshold", () => {
    const transcript = [
      { startMs: 0, endMs: 1000, text: "Hi.", words: [{ text: "Hi.", startMs: 0, endMs: 1000 }] },
      { startMs: 1300, endMs: 2000, text: "There", words: [{ text: "There", startMs: 1300, endMs: 2000 }] },
    ];
    expect(silenceRemovals([{ startMs: 1000, endMs: 1300 }], 2000, transcript, "tight")).toHaveLength(0);
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
      { startMs: 0, endMs: 10000, text: "hello.", words: [{ text: "hello.", startMs: 0, endMs: 10000 }] },
      { startMs: 16000, endMs: 20000, text: "again", words: [{ text: "again", startMs: 16000, endMs: 20000 }] },
    ];
    const ignored = dualSignalSilenceRemovals([{ startMs: 2000, endMs: 5000 }], transcript, 20000, "tight");
    expect(ignored).toHaveLength(0);
  });

  it("treats a leading transcript gap as silence evidence", () => {
    const gaps = transcriptGaps([{ startMs: 3000, endMs: 5000, text: "hi", words: [] }], 8000);
    expect(gaps[0]).toEqual({ startMs: 0, endMs: 3000 });
    expect(gaps.at(-1)).toEqual({ startMs: 5000, endMs: 8000 });
    expect(classifyGap({ startMs: 0, endMs: 3000 }, [{ text: "hi", startMs: 3000, endMs: 5000 }], 8000)).toBe("head");
  });

  it("derives the noise floor from the quietest decile of RMS samples", () => {
    const rms = [-12, -14, -13, -40, -41, -39, -15, -16, -14, -13];
    expect(noiseFloorDbFromRms(rms)).toBe(-40);
    expect(parseRmsLevels("lavfi.astats.Overall.RMS_level=-41.2\nRMS_level=-12.0")).toEqual([-41.2, -12]);
  });
});
