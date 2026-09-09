import { stat } from 'node:fs/promises';
import {
  buildAudioExtractCommand,
  buildProxyCommand,
  buildSilenceDetectCommand,
  buildThumbnailCommand,
  parseSilenceDetect,
  type ExtractAudioInput,
  type MediaMetadata,
  type ProbeInput,
  type RenderInput,
  type RenderOutput,
  type TimeRange,
  type VideoProcessor,
  type WaveformPeaks,
} from '@rawedit/core';
import { FFMPEG_PATH, progressSeconds, run } from './exec.js';
import { probe } from './ffprobe.js';
import { computeWaveformFromWav } from './waveform.js';

/**
 * The real implementation of `VideoProcessor`: everything that shells out to
 * ffmpeg or ffprobe lives here and nowhere else.
 */
export class FfmpegVideoProcessor implements VideoProcessor {
  readonly name = 'ffmpeg';

  async probe(input: ProbeInput): Promise<MediaMetadata> {
    return probe(input.source);
  }

  /** 16 kHz mono PCM — the only thing the transcriber ever sees. */
  async extractAudio(input: ExtractAudioInput): Promise<{ path: string; duration: number }> {
    const args = buildAudioExtractCommand(input.source, input.outputPath);
    await run(FFMPEG_PATH, args, {
      onProgress: (fields) => {
        const seconds = progressSeconds(fields);
        if (seconds !== null && input.durationSeconds > 0) {
          input.onProgress?.(Math.min(1, seconds / input.durationSeconds));
        }
      },
    });
    input.onProgress?.(1);
    return { path: input.outputPath, duration: input.durationSeconds };
  }

  async detectSilence(
    audioPath: string,
    duration: number,
    noiseDb = -32,
    minDuration = 0.25,
  ): Promise<TimeRange[]> {
    const args = buildSilenceDetectCommand(audioPath, noiseDb, minDuration);
    // silencedetect writes to stderr and the command exits 0 with `-f null`.
    const { stderr } = await run(FFMPEG_PATH, args, { stderrLimit: 2_000_000 });
    return parseSilenceDetect(stderr, duration);
  }

  async computeWaveform(audioPath: string, duration: number, resolution = 20): Promise<WaveformPeaks> {
    return computeWaveformFromWav(audioPath, duration, resolution);
  }

  async generateThumbnail(source: string, outputPath: string, atSeconds: number): Promise<string> {
    await run(FFMPEG_PATH, buildThumbnailCommand(source, outputPath, atSeconds), { stderrLimit: 8000 });
    return outputPath;
  }

  /** 720p preview proxy. Used by the player only; never a render source. */
  async generateProxy(
    source: string,
    outputPath: string,
    metadata: MediaMetadata,
    onProgress?: (fraction: number) => void,
  ): Promise<{ path: string; size: number }> {
    const args = buildProxyCommand(source, outputPath, metadata);
    await run(FFMPEG_PATH, args, {
      onProgress: (fields) => {
        const seconds = progressSeconds(fields);
        if (seconds !== null && metadata.duration > 0) {
          onProgress?.(Math.min(1, seconds / metadata.duration));
        }
      },
    });
    const info = await stat(outputPath);
    onProgress?.(1);
    return { path: outputPath, size: info.size };
  }

  /**
   * The single render pass. Progress comes from ffmpeg's own `out_time_us` against
   * the planned output duration — a real measurement, not a timer.
   */
  async render(input: RenderInput): Promise<RenderOutput> {
    const { command } = input;
    const outputPath = command.args[command.args.length - 1]!;
    const logLines: string[] = [];

    const { stderr } = await run(FFMPEG_PATH, command.args, {
      signal: input.signal,
      stderrLimit: 128_000,
      onProgress: (fields) => {
        const seconds = progressSeconds(fields);
        if (seconds !== null && command.expectedDuration > 0) {
          input.onProgress?.(Math.min(0.999, seconds / command.expectedDuration));
        }
      },
      onStderrLine: (line) => {
        // Keep warnings and errors; drop ffmpeg's routine banner noise.
        if (/error|warning|invalid|failed|deprecated/i.test(line)) {
          logLines.push(line);
          if (logLines.length > 400) logLines.shift();
        }
      },
    });

    const info = await stat(outputPath);
    if (info.size === 0) {
      throw new Error('ffmpeg produced an empty file');
    }

    // Trust the file, not the plan: read back what was actually written.
    const rendered = await probe(outputPath);
    input.onProgress?.(1);

    return {
      outputPath,
      size: info.size,
      duration: rendered.duration,
      log: logLines.length > 0 ? logLines.join('\n') : stderr.slice(-8000),
    };
  }
}
