import type { MediaMetadata } from '../types/media.js';
import { displayDimensions } from '../types/media.js';
import type { TimeRange } from '../types/edl.js';
import { HDR_TO_SDR_TONEMAP } from '../analysis/hdr.js';
import { getPreset, planExport, type ExportPlanSummary } from './presets.js';
import type { ExportPresetId } from '../types/status.js';
import type { RenderPlan } from './plan.js';

export type FilterStrategy = 'filter_select' | 'filter_concat' | 'passthrough';

export interface BuildRenderCommandInput {
  /** Signed URL or local path of the ORIGINAL master. Never a proxy. */
  inputUrl: string;
  outputPath: string;
  metadata: MediaMetadata;
  plan: RenderPlan;
  presetId: ExportPresetId;
  /** Above this, `filter_concat` buffers too much; see docs/06. */
  maxConcatSegments?: number;
  /** Extra `-threads`; 0 lets ffmpeg decide. */
  threads?: number;
}

export interface RenderCommand {
  args: string[];
  strategy: FilterStrategy;
  plan: ExportPlanSummary;
  warnings: string[];
  /** Denominator for progress: expected output seconds. */
  expectedDuration: number;
}

/**
 * `filter_concat` is the default because it is the only strategy that keeps audio and
 * video locked together: `atrim` cuts on sample boundaries while `aselect` can only
 * drop whole ~21 ms audio frames, so `filter_select` accumulates drift with every cut
 * (measured at 819 ms over 30 segments) and adds a frame per segment.
 *
 * The concern that split/trim/concat would buffer does not hold for ranges in
 * increasing order — each branch discards everything outside its own window, so
 * nothing queues. Measured at 200 segments: 93 MB peak RSS, no drift, exact duration.
 */
const DEFAULT_MAX_CONCAT_SEGMENTS = 400;

/**
 * Keep a long pull from object storage alive across a dropped connection.
 *
 * These belong to ffmpeg's HTTP protocol handler, so they must only be passed for an
 * http(s) input — ffmpeg rejects the whole invocation with "Option reconnect not
 * found" when the input is a local path.
 */
export function reconnectArgs(inputUrl: string): string[] {
  if (!/^https?:\/\//i.test(inputUrl)) return [];
  return ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10'];
}

/**
 * Build the single ffmpeg invocation that produces the finished video from the
 * original master. One decode, one encode, no intermediates.
 */
export function buildRenderCommand(input: BuildRenderCommandInput): RenderCommand {
  const { inputUrl, outputPath, metadata, plan, presetId } = input;
  const preset = getPreset(presetId);
  const exportPlan = planExport(metadata, presetId, plan.outputDuration);
  const warnings = [...exportPlan.warnings];
  const maxConcat = input.maxConcatSegments ?? DEFAULT_MAX_CONCAT_SEGMENTS;

  const source = metadata.video;
  const isVfr = source?.isVariableFrameRate ?? false;
  const ranges = plan.keepRanges;

  let strategy: FilterStrategy;
  let forceCfr = false;
  if (ranges.length <= 1 && plan.isPassthrough) {
    strategy = 'passthrough';
  } else if (ranges.length <= maxConcat) {
    // Sample-accurate audio, frame-accurate video, exact output duration.
    strategy = 'filter_concat';
  } else {
    // Beyond the cap the filter graph gets unwieldy. `select` still produces a good
    // edit, but its audio cuts land on ~21 ms frame boundaries, so say so rather than
    // shipping a subtly out-of-sync file without telling anyone.
    strategy = 'filter_select';
    forceCfr = true;
    warnings.push(
      `${ranges.length} segments exceeds the ${maxConcat}-segment limit for frame-exact rendering; ` +
        'audio cuts are aligned to the nearest audio frame and the output is normalised to a constant frame rate.',
    );
  }
  if (isVfr && strategy === 'filter_select') {
    warnings.push(`Variable frame rate source normalised to a constant ${exportPlan.frameRate} fps.`);
  }

  const videoFilters: string[] = [];
  const audioFilters: string[] = [];

  if (exportPlan.toneMapped) videoFilters.push(HDR_TO_SDR_TONEMAP);
  if (exportPlan.scaled) {
    videoFilters.push(
      `scale=${exportPlan.width}:${exportPlan.height}:flags=lanczos:force_original_aspect_ratio=decrease`,
    );
  }

  const args: string[] = ['-hide_banner', '-nostdin', '-y'];
  if (input.threads !== undefined) args.push('-threads', String(input.threads));
  args.push(...reconnectArgs(inputUrl));
  args.push('-i', inputUrl);

  let mapArgs: string[] = ['-map', '0:v:0', '-map', '0:a:0?'];

  if (strategy === 'filter_select') {
    const selectExpr = buildSelectExpression(ranges);
    const videoChain = [
      `select='${selectExpr}'`,
      ...videoFilters,
      'setpts=N/FRAME_RATE/TB',
    ].join(',');
    const audioChain = [`aselect='${selectExpr}'`, ...audioFilters, 'asetpts=N/SR/TB'].join(',');
    args.push('-vf', videoChain);
    if (metadata.audio) args.push('-af', audioChain);
  } else if (strategy === 'filter_concat') {
    const graph = buildConcatFilterGraph(ranges, videoFilters, Boolean(metadata.audio));
    args.push('-filter_complex', graph);
    mapArgs = metadata.audio ? ['-map', '[outv]', '-map', '[outa]'] : ['-map', '[outv]'];
  } else {
    if (videoFilters.length > 0) args.push('-vf', videoFilters.join(','));
  }

  args.push(...mapArgs);

  if (forceCfr) {
    args.push('-fps_mode', 'cfr', '-r', String(exportPlan.frameRate));
  } else if (strategy === 'filter_select') {
    // `select` drops frames; without this ffmpeg may re-derive an odd frame rate.
    args.push('-fps_mode', 'cfr', '-r', String(exportPlan.frameRate));
  }

  args.push(...videoEncoderArgs(exportPlan, metadata, preset.crf, preset.crfHevc, preset.preset));
  args.push(...audioEncoderArgs(metadata, preset.audioBitrateKbps));
  args.push(...colorArgs(exportPlan, metadata));

  // Carry container-level metadata (creation date, camera make/model, rotation).
  args.push('-map_metadata', '0', '-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats');
  args.push(outputPath);

  return { args, strategy, plan: exportPlan, warnings, expectedDuration: plan.outputDuration };
}

/** `between(t,a,b)+between(t,c,d)` — the ffmpeg `select` expression for kept ranges. */
export function buildSelectExpression(ranges: readonly TimeRange[]): string {
  if (ranges.length === 0) return '0';
  return ranges
    .map((range) => `between(t,${range.start.toFixed(6)},${range.end.toFixed(6)})`)
    .join('+');
}

/**
 * split -> trim -> concat. Correct for VFR because `concat` restamps each segment,
 * at the cost of buffering in the split branches — hence the segment cap.
 */
export function buildConcatFilterGraph(
  ranges: readonly TimeRange[],
  videoFilters: readonly string[],
  hasAudio: boolean,
): string {
  const n = ranges.length;
  const parts: string[] = [];

  const videoPrefix = videoFilters.length > 0 ? `${videoFilters.join(',')},` : '';
  parts.push(`[0:v]split=${n}${ranges.map((_, i) => `[vin${i}]`).join('')}`);
  if (hasAudio) parts.push(`[0:a]asplit=${n}${ranges.map((_, i) => `[ain${i}]`).join('')}`);

  ranges.forEach((range, i) => {
    parts.push(
      `[vin${i}]trim=start=${range.start.toFixed(6)}:end=${range.end.toFixed(6)},${videoPrefix}setpts=PTS-STARTPTS[v${i}]`,
    );
    if (hasAudio) {
      parts.push(
        `[ain${i}]atrim=start=${range.start.toFixed(6)}:end=${range.end.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`,
      );
    }
  });

  const concatInputs = ranges
    .map((_, i) => (hasAudio ? `[v${i}][a${i}]` : `[v${i}]`))
    .join('');
  parts.push(
    `${concatInputs}concat=n=${n}:v=1:a=${hasAudio ? 1 : 0}${hasAudio ? '[outv][outa]' : '[outv]'}`,
  );

  return parts.join(';');
}

function videoEncoderArgs(
  plan: ExportPlanSummary,
  metadata: MediaMetadata,
  crfH264: number,
  crfHevc: number,
  presetName: string,
): string[] {
  if (plan.videoCodec === 'hevc') {
    const tenBit = (metadata.video?.bitDepth ?? 8) >= 10 || metadata.hdr.isHdr;
    const args = [
      '-c:v',
      'libx265',
      '-crf',
      String(crfHevc),
      '-preset',
      presetName,
      '-pix_fmt',
      tenBit ? 'yuv420p10le' : 'yuv420p',
      // Without this an HEVC MP4 will not play in QuickTime or Safari.
      '-tag:v',
      'hvc1',
    ];
    const x265Params = buildX265Params(plan, metadata);
    if (x265Params) args.push('-x265-params', x265Params);
    return args;
  }

  return [
    '-c:v',
    'libx264',
    '-crf',
    String(crfH264),
    '-preset',
    presetName,
    '-profile:v',
    'high',
    '-level',
    '5.1',
    '-pix_fmt',
    'yuv420p',
  ];
}

/** HDR signalling for libx265. Omitting any of this is what produces washed-out output. */
export function buildX265Params(plan: ExportPlanSummary, metadata: MediaMetadata): string | null {
  if (!metadata.hdr.isHdr || plan.strategy !== 'PRESERVE_SOURCE') return null;
  const video = metadata.video;
  const params = [
    'hdr-opt=1',
    'repeat-headers=1',
    `colorprim=${video?.colorPrimaries ?? 'bt2020'}`,
    `transfer=${video?.colorTransfer ?? 'smpte2084'}`,
    `colormatrix=${video?.colorSpace ?? 'bt2020nc'}`,
  ];
  if (metadata.hdr.masterDisplay) params.push(`master-display=${metadata.hdr.masterDisplay}`);
  if (metadata.hdr.maxCll) params.push(`max-cll=${metadata.hdr.maxCll}`);
  return params.join(':');
}

function audioEncoderArgs(metadata: MediaMetadata, bitrateKbps: number): string[] {
  if (!metadata.audio) return ['-an'];
  const channels = metadata.audio.channels > 2 ? 2 : metadata.audio.channels;
  const bitrate = channels >= 2 ? bitrateKbps : Math.round(bitrateKbps * 0.7);
  return [
    '-c:a',
    'aac',
    '-b:a',
    `${bitrate}k`,
    '-ar',
    String(metadata.audio.sampleRate || 48000),
    '-ac',
    String(Math.max(1, channels)),
  ];
}

/**
 * Colour tags are written explicitly on every path. For an SDR source these copy the
 * source values; for a tone-mapped export they declare BT.709, which is what the
 * filter chain actually produced.
 */
function colorArgs(plan: ExportPlanSummary, metadata: MediaMetadata): string[] {
  if (plan.toneMapped) {
    return [
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-colorspace', 'bt709',
      '-color_range', 'tv',
    ];
  }
  const video = metadata.video;
  const args: string[] = [];
  if (video?.colorPrimaries) args.push('-color_primaries', video.colorPrimaries);
  if (video?.colorTransfer) args.push('-color_trc', video.colorTransfer);
  if (video?.colorSpace) args.push('-colorspace', video.colorSpace);
  if (video?.colorRange) args.push('-color_range', video.colorRange);
  return args;
}

/** ffmpeg args for the 720p preview proxy. Never used as a render source. */
export function buildProxyCommand(inputUrl: string, outputPath: string, metadata: MediaMetadata): string[] {
  const display = metadata.video ? displayDimensions(metadata.video) : { width: 1080, height: 1920 };
  const longEdge = Math.max(display.width, display.height);
  const scaleFilter =
    longEdge > 1280
      ? `scale=${display.width >= display.height ? '1280:-2' : '-2:1280'}:flags=bilinear`
      : null;

  const filters: string[] = [];
  if (metadata.hdr.isHdr) filters.push(HDR_TO_SDR_TONEMAP);
  if (scaleFilter) filters.push(scaleFilter);
  filters.push('format=yuv420p');

  return [
    '-hide_banner', '-nostdin', '-y',
    ...reconnectArgs(inputUrl),
    '-i', inputUrl,
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outputPath,
  ];
}

/** ffmpeg args for the 16 kHz mono PCM the transcriber consumes. */
export function buildAudioExtractCommand(inputUrl: string, outputPath: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    ...reconnectArgs(inputUrl),
    '-i', inputUrl,
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le',
    '-progress', 'pipe:1', '-nostats',
    outputPath,
  ];
}

export function buildSilenceDetectCommand(audioPath: string, noiseDb = -32, minDuration = 0.25): string[] {
  return [
    '-hide_banner', '-nostdin',
    '-i', audioPath,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
    '-f', 'null', '-',
  ];
}

export function buildThumbnailCommand(inputUrl: string, outputPath: string, atSeconds: number): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    ...reconnectArgs(inputUrl),
    '-ss', atSeconds.toFixed(3),
    '-i', inputUrl,
    '-frames:v', '1',
    '-vf', 'scale=640:-2:flags=bilinear',
    '-q:v', '4',
    outputPath,
  ];
}
