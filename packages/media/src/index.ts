import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "@raw-edit/config";
import {
  AppError,
  acousticMinSilenceSeconds,
  buildRenderPlan,
  noiseFloorDbFromRms,
  parseFfprobe,
  parseFfmpegProgress,
  parseRmsLevels,
  parseSilencedetect,
  reconnectArgs,
  redactSignedUrl,
  type RenderInput,
  type VideoProcessor,
} from "@raw-edit/core";

function runCommand(bin: string, args: string[], onStdout?: (chunk: string) => void) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function parseKeyframeMs(text: string): number[] {
  const times: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = Number.parseFloat(line.trim());
    if (Number.isFinite(value) && value >= 0) times.push(Math.round(value * 1000));
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

export function createFfmpegProcessor(config = loadConfig()): VideoProcessor {
  const ffmpegBin = config.ffmpegPath;
  const ffprobeBin = config.ffprobePath;
  const ffmpeg = (args: string[], onStdout?: (chunk: string) => void) => runCommand(ffmpegBin, args, onStdout);
  const ffprobe = (args: string[]) => runCommand(ffprobeBin, args);

  return {
    async probe(sourceUrlOrPath) {
      const result = await ffprobe([
        "-v",
        "error",
        ...reconnectArgs(sourceUrlOrPath),
        "-show_format",
        "-show_streams",
        "-print_format",
        "json",
        sourceUrlOrPath,
      ]).catch((error: Error) => {
        throw new AppError("FFPROBE_FAILED", error.message, 502, true);
      });
      const metadata = parseFfprobe(JSON.parse(result.stdout));
      if (!metadata.durationMs) throw new AppError("INVALID_MEDIA", "Could not read duration", 400, true);
      if (!metadata.audioCodec) throw new AppError("INVALID_MEDIA", "Source has no audio stream", 400, true);
      return metadata;
    },

    async extractPoster(sourceUrlOrPath, destPath) {
      await ffmpeg(["-y", ...reconnectArgs(sourceUrlOrPath), "-i", sourceUrlOrPath, "-frames:v", "1", "-q:v", "3", destPath]);
    },

    async extractProxy(sourceUrlOrPath, destPath) {
      await ffmpeg([
        "-y",
        ...reconnectArgs(sourceUrlOrPath),
        "-i",
        sourceUrlOrPath,
        "-vf",
        "scale='min(1280,iw)':-2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        "2500k",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        destPath,
      ]);
    },

    async extractTranscriptionAudio(sourceUrlOrPath, destPath) {
      await ffmpeg([
        "-y",
        ...reconnectArgs(sourceUrlOrPath),
        "-i",
        sourceUrlOrPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        destPath,
      ]);
    },

    async extractAnalysisVisuals(sourceUrlOrPath, dest) {
      await ffmpeg([
        "-y",
        ...reconnectArgs(sourceUrlOrPath),
        "-i",
        sourceUrlOrPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        "scale='min(1280,iw)':-2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        "2500k",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        dest.proxyPath,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-q:v",
        "3",
        dest.posterPath,
        "-map",
        "0:v:0",
        "-vf",
        "fps=1/12,scale=160:-2,tile=10x1",
        "-frames:v",
        "1",
        dest.filmstripPath,
      ]);
    },

    async extractKeyframes(sourceUrlOrPath) {
      const result = await ffprobe([
        "-v",
        "error",
        ...reconnectArgs(sourceUrlOrPath),
        "-select_streams",
        "v:0",
        "-skip_frame",
        "nokey",
        "-show_entries",
        "frame=pts_time,pkt_pts_time",
        "-of",
        "csv=p=0",
        sourceUrlOrPath,
      ]).catch(() => ({ stdout: "", stderr: "" }));
      return parseKeyframeMs(result.stdout);
    },

    async detectSilence(sourceUrlOrPath, minSilenceSeconds) {
      const stats = await ffmpeg([
        ...reconnectArgs(sourceUrlOrPath),
        "-i",
        sourceUrlOrPath,
        "-af",
        "astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level",
        "-f",
        "null",
        "-",
      ]).catch((error: Error) => ({ stdout: "", stderr: error.message }));
      const floor = noiseFloorDbFromRms(parseRmsLevels(`${stats.stdout}\n${stats.stderr}`));
      const noiseDb = floor ?? -35;
      const duration = minSilenceSeconds > 0 ? minSilenceSeconds : acousticMinSilenceSeconds();
      const result = await ffmpeg([
        ...reconnectArgs(sourceUrlOrPath),
        "-i",
        sourceUrlOrPath,
        "-af",
        `silencedetect=noise=${noiseDb.toFixed(1)}dB:d=${duration.toFixed(2)}`,
        "-f",
        "null",
        "-",
      ]).catch((error: Error) => ({ stdout: "", stderr: error.message }));
      return parseSilencedetect(result.stderr);
    },

    async render(input: RenderInput) {
      const plan = buildRenderPlan({
        segments: input.segments,
        metadata: input.metadata,
        preset: input.preset,
        strategy: input.strategy,
        filterScriptPath: input.filterScriptPath,
        outputPath: input.outputPath,
        sourceUrlOrPath: input.sourceUrlOrPath,
        keyframeMs: input.keyframeMs,
      });
      if (plan.strategy === "smart_copy" && plan.smartPieces && plan.smartPieces.length > 0) {
        const dir = input.workDir ?? dirname(input.outputPath);
        const listPath = join(dir, "concat.txt");
        const lines: string[] = [];
        for (const [index, piece] of plan.smartPieces.entries()) {
          const dest = join(dir, `piece-${index}.mp4`);
          const start = (piece.startMs / 1000).toFixed(3);
          const end = (piece.endMs / 1000).toFixed(3);
          if (piece.mode === "copy") {
            await ffmpeg([
              "-y",
              ...reconnectArgs(input.sourceUrlOrPath),
              "-ss",
              start,
              "-to",
              end,
              "-i",
              input.sourceUrlOrPath,
              "-c",
              "copy",
              "-avoid_negative_ts",
              "make_zero",
              dest,
            ]);
          } else {
            await ffmpeg([
              "-y",
              ...reconnectArgs(input.sourceUrlOrPath),
              "-i",
              input.sourceUrlOrPath,
              "-ss",
              start,
              "-to",
              end,
              "-c:v",
              plan.videoCodec,
              "-preset",
              plan.videoCodec === "libx265" ? "veryfast" : "medium",
              "-crf",
              input.preset === "HEVC_HIGH_QUALITY" ? "18" : "17",
              "-c:a",
              "aac",
              "-b:a",
              "192k",
              dest,
            ]);
          }
          lines.push(`file '${dest.replace(/'/g, "'\\''")}'`);
        }
        await writeFile(listPath, `${lines.join("\n")}\n`, "utf8");
        await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", input.outputPath]);
        input.onProgress?.(plan.smartPieces.reduce((sum, piece) => sum + (piece.endMs - piece.startMs), 0));
        return;
      }
      await writeFile(input.filterScriptPath, plan.filterScript, "utf8");
      const args = plan.args.map((arg) => (arg === "INPUT_PLACEHOLDER" ? input.sourceUrlOrPath : arg));
      await ffmpeg(args, (chunk) => {
        const { outTimeMs } = parseFfmpegProgress(chunk);
        if (outTimeMs != null) input.onProgress?.(outTimeMs);
      });
    },
  };
}

export function ffmpegCommandForLog(args: string[]): string {
  return redactSignedUrl(args.join(" "));
}
