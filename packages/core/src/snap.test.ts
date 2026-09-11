import { describe, expect, it } from "vitest";
import { snapCutMs } from "./snap";
import { canSmartRender, planSmartRenderPieces } from "./ffmpeg";

describe("keyframe-aware snapping", () => {
  it("ranks transcript word boundaries above keyframes", () => {
    const snapped = snapCutMs(1000, {
      wordBoundaryMs: [1100],
      keyframeMs: [1050],
      silentGaps: [{ startMs: 900, endMs: 1300 }],
      windowMs: 200,
    });
    expect(snapped).toBe(1100);
  });

  it("snaps to a nearby keyframe only inside a silent gap", () => {
    const inGap = snapCutMs(1000, {
      wordBoundaryMs: [],
      keyframeMs: [1200],
      silentGaps: [{ startMs: 800, endMs: 1300 }],
      windowMs: 200,
    });
    expect(inGap).toBe(1200);
    const speech = snapCutMs(1000, {
      wordBoundaryMs: [],
      keyframeMs: [1200],
      silentGaps: [],
      windowMs: 200,
    });
    expect(speech).toBe(1000);
  });
});

describe("smart render", () => {
  it("copies keyframe-aligned HIGH_QUALITY h264 and skips Social / tone-map paths", () => {
    expect(
      canSmartRender({
        preset: "HIGH_QUALITY",
        strategy: "COMPATIBLE_SDR",
        metadata: { durationMs: 5000, videoCodec: "h264", hdrType: "SDR" },
      }),
    ).toBe(true);
    expect(
      canSmartRender({
        preset: "SOCIAL",
        strategy: "COMPATIBLE_SDR",
        metadata: { durationMs: 5000, videoCodec: "h264", hdrType: "SDR" },
      }),
    ).toBe(false);
    expect(
      canSmartRender({
        preset: "HIGH_QUALITY",
        strategy: "COMPATIBLE_SDR",
        metadata: { durationMs: 5000, videoCodec: "h264", hdrType: "HDR10_PQ" },
      }),
    ).toBe(false);
  });

  it("re-encodes only the mid-GOP fragment", () => {
    const pieces = planSmartRenderPieces([{ startMs: 500, endMs: 4000 }], [0, 2000, 4000, 6000]);
    expect(pieces).toEqual([
      { startMs: 500, endMs: 2000, mode: "recode" },
      { startMs: 2000, endMs: 4000, mode: "copy" },
    ]);
  });
});
