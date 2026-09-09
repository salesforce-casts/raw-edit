import type { HdrInfo, VideoStreamInfo } from '../types/media.js';

/**
 * Classify a source's dynamic range from ffprobe output.
 *
 * Getting this wrong is the single most common cause of a washed-out export, so the
 * rules are explicit and the "unknown" answer is SDR (which never tone-maps).
 */
export function classifyHdr(
  video: VideoStreamInfo | null,
  sideData: readonly Record<string, unknown>[] = [],
  tags: Record<string, string> = {},
): HdrInfo {
  if (!video) return { isHdr: false, format: null, masterDisplay: null, maxCll: null };

  const transfer = (video.colorTransfer ?? '').toLowerCase();
  const primaries = (video.colorPrimaries ?? '').toLowerCase();

  const hasDolbyVision = sideData.some((entry) => {
    const type = String(entry['side_data_type'] ?? '').toLowerCase();
    return type.includes('dovi') || type.includes('dolby vision');
  });

  const mastering = sideData.find(
    (entry) => String(entry['side_data_type'] ?? '').toLowerCase() === 'mastering display metadata',
  );
  const contentLight = sideData.find(
    (entry) => String(entry['side_data_type'] ?? '').toLowerCase() === 'content light level metadata',
  );
  const hasHdr10Plus = sideData.some((entry) =>
    String(entry['side_data_type'] ?? '').toLowerCase().includes('hdr dynamic metadata'),
  );

  const isPq = transfer === 'smpte2084';
  const isHlg = transfer === 'arib-std-b67' || transfer === 'hlg';
  const wideGamut = primaries === 'bt2020';

  let format: HdrInfo['format'] = null;
  if (hasDolbyVision) format = 'DOLBY_VISION';
  else if (isPq && hasHdr10Plus) format = 'HDR10_PLUS';
  else if (isPq) format = 'HDR10';
  else if (isHlg && wideGamut) format = 'HLG';
  // Apple tags HLG captures in the container as well as the stream.
  else if ((tags['com.apple.quicktime.camera.identifier'] ?? '') !== '' && isHlg) format = 'HLG';

  return {
    isHdr: format !== null,
    format,
    masterDisplay: mastering ? formatMasterDisplay(mastering) : null,
    maxCll: contentLight ? formatMaxCll(contentLight) : null,
  };
}

function parseRational(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length === 2) {
    const numerator = Number.parseFloat(parts[0]!);
    const denominator = Number.parseFloat(parts[1]!);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return numerator / denominator;
    }
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build the x265 `master-display` string. Chromaticity is expressed in units of
 * 0.00002 and luminance in units of 0.0001 cd/m², which is what x265 expects.
 */
function formatMasterDisplay(data: Record<string, unknown>): string | null {
  const chroma = (key: string): [number, number] | null => {
    const x = parseRational(data[`${key}_x`]);
    const y = parseRational(data[`${key}_y`]);
    if (x === null || y === null) return null;
    return [Math.round(x * 50000), Math.round(y * 50000)];
  };
  const green = chroma('green');
  const blue = chroma('blue');
  const red = chroma('red');
  const white = chroma('white_point');
  const minLuma = parseRational(data['min_luminance']);
  const maxLuma = parseRational(data['max_luminance']);
  if (!green || !blue || !red || !white || minLuma === null || maxLuma === null) return null;

  return (
    `G(${green[0]},${green[1]})B(${blue[0]},${blue[1]})R(${red[0]},${red[1]})` +
    `WP(${white[0]},${white[1]})L(${Math.round(maxLuma * 10000)},${Math.round(minLuma * 10000)})`
  );
}

function formatMaxCll(data: Record<string, unknown>): string | null {
  const maxContent = data['max_content'];
  const maxAverage = data['max_average'];
  if (typeof maxContent !== 'number' || typeof maxAverage !== 'number') return null;
  return `${maxContent},${maxAverage}`;
}

/** The filter chain that converts an HDR source to a correct BT.709 SDR image. */
export const HDR_TO_SDR_TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,' +
  'zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
