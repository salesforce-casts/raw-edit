import type { FfprobeMetadata, HdrType } from "@raw-edit/contracts";

export function classifyHdr(input: {
  colorTransfer?: string | null;
  colorPrimaries?: string | null;
  pixelFormat?: string | null;
  sideData?: string | null;
}): HdrType {
  const transfer = (input.colorTransfer ?? "").toLowerCase();
  const primaries = (input.colorPrimaries ?? "").toLowerCase();
  const side = (input.sideData ?? "").toLowerCase();
  if (side.includes("dolby") || side.includes("dovi")) return "DOLBY_VISION_OR_UNKNOWN_HDR";
  if (transfer.includes("smpte2084") || transfer.includes("pq")) return "HDR10_PQ";
  if (transfer.includes("arib-std-b67") || transfer.includes("hlg")) return "HLG";
  if (primaries.includes("bt2020") && (input.pixelFormat ?? "").includes("10")) {
    return "DOLBY_VISION_OR_UNKNOWN_HDR";
  }
  return "SDR";
}

export function parseFrameRate(rate?: string | null): { fpsNum?: number; fpsDen?: number } {
  if (!rate || rate === "0/0") return {};
  const [num, den] = rate.split("/").map((part) => Number(part));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return {};
  return { fpsNum: num, fpsDen: den };
}

export function parseFfprobe(json: {
  format?: { duration?: string; bit_rate?: string };
  streams?: Array<Record<string, unknown>>;
}): FfprobeMetadata {
  const video = json.streams?.find((stream) => stream.codec_type === "video");
  const audio = json.streams?.find((stream) => stream.codec_type === "audio");
  const durationSec = Number(json.format?.duration ?? video?.duration ?? 0);
  const fps = parseFrameRate(typeof video?.avg_frame_rate === "string" ? video.avg_frame_rate : undefined);
  const rotation =
    Number((video?.tags as { rotate?: string } | undefined)?.rotate) ||
    Number(
      ((video?.side_data_list as Array<{ rotation?: number }> | undefined) ?? []).find((item) => item.rotation)
        ?.rotation,
    ) ||
    0;
  const colorTransfer = typeof video?.color_transfer === "string" ? video.color_transfer : undefined;
  const colorPrimaries = typeof video?.color_primaries === "string" ? video.color_primaries : undefined;
  const pixelFormat = typeof video?.pix_fmt === "string" ? video.pix_fmt : undefined;
  const sideData = JSON.stringify(video?.side_data_list ?? []);
  return {
    durationMs: Math.round(durationSec * 1000),
    width: typeof video?.width === "number" ? video.width : undefined,
    height: typeof video?.height === "number" ? video.height : undefined,
    fpsNum: fps.fpsNum,
    fpsDen: fps.fpsDen,
    videoCodec: typeof video?.codec_name === "string" ? video.codec_name : undefined,
    audioCodec: typeof audio?.codec_name === "string" ? audio.codec_name : undefined,
    pixelFormat,
    bitRate: json.format?.bit_rate ? Number(json.format.bit_rate) : undefined,
    colorSpace: typeof video?.color_space === "string" ? video.color_space : undefined,
    colorTransfer,
    colorPrimaries,
    hdrType: classifyHdr({ colorTransfer, colorPrimaries, pixelFormat, sideData }),
    rotationDegrees: rotation || undefined,
  };
}
