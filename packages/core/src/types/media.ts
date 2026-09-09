/**
 * Technical description of a media file, produced by ffprobe and stored on `video`.
 * All durations are seconds, all sizes are bytes.
 */

export type HdrFormat = 'HDR10' | 'HDR10_PLUS' | 'HLG' | 'DOLBY_VISION';

export interface VideoStreamInfo {
  index: number;
  codec: string;
  /** e.g. "High", "Main 10" */
  profile: string | null;
  width: number;
  height: number;
  /** Rotation in degrees from the display matrix: 0 | 90 | 180 | 270 */
  rotation: number;
  pixelFormat: string | null;
  bitDepth: number | null;
  /** r_frame_rate, the nominal rate */
  frameRate: number;
  /** avg_frame_rate over the whole file */
  avgFrameRate: number;
  /** True when r_frame_rate and avg_frame_rate disagree meaningfully. */
  isVariableFrameRate: boolean;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorSpace: string | null;
  colorRange: string | null;
  displayAspectRatio: string | null;
  bitrate: number | null;
  nbFrames: number | null;
}

export interface AudioStreamInfo {
  index: number;
  codec: string;
  channels: number;
  sampleRate: number;
  bitrate: number | null;
  channelLayout: string | null;
}

export interface HdrInfo {
  isHdr: boolean;
  format: HdrFormat | null;
  /** x265 `master-display` string, when the source carried mastering metadata. */
  masterDisplay: string | null;
  /** x265 `max-cll` string "maxCLL,maxFALL". */
  maxCll: string | null;
}

export interface MediaMetadata {
  container: string | null;
  formatName: string | null;
  duration: number;
  size: number | null;
  bitrate: number | null;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
  hdr: HdrInfo;
  /** Raw ffprobe JSON, retained verbatim for support and re-analysis. */
  raw: unknown;
}

/** Orientation-corrected display dimensions (portrait iPhone video is rotated). */
export function displayDimensions(video: VideoStreamInfo): { width: number; height: number } {
  const rotated = video.rotation === 90 || video.rotation === 270;
  return rotated
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height };
}
