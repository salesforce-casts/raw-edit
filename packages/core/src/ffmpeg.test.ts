import { describe, expect, it } from "vitest";
import { buildFilterScript, buildRenderPlan, reconnectArgs, redactSignedUrl } from "./ffmpeg";
import { canTransition, canTransitionJob } from "./state-machine";
import { classifyHdr } from "./hdr";
import { SELECT_FILTER_SEGMENT_LIMIT } from "./types";

describe("ffmpeg render strategy", () => {
  it("builds trim/concat filter_complex_script from KEEP ranges", () => {
    const script = buildFilterScript([
      { startMs: 0, endMs: 4200, action: "KEEP" },
      { startMs: 4200, endMs: 9100, action: "REMOVE", source: "AUTO_RETAKE" },
      { startMs: 9100, endMs: 14200, action: "KEEP" },
    ]);
    expect(script).toContain("trim=start=0.000:end=4.200");
    expect(script).toContain("atrim=start=0.000:end=4.200");
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
    expect(plan.strategy).toBe("filter_concat");
    expect(plan.args).toContain("-crf");
    expect(plan.args).toContain("17");
    expect(plan.args).toContain("+faststart");
    expect(plan.args).not.toContain("-reconnect");
  });

  it("caps Social and Smaller presets at 1080p", () => {
    const plan = buildRenderPlan({
      segments: [{ startMs: 0, endMs: 1000, action: "KEEP" }],
      metadata: { durationMs: 1000, width: 3840, height: 2160, hdrType: "SDR" },
      preset: "SOCIAL",
      strategy: "COMPATIBLE_SDR",
      filterScriptPath: "/tmp/filter.txt",
      outputPath: "/tmp/out.mp4",
    });
    expect(plan.height).toBe(1080);
    expect(plan.filterScript).toContain("scale=-2:1080");
  });

  it("does not silently tone-map HDR unless Compatible SDR is selected", () => {
    const preserve = buildFilterScript([{ startMs: 0, endMs: 1000, action: "KEEP" }]);
    expect(preserve).not.toContain("tonemap");
    const compatible = buildFilterScript([{ startMs: 0, endMs: 1000, action: "KEEP" }], { toneMapToSdr: true });
    expect(compatible).toContain("tonemap=tonemap=hable");
  });

  it("uses 10-bit HEVC and color tags when preserving HDR", () => {
    const plan = buildRenderPlan({
      segments: [{ startMs: 0, endMs: 1000, action: "KEEP" }],
      metadata: {
        durationMs: 1000,
        width: 3840,
        height: 2160,
        hdrType: "HDR10_PQ",
        colorPrimaries: "bt2020",
        colorTransfer: "smpte2084",
        colorSpace: "bt2020nc",
      },
      preset: "HIGH_QUALITY",
      strategy: "PRESERVE_HDR",
      filterScriptPath: "/tmp/filter.txt",
      outputPath: "/tmp/out.mp4",
    });
    expect(plan.videoCodec).toBe("libx265");
    expect(plan.args).toContain("yuv420p10le");
    expect(plan.args).toContain("-color_primaries");
    expect(plan.notes.some((note) => note.includes("10-bit HEVC"))).toBe(true);
  });

  it("warns that Dolby Vision RPU is not re-encoded", () => {
    const plan = buildRenderPlan({
      segments: [{ startMs: 0, endMs: 1000, action: "KEEP" }],
      metadata: { durationMs: 1000, hdrType: "DOLBY_VISION_OR_UNKNOWN_HDR" },
      preset: "HIGH_QUALITY",
      strategy: "PRESERVE_HDR",
      filterScriptPath: "/tmp/filter.txt",
      outputPath: "/tmp/out.mp4",
    });
    expect(plan.notes.some((note) => note.toLowerCase().includes("dolby vision"))).toBe(true);
  });

  it("carries rotation as metadata instead of a transpose", () => {
    const plan = buildRenderPlan({
      segments: [{ startMs: 0, endMs: 1000, action: "KEEP" }],
      metadata: { durationMs: 1000, hdrType: "SDR", rotationDegrees: 90 },
      preset: "HIGH_QUALITY",
      strategy: "COMPATIBLE_SDR",
      filterScriptPath: "/tmp/filter.txt",
      outputPath: "/tmp/out.mp4",
    });
    expect(plan.args.join(" ")).toContain("rotate=90");
    expect(plan.filterScript).not.toContain("transpose");
  });

  it("adds reconnect flags only for http(s) inputs", () => {
    expect(reconnectArgs("/tmp/original.mov")).toEqual([]);
    expect(reconnectArgs("https://r2.example/object")).toContain("-reconnect");
  });

  it("falls back to select past 400 KEEP ranges", () => {
    const segments = Array.from({ length: SELECT_FILTER_SEGMENT_LIMIT + 1 }, (_, index) => ({
      startMs: index * 1000,
      endMs: index * 1000 + 500,
      action: "KEEP" as const,
    }));
    const plan = buildRenderPlan({
      segments,
      metadata: { durationMs: 500_000, hdrType: "SDR" },
      preset: "HIGH_QUALITY",
      strategy: "COMPATIBLE_SDR",
      filterScriptPath: "/tmp/filter.txt",
      outputPath: "/tmp/out.mp4",
    });
    expect(plan.strategy).toBe("filter_select");
    expect(plan.filterScript).toContain("select=");
    expect(plan.notes.some((note) => note.includes("fallback"))).toBe(true);
  });

  it("redacts signed URLs from stored ffmpeg arguments", () => {
    expect(redactSignedUrl("ffmpeg -i https://secret.example/file?X-Amz-Signature=abc")).toBe(
      "ffmpeg -i [signed-url]",
    );
  });
});

describe("state machine", () => {
  it("allows the documented happy path and rejects browser-style jumps", () => {
    expect(canTransition("CREATED", "UPLOADING")).toBe(true);
    expect(canTransition("UPLOADED", "ANALYZING")).toBe(true);
    expect(canTransition("TRANSCRIBING", "DETECTING_TAKES")).toBe(true);
    expect(canTransition("READY_FOR_REVIEW", "RENDERING")).toBe(true);
    expect(canTransition("COMPLETE", "RENDERING")).toBe(true);
    expect(canTransition("CREATED", "COMPLETE")).toBe(false);
    expect(canTransition("ANALYZING", "COMPLETE")).toBe(false);
  });

  it("allows a reclaimed job to move FAILED → RUNNING", () => {
    expect(canTransitionJob("QUEUED", "RUNNING")).toBe(true);
    expect(canTransitionJob("RUNNING", "SUCCEEDED")).toBe(true);
    expect(canTransitionJob("FAILED", "RUNNING")).toBe(true);
    expect(canTransitionJob("SUCCEEDED", "RUNNING")).toBe(false);
  });
});

describe("hdr classification", () => {
  it("classifies PQ, HLG, and SDR", () => {
    expect(classifyHdr({ colorTransfer: "smpte2084" })).toBe("HDR10_PQ");
    expect(classifyHdr({ colorTransfer: "arib-std-b67" })).toBe("HLG");
    expect(classifyHdr({ colorTransfer: "bt709" })).toBe("SDR");
  });
});
