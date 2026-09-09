import { describe, expect, it } from "vitest";
import { buildFilterScript, buildRenderPlan } from "./ffmpeg";
import { canTransition } from "./state-machine";
import { classifyHdr } from "./hdr";

describe("ffmpeg render strategy", () => {
  it("builds trim/concat filter_complex_script from KEEP ranges", () => {
    const script = buildFilterScript([
      { startMs: 0, endMs: 4200, action: "KEEP" },
      { startMs: 4200, endMs: 9100, action: "REMOVE", source: "AUTO_RETAKE" },
      { startMs: 9100, endMs: 14200, action: "KEEP" },
    ]);
    expect(script).toContain("trim=start=0.000:end=4.200");
    expect(script).toContain("trim=start=9.100:end=14.200");
    expect(script).toContain("concat=n=2:v=1:a=1");
    expect(script).not.toContain("4.200:end=9.100");
  });

  it("preserves 4K 30fps in HIGH_QUALITY SDR plan", () => {
    const plan = buildRenderPlan({
      segments: [{ startMs: 0, endMs: 5000, action: "KEEP" }],
      metadata: {
        durationMs: 5000,
        width: 3840,
        height: 2160,
        fpsNum: 30,
        fpsDen: 1,
        videoCodec: "h264",
        audioCodec: "aac",
        hdrType: "SDR",
      },
      preset: "HIGH_QUALITY",
      strategy: "COMPATIBLE_SDR",
      filterScriptPath: "/tmp/filter.txt",
      outputPath: "/tmp/out.mp4",
    });
    expect(plan.width).toBe(3840);
    expect(plan.height).toBe(2160);
    expect(plan.fpsNum).toBe(30);
    expect(plan.videoCodec).toBe("libx264");
    expect(plan.args).toContain("-crf");
    expect(plan.args).toContain("17");
    expect(plan.args).toContain("+faststart");
  });

  it("does not silently tone-map HDR unless Compatible SDR is selected", () => {
    const preserve = buildFilterScript([{ startMs: 0, endMs: 1000, action: "KEEP" }]);
    expect(preserve).not.toContain("tonemap");
    const compatible = buildFilterScript([{ startMs: 0, endMs: 1000, action: "KEEP" }], {
      toneMapToSdr: true,
    });
    expect(compatible).toContain("tonemap=tonemap=hable");
  });
});

describe("state machine", () => {
  it("allows the documented happy path and rejects browser-style jumps", () => {
    expect(canTransition("CREATED", "UPLOADING")).toBe(true);
    expect(canTransition("UPLOADED", "ANALYZING")).toBe(true);
    expect(canTransition("READY_FOR_REVIEW", "RENDERING")).toBe(true);
    expect(canTransition("CREATED", "COMPLETE")).toBe(false);
    expect(canTransition("ANALYZING", "COMPLETE")).toBe(false);
  });
});

describe("hdr classification", () => {
  it("classifies PQ, HLG, and SDR", () => {
    expect(classifyHdr({ colorTransfer: "smpte2084" })).toBe("HDR10_PQ");
    expect(classifyHdr({ colorTransfer: "arib-std-b67" })).toBe("HLG");
    expect(classifyHdr({ colorTransfer: "bt709" })).toBe("SDR");
  });
});
