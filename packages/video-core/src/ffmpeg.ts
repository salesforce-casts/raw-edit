import type { EditSegment, ExportPreset, ExportStrategy, FfprobeMetadata, HdrType } from "@raw-edit/contracts";
import { keepRangesFromEdl } from "./ranges";

export type RenderPlan = {
  filterScript: string;
  args: string[];
  videoCodec: string;
  audioCodec: string;
  width?: number;
  height?: number;
  fpsNum?: number;
  fpsDen?: number;
  notes: string[];
};

const PRESET_CRF: Record<ExportPreset, { crf: number; audioBitrate: string; x265: boolean }> = {
  HIGH_QUALITY: { crf: 17, audioBitrate: "192k", x265: false },
  SMALLER_FILE: { crf: 22, audioBitrate: "128k", x265: false },
  HEVC_HIGH_QUALITY: { crf: 18, audioBitrate: "192k", x265: true },
};

export function buildFilterScript(
  segments: EditSegment[],
  options: { toneMapToSdr?: boolean } = {},
): string {
  const keeps = keepRangesFromEdl(segments);
  if (keeps.length === 0) {
    throw new Error("EDL has no KEEP ranges");
  }
  const lines: string[] = [];
  keeps.forEach((range, index) => {
    const start = (range.startMs / 1000).toFixed(3);
    const end = (range.endMs / 1000).toFixed(3);
    lines.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}];`);
    lines.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}];`);
  });
  const concatInputs = keeps.map((_, index) => `[v${index}][a${index}]`).join("");
  if (options.toneMapToSdr) {
    lines.push(`${concatInputs}concat=n=${keeps.length}:v=1:a=1[outvraw][outa];`);
    lines.push(
      "[outvraw]zscale=t=linear:npl=100,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709,format=yuv420p[outv]",
    );
  } else {
    lines.push(`${concatInputs}concat=n=${keeps.length}:v=1:a=1[outv][outa]`);
  }
  return `${lines.join("\n")}\n`;
}

function hdrEncodeArgs(hdrType: HdrType): string[] {
  return [
    "-pix_fmt",
    "yuv420p10le",
    "-x265-params",
    hdrType === "HLG"
      ? "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc"
      : "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
  ];
}

export function buildRenderPlan(input: {
  segments: EditSegment[];
  metadata: FfprobeMetadata;
  preset: ExportPreset;
  strategy: ExportStrategy;
  filterScriptPath: string;
  outputPath: string;
}): RenderPlan {
  const notes: string[] = [
    "Final render reads the original master only.",
    "A single encode is required for frame-accurate cuts between keyframes.",
  ];
  const toneMapToSdr = input.strategy === "COMPATIBLE_SDR" && input.metadata.hdrType !== "SDR";
  const filterScript = buildFilterScript(input.segments, { toneMapToSdr });
  const preset = PRESET_CRF[input.preset];
  const useHevc =
    input.preset === "HEVC_HIGH_QUALITY" ||
    (input.strategy === "PRESERVE_HDR" && input.metadata.hdrType !== "SDR");
  const videoCodec = useHevc ? "libx265" : "libx264";
  const args = [
    "-hide_banner",
    "-y",
    "-progress",
    "pipe:1",
    "-i",
    "INPUT_PLACEHOLDER",
    "-filter_complex_script",
    input.filterScriptPath,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    videoCodec,
    "-preset",
    "medium",
    "-crf",
    String(preset.crf),
    "-c:a",
    "aac",
    "-b:a",
    preset.audioBitrate,
    "-movflags",
    "+faststart",
  ];

  if (!useHevc) {
    args.push("-pix_fmt", "yuv420p");
  } else if (input.strategy === "PRESERVE_HDR") {
    args.push(...hdrEncodeArgs(input.metadata.hdrType));
    notes.push(
      "Preserve HDR uses 10-bit HEVC with source color tags. Proprietary Dolby Vision dynamic metadata is not claimed to be preserved.",
    );
  }

  if (input.strategy === "COMPATIBLE_SDR" && input.metadata.hdrType !== "SDR") {
    notes.push("Compatible SDR applies an explicit tone-map. This is never implicit.");
  }

  args.push(input.outputPath);

  return {
    filterScript,
    args,
    videoCodec,
    audioCodec: "aac",
    width: input.metadata.width,
    height: input.metadata.height,
    fpsNum: input.metadata.fpsNum,
    fpsDen: input.metadata.fpsDen,
    notes,
  };
}

export function estimatedOutputDurationMs(segments: EditSegment[]): number {
  return keepRangesFromEdl(segments).reduce((sum, range) => sum + (range.endMs - range.startMs), 0);
}

export function parseFfmpegProgress(chunk: string): { outTimeMs?: number } {
  const match = chunk.match(/out_time_ms=(\d+)/);
  if (!match) return {};
  return { outTimeMs: Number(match[1]) / 1000 };
}
