import { classifyHdr, type AudioStreamInfo, type MediaMetadata, type VideoStreamInfo } from '@rawedit/core';
import { FFPROBE_PATH, run } from './exec.js';

interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  color_range?: string;
  display_aspect_ratio?: string;
  bit_rate?: string;
  nb_frames?: string;
  channels?: number;
  sample_rate?: string;
  channel_layout?: string;
  tags?: Record<string, string>;
  side_data_list?: Record<string, unknown>[];
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
}

/**
 * Read technical metadata from a source.
 *
 * `source` is normally a signed R2 URL, so a 4 GB master is never copied onto the
 * worker's disk just to read its header.
 */
export async function probe(source: string): Promise<MediaMetadata> {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    // Mastering-display and Dolby Vision records live in side data.
    '-show_entries', 'stream_side_data_list',
    source,
  ];

  const { stdout } = await run(FFPROBE_PATH, args, { stderrLimit: 8000 });
  const parsed = JSON.parse(stdout) as ProbeOutput;
  return toMetadata(parsed);
}

export function toMetadata(parsed: ProbeOutput): MediaMetadata {
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');

  const video = videoStream ? toVideoStream(videoStream) : null;
  const audio = audioStream ? toAudioStream(audioStream) : null;

  return {
    container: parsed.format?.format_name?.split(',')[0] ?? null,
    formatName: parsed.format?.format_name ?? null,
    duration: Number.parseFloat(parsed.format?.duration ?? '0') || 0,
    size: parsed.format?.size ? Number.parseInt(parsed.format.size, 10) : null,
    bitrate: parsed.format?.bit_rate ? Number.parseInt(parsed.format.bit_rate, 10) : null,
    video,
    audio,
    hdr: classifyHdr(video, videoStream?.side_data_list ?? [], parsed.format?.tags ?? {}),
    raw: parsed,
  };
}

function toVideoStream(stream: ProbeStream): VideoStreamInfo {
  const frameRate = parseRate(stream.r_frame_rate);
  const avgFrameRate = parseRate(stream.avg_frame_rate) || frameRate;

  return {
    index: stream.index,
    codec: stream.codec_name ?? 'unknown',
    profile: stream.profile ?? null,
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    rotation: parseRotation(stream),
    pixelFormat: stream.pix_fmt ?? null,
    bitDepth: parseBitDepth(stream),
    frameRate: frameRate || 30,
    avgFrameRate: avgFrameRate || 30,
    isVariableFrameRate: isVariableFrameRate(frameRate, avgFrameRate),
    colorPrimaries: stream.color_primaries ?? null,
    colorTransfer: stream.color_transfer ?? null,
    colorSpace: stream.color_space ?? null,
    colorRange: stream.color_range ?? null,
    displayAspectRatio: stream.display_aspect_ratio ?? null,
    bitrate: stream.bit_rate ? Number.parseInt(stream.bit_rate, 10) : null,
    nbFrames: stream.nb_frames ? Number.parseInt(stream.nb_frames, 10) : null,
  };
}

function toAudioStream(stream: ProbeStream): AudioStreamInfo {
  return {
    index: stream.index,
    codec: stream.codec_name ?? 'unknown',
    channels: stream.channels ?? 1,
    sampleRate: stream.sample_rate ? Number.parseInt(stream.sample_rate, 10) : 48000,
    bitrate: stream.bit_rate ? Number.parseInt(stream.bit_rate, 10) : null,
    channelLayout: stream.channel_layout ?? null,
  };
}

export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [numerator, denominator] = rate.split('/');
  const top = Number.parseFloat(numerator ?? '0');
  const bottom = denominator === undefined ? 1 : Number.parseFloat(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return 0;
  return top / bottom;
}

/**
 * iPhone portrait video is landscape pixels plus a rotation matrix in side data.
 * Newer ffprobe reports it under `side_data_list`, older builds under `tags.rotate`.
 */
export function parseRotation(stream: ProbeStream): number {
  const displayMatrix = stream.side_data_list?.find(
    (entry) => String(entry['side_data_type'] ?? '').toLowerCase() === 'display matrix',
  );
  const fromMatrix = displayMatrix?.['rotation'];
  if (typeof fromMatrix === 'number') return normalizeRotation(-fromMatrix);

  const fromTag = stream.tags?.['rotate'];
  if (fromTag) {
    const parsed = Number.parseInt(fromTag, 10);
    if (Number.isFinite(parsed)) return normalizeRotation(parsed);
  }
  return 0;
}

function normalizeRotation(degrees: number): number {
  const rounded = Math.round(degrees / 90) * 90;
  return ((rounded % 360) + 360) % 360;
}

export function parseBitDepth(stream: ProbeStream): number | null {
  if (stream.bits_per_raw_sample) {
    const parsed = Number.parseInt(stream.bits_per_raw_sample, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const pixelFormat = stream.pix_fmt ?? '';
  const match = /p(\d+)(le|be)?$/.exec(pixelFormat);
  if (match) {
    const parsed = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return pixelFormat === '' ? null : 8;
}

/**
 * Treat a source as VFR only when the nominal and average rates differ by more than
 * 2%. iPhone captures often report 30000/1001 vs 29.97 and are effectively constant;
 * calling those VFR would push every render onto the heavier concat path for nothing.
 */
export function isVariableFrameRate(frameRate: number, avgFrameRate: number): boolean {
  if (frameRate <= 0 || avgFrameRate <= 0) return false;
  return Math.abs(frameRate - avgFrameRate) / Math.max(frameRate, avgFrameRate) > 0.02;
}
