import type { MediaMetadata } from '../types/media.js';
import { displayDimensions } from '../types/media.js';
import type { ExportPresetId, ExportStrategy } from '../types/status.js';

export interface ExportPreset {
  id: ExportPresetId;
  label: string;
  description: string;
  strategy: ExportStrategy;
  /** Longest edge cap; null keeps the source resolution (4K stays 4K). */
  maxLongEdge: number | null;
  /** Constant Rate Factor for H.264. HEVC uses `crfHevc`. */
  crf: number;
  crfHevc: number;
  preset: string;
  audioBitrateKbps: number;
}

export const EXPORT_PRESET_LIST: readonly ExportPreset[] = [
  {
    id: 'ORIGINAL_QUALITY',
    label: 'Original Quality',
    description: 'Keeps the source resolution, frame rate and codec family. 4K stays 4K.',
    strategy: 'PRESERVE_SOURCE',
    maxLongEdge: null,
    crf: 18,
    crfHevc: 20,
    preset: 'slow',
    audioBitrateKbps: 192,
  },
  {
    id: 'SOCIAL_MEDIA',
    label: 'Social Media',
    description: 'H.264 MP4 that every platform accepts, scaled to at most 1080p.',
    strategy: 'COMPATIBLE_MP4',
    maxLongEdge: 1920,
    crf: 20,
    crfHevc: 22,
    preset: 'medium',
    audioBitrateKbps: 160,
  },
  {
    id: 'SMALLER_FILE',
    label: 'Smaller File',
    description: 'Same compatibility, noticeably smaller. Good for drafts and reviews.',
    strategy: 'COMPATIBLE_MP4',
    maxLongEdge: 1920,
    crf: 26,
    crfHevc: 28,
    preset: 'medium',
    audioBitrateKbps: 128,
  },
];

export const DEFAULT_EXPORT_PRESET: ExportPresetId = 'ORIGINAL_QUALITY';

export function getPreset(id: ExportPresetId): ExportPreset {
  return EXPORT_PRESET_LIST.find((preset) => preset.id === id) ?? EXPORT_PRESET_LIST[0]!;
}

export interface ExportPlanSummary {
  preset: ExportPresetId;
  strategy: ExportStrategy;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: 'h264' | 'hevc';
  audioCodec: 'aac';
  container: 'mp4';
  /** Bytes; a model, not a promise — labelled "estimated" everywhere in the UI. */
  estimatedSize: number;
  /** Anything the user should know before they spend a render on this. */
  warnings: string[];
  scaled: boolean;
  toneMapped: boolean;
}

/**
 * Everything the review screen needs to show before a render is queued: the exact
 * output resolution, codec and a size estimate.
 */
export function planExport(
  metadata: MediaMetadata,
  presetId: ExportPresetId,
  outputDuration: number,
): ExportPlanSummary {
  const preset = getPreset(presetId);
  const warnings: string[] = [];

  const source = metadata.video;
  const display = source ? displayDimensions(source) : { width: 1080, height: 1920 };
  const frameRate = source?.avgFrameRate && source.avgFrameRate > 0 ? source.avgFrameRate : 30;

  let { width, height } = display;
  let scaled = false;
  if (preset.maxLongEdge !== null) {
    const longEdge = Math.max(width, height);
    if (longEdge > preset.maxLongEdge) {
      const ratio = preset.maxLongEdge / longEdge;
      // Even dimensions keep yuv420p happy.
      width = Math.round((width * ratio) / 2) * 2;
      height = Math.round((height * ratio) / 2) * 2;
      scaled = true;
    }
  }

  const sourceIsHevc = (source?.codec ?? '').toLowerCase().includes('hevc') || (source?.codec ?? '') === 'h265';
  const videoCodec: 'h264' | 'hevc' =
    preset.strategy === 'PRESERVE_SOURCE' && sourceIsHevc ? 'hevc' : 'h264';

  const toneMapped = metadata.hdr.isHdr && preset.strategy === 'COMPATIBLE_MP4';
  if (toneMapped) {
    warnings.push('HDR source will be tone-mapped to SDR for this preset.');
  }
  if (metadata.hdr.format === 'DOLBY_VISION' && preset.strategy === 'PRESERVE_SOURCE') {
    warnings.push('Dolby Vision metadata cannot be re-encoded; the HDR10 base layer is kept.');
  }
  if (scaled) {
    warnings.push(`Scaled from ${display.width}×${display.height} to ${width}×${height}.`);
  }
  if (source?.isVariableFrameRate) {
    warnings.push('Source is variable frame rate; output will be normalised where needed.');
  }

  const crf = videoCodec === 'hevc' ? preset.crfHevc : preset.crf;
  const estimatedSize = estimateExportSize({
    width,
    height,
    frameRate,
    durationSeconds: outputDuration,
    codec: videoCodec,
    crf,
    audioBitrateKbps: preset.audioBitrateKbps,
  });

  return {
    preset: preset.id,
    strategy: preset.strategy,
    width,
    height,
    frameRate: Number(frameRate.toFixed(3)),
    videoCodec,
    audioCodec: 'aac',
    container: 'mp4',
    estimatedSize,
    warnings,
    scaled,
    toneMapped,
  };
}

export interface SizeEstimateInput {
  width: number;
  height: number;
  frameRate: number;
  durationSeconds: number;
  codec: 'h264' | 'hevc';
  crf: number;
  audioBitrateKbps: number;
}

/**
 * Bits-per-pixel model for CRF encoding.
 *
 * Anchor: x264 at CRF 23 on typical talking-head content lands around 0.08 bpp, and
 * each CRF step is roughly a 12% bitrate change. HEVC reaches the same perceptual
 * quality at roughly 60% of the bits. This is a rough estimate and the UI labels it
 * as one, but it is a real model rather than a made-up multiplier.
 */
export function estimateExportSize(input: SizeEstimateInput): number {
  const { width, height, frameRate, durationSeconds, codec, crf, audioBitrateKbps } = input;
  if (durationSeconds <= 0 || width <= 0 || height <= 0) return 0;

  const baseBpp = 0.08;
  const bpp = baseBpp * Math.pow(0.88, crf - 23) * (codec === 'hevc' ? 0.6 : 1);
  const videoBitsPerSecond = bpp * width * height * frameRate;
  const audioBitsPerSecond = audioBitrateKbps * 1000;
  const bytes = ((videoBitsPerSecond + audioBitsPerSecond) * durationSeconds) / 8;
  // 2% container overhead (moov atom, interleaving).
  return Math.round(bytes * 1.02);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}
