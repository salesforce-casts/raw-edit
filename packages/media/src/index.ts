import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "@raw-edit/config";
import {
  AppError,
  buildRenderPlan,
  parseFfprobe,
  parseFfmpegProgress,
  parseSilencedetect,
  reconnectArgs,
  redactSignedUrl,
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

    async detectSilence(sourceUrlOrPath, minSilenceSeconds) {
      const result = await ffmpeg([
        ...reconnectArgs(sourceUrlOrPath),
        "-i",
        sourceUrlOrPath,
        "-af",
        `silencedetect=noise=-35dB:d=${minSilenceSeconds.toFixed(2)}`,
        "-f",
        "null",
        "-",
      ]).catch((error: Error) => ({ stdout: "", stderr: error.message }));
      return parseSilencedetect(result.stderr);
    },

    async render(input) {
      const plan = buildRenderPlan({
        segments: input.segments,
        metadata: input.metadata,
        preset: input.preset,
        strategy: input.strategy,
        filterScriptPath: input.filterScriptPath,
        outputPath: input.outputPath,
        sourceUrlOrPath: input.sourceUrlOrPath,
      });
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
