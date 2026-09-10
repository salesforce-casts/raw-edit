import type { HdrFormat, MediaMetadata } from './media.js';

/**
 * The `video` table's technical columns, as stored by the analysis job.
 *
 * Declared here rather than imported from `@rawedit/db` so `core` keeps its rule of
 * depending on nothing.
 */
export interface StoredMediaRow {
  duration: number;
  width: number;
  height: number;
  rotation: number;
  frameRate: number;
  avgFrameRate: number;
  isVariableFrameRate: boolean;
  videoCodec: string | null;
  videoProfile: string | null;
  pixelFormat: string | null;
  bitDepth: number | null;
  displayAspectRatio: string | null;
  bitrate: number | null;
  audioCodec: string | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorSpace: string | null;
  colorRange: string | null;
  isHdr: boolean;
  hdrFormat: string | null;
  masterDisplay: string | null;
  maxCll: string | null;
  container: string | null;
  size: number | null;
}

const HDR_FORMATS: readonly string[] = ['HDR10', 'HDR10_PLUS', 'HLG', 'DOLBY_VISION'];

/**
 * Rebuild the probe-shaped metadata the render planner needs from stored columns.
 *
 * The render job must not re-probe: the source may be several gigabytes and the
 * numbers were already established at analysis time. Keeping this conversion in one
 * tested place is what stops a render from silently disagreeing with the analysis
 * about frame rate or colour.
 */
export function toMetadataFromRow(row: StoredMediaRow): MediaMetadata {
  const hasVideo = row.width > 0 && row.height > 0;
  const format = row.hdrFormat && HDR_FORMATS.includes(row.hdrFormat) ? (row.hdrFormat as HdrFormat) : null;

  return {
    container: row.container,
    formatName: row.container,
    duration: row.duration,
    size: row.size,
    bitrate: row.bitrate,
    video: hasVideo
      ? {
          index: 0,
          codec: row.videoCodec ?? 'unknown',
          profile: row.videoProfile,
          width: row.width,
          height: row.height,
          rotation: row.rotation,
          pixelFormat: row.pixelFormat,
          bitDepth: row.bitDepth,
          frameRate: row.frameRate > 0 ? row.frameRate : 30,
          avgFrameRate: row.avgFrameRate > 0 ? row.avgFrameRate : row.frameRate > 0 ? row.frameRate : 30,
          isVariableFrameRate: row.isVariableFrameRate,
          colorPrimaries: row.colorPrimaries,
          colorTransfer: row.colorTransfer,
          colorSpace: row.colorSpace,
          colorRange: row.colorRange,
          displayAspectRatio: row.displayAspectRatio,
          bitrate: row.bitrate,
          nbFrames: null,
        }
      : null,
    audio: row.audioCodec
      ? {
          index: 1,
          codec: row.audioCodec,
          channels: row.audioChannels ?? 2,
          sampleRate: row.audioSampleRate ?? 48000,
          bitrate: null,
          channelLayout: null,
        }
      : null,
    hdr: {
      // A row that claims HDR without a recognised format is treated as SDR, because
      // the alternative is tone-mapping or HDR-signalling on a guess.
      isHdr: row.isHdr && format !== null,
      format,
      masterDisplay: row.masterDisplay,
      maxCll: row.maxCll,
    },
    raw: null,
  };
}
