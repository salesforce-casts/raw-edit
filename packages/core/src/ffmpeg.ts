import type { EditSegment, ExportPreset, ExportStrategy, FfprobeMetadata, HdrType } from "./types";
import { SELECT_FILTER_SEGMENT_LIMIT } from "./types";
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
  strategy: "filter_concat" | "filter_select";
};

const PRESET_CRF: Record<ExportPreset, { crf: number; audioBitrate: string; capHeight?: number }> = {
  HIGH_QUALITY: { crf: 17, audioBitrate: "192k" },
  SOCIAL: { crf: 18, audioBitrate: "160k", capHeight: 1080 },
  SMALLER_FILE: { crf: 22, audioBitrate: "128k", capHeight: 1080 },
  HEVC_HIGH_QUALITY: { crf: 18, audioBitrate: "192k" },
};

export function isRemoteMediaPath(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

export function reconnectArgs(input: string): string[] {
  if (!isRemoteMediaPath(input)) return [];
  return ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1"];
}

export function colorTagArgs(metadata: FfprobeMetadata, hdr: boolean): string[] {
  const args: string[] = [];
  if (metadata.colorPrimaries) args.push("-color_primaries", metadata.colorPrimaries);
  if (metadata.colorTransfer) args.push("-color_trc", metadata.colorTransfer);
  if (metadata.colorSpace) args.push("-colorspace", metadata.colorSpace);
  if (hdr && metadata.masteringDisplay) args.push("-mastering_display_metadata", metadata.masteringDisplay);
  if (hdr && metadata.maxCll) args.push("-max_cll", metadata.maxCll);
  return args;
}

function scaleFilter(metadata: FfprobeMetadata, capHeight?: number): string {
  if (!capHeight || !metadata.height || metadata.height <= capHeight) return "";
  return `scale=-2:${capHeight}`;
}

export function buildFilterScript(
  segments: EditSegment[],
  options: { toneMapToSdr?: boolean; mode?: "concat" | "select"; scale?: string } = {},
): string {
  const keeps = keepRangesFromEdl(segments);
  if (keeps.length === 0) throw new Error("EDL has no KEEP ranges");
  const mode = options.mode ?? (keeps.length > SELECT_FILTER_SEGMENT_LIMIT ? "select" : "concat");
  const tone = options.toneMapToSdr
    ? ",zscale=t=linear:npl=100,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709,format=yuv420p"
    : "";
  const scale = options.scale ? `,${options.scale}` : "";

  if (mode === "select") {
    const videoExpr = keeps.map((range) => `between(t,${(range.startMs / 1000).toFixed(3)},${(range.endMs / 1000).toFixed(3)})`).join("+");
    const audioExpr = keeps.map((range) => `between(t,${(range.startMs / 1000).toFixed(3)},${(range.endMs / 1000).toFixed(3)})`).join("+");
    return `[0:v]select='${videoExpr}',setpts=N/FRAME_RATE/TB${scale}${tone}[outv];\n[0:a]aselect='${audioExpr}',asetpts=N/SR/TB[outa]\n`;
  }

  const lines: string[] = [];
  keeps.forEach((range, index) => {
    const start = (range.startMs / 1000).toFixed(3);
    const end = (range.endMs / 1000).toFixed(3);
    lines.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}];`);
    lines.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}];`);
  });
  const concatInputs = keeps.map((_, index) => `[v${index}][a${index}]`).join("");
  const videoTail = `${scale}${tone}`.replace(/^,/, "");
  if (videoTail) {
    lines.push(`${concatInputs}concat=n=${keeps.length}:v=1:a=1[outvraw][outa];`);
    lines.push(`[outvraw]${videoTail}[outv]`);
  } else {
    lines.push(`${concatInputs}concat=n=${keeps.length}:v=1:a=1[outv][outa]`);
  }
  return `${lines.join("\n")}\n`;
}

function hdrEncodeArgs(hdrType: HdrType, metadata: FfprobeMetadata): string[] {
  const transfer =
    hdrType === "HLG"
      ? "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc"
      : "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc";
  const extras: string[] = [];
  if (metadata.masteringDisplay) extras.push(`master-display=${metadata.masteringDisplay}`);
  if (metadata.maxCll) extras.push(`max-cll=${metadata.maxCll}`);
  return ["-pix_fmt", "yuv420p10le", "-x265-params", [transfer, ...extras].join(":")];
}

export function buildRenderPlan(input: {
  segments: EditSegment[];
  metadata: FfprobeMetadata;
  preset: ExportPreset;
  strategy: ExportStrategy;
  filterScriptPath: string;
  outputPath: string;
  sourceUrlOrPath?: string;
}): RenderPlan {
  const keeps = keepRangesFromEdl(input.segments).length;
  const useSelect = keeps > SELECT_FILTER_SEGMENT_LIMIT;
  const notes: string[] = [
    "Final render reads the original master only.",
    "A single encode is required for frame-accurate cuts between keyframes.",
  ];
  if (useSelect) {
    notes.push(
      `More than ${SELECT_FILTER_SEGMENT_LIMIT} KEEP ranges: using select/aselect fallback. Audio/video grids can drift; concat is preferred.`,
    );
  }
  const toneMapToSdr = input.strategy === "COMPATIBLE_SDR" && input.metadata.hdrType !== "SDR";
  const preset = PRESET_CRF[input.preset];
  const scale = scaleFilter(input.metadata, preset.capHeight);
  if (preset.capHeight && input.metadata.height && input.metadata.height > preset.capHeight) {
    notes.push(`${input.preset} caps output at ${preset.capHeight}p.`);
  }
  const filterScript = buildFilterScript(input.segments, {
    toneMapToSdr,
    mode: useSelect ? "select" : "concat",
    scale: scale || undefined,
  });
  const preserveHdr = input.strategy === "PRESERVE_HDR" && input.metadata.hdrType !== "SDR";
  const useHevc = input.preset === "HEVC_HIGH_QUALITY" || preserveHdr;
  const videoCodec = useHevc ? "libx265" : "libx264";
  const inputPath = input.sourceUrlOrPath ?? "INPUT_PLACEHOLDER";
  const args = [
    "-hide_banner",
    "-y",
    "-progress",
    "pipe:1",
    ...reconnectArgs(inputPath),
    "-i",
    inputPath === input.sourceUrlOrPath ? inputPath : "INPUT_PLACEHOLDER",
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
    ...colorTagArgs(input.metadata, preserveHdr),
  ];

  if (input.metadata.rotationDegrees) {
    args.push("-metadata:s:v:0", `rotate=${input.metadata.rotationDegrees}`);
    notes.push("Rotation is carried as metadata and is never baked in with a transpose.");
  }

  if (!useHevc) {
    args.push("-pix_fmt", toneMapToSdr || !input.metadata.pixelFormat ? "yuv420p" : input.metadata.pixelFormat);
  } else if (preserveHdr) {
    args.push(...hdrEncodeArgs(input.metadata.hdrType, input.metadata));
    if (input.metadata.hdrType === "DOLBY_VISION_OR_UNKNOWN_HDR") {
      notes.push("Dolby Vision RPU cannot be re-encoded by libx265. The HDR10 base layer is kept.");
    } else {
      notes.push("Preserve HDR uses 10-bit HEVC with source color tags and mastering display metadata.");
    }
  }

  if (toneMapToSdr) notes.push("Compatible SDR applies an explicit tone-map. This is never implicit.");
  args.push(input.outputPath);

  const height =
    preset.capHeight && input.metadata.height
      ? Math.min(input.metadata.height, preset.capHeight)
      : input.metadata.height;

  return {
    filterScript,
    args,
    videoCodec,
    audioCodec: "aac",
    width: input.metadata.width,
    height,
    fpsNum: input.metadata.fpsNum,
    fpsDen: input.metadata.fpsDen,
    notes,
    strategy: useSelect ? "filter_select" : "filter_concat",
  };
}

export function estimatedOutputDurationMs(segments: EditSegment[]): number {
  return keepRangesFromEdl(segments).reduce((sum, range) => sum + (range.endMs - range.startMs), 0);
}

export function parseFfmpegProgress(chunk: string): { outTimeMs?: number } {
  const us = chunk.match(/out_time_us=(\d+)/);
  if (us) return { outTimeMs: Number(us[1]) / 1000 };
  const ms = chunk.match(/out_time_ms=(\d+)/);
  if (ms) return { outTimeMs: Number(ms[1]) / 1000 };
  return {};
}

export function redactSignedUrl(value: string): string {
  return value.replace(/https?:\/\/[^\s]+/gi, "[signed-url]");
}
