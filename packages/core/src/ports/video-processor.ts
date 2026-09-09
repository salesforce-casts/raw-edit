import type { MediaMetadata } from '../types/media.js';
import type { TimeRange } from '../types/edl.js';
import type { RenderCommand } from '../render/ffmpeg-args.js';

export interface ProbeInput {
  /** Signed URL or local path. A URL avoids downloading a 4 GB file to read a header. */
  source: string;
}

export interface ExtractAudioInput {
  source: string;
  outputPath: string;
  durationSeconds: number;
  onProgress?: (fraction: number) => void;
}

export interface RenderInput {
  command: RenderCommand;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface RenderOutput {
  outputPath: string;
  size: number;
  duration: number;
  log: string;
}

export interface WaveformPeaks {
  /** Samples per second of the peak array. */
  resolution: number;
  /** Normalised 0..1 peaks. */
  peaks: number[];
}

/** Everything that shells out to ffmpeg/ffprobe, behind one interface. */
export interface VideoProcessor {
  readonly name: string;
  probe(input: ProbeInput): Promise<MediaMetadata>;
  extractAudio(input: ExtractAudioInput): Promise<{ path: string; duration: number }>;
  detectSilence(audioPath: string, duration: number, noiseDb?: number, minDuration?: number): Promise<TimeRange[]>;
  computeWaveform(audioPath: string, duration: number, resolution?: number): Promise<WaveformPeaks>;
  generateThumbnail(source: string, outputPath: string, atSeconds: number): Promise<string>;
  generateProxy(
    source: string,
    outputPath: string,
    metadata: MediaMetadata,
    onProgress?: (fraction: number) => void,
  ): Promise<{ path: string; size: number }>;
  render(input: RenderInput): Promise<RenderOutput>;
}
