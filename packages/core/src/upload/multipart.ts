/** Multipart upload sizing and progress maths. Shared by the browser and the server. */

export const MIN_PART_SIZE = 8 * 1024 * 1024; // 8 MiB — above S3's 5 MiB floor
export const MAX_PART_SIZE = 512 * 1024 * 1024;
export const MAX_PARTS = 10_000;
/** Target part count, leaving headroom under the hard cap. */
const TARGET_PARTS = 9_000;

/**
 * Choose a part size for a given file.
 *
 * Small parts keep a retry cheap on a flaky cellular connection; the 9 000-part target
 * keeps us under S3/R2's 10 000-part limit for files up to ~4.5 TB.
 */
export function choosePartSize(fileSize: number): number {
  if (fileSize <= 0) return MIN_PART_SIZE;
  const needed = Math.ceil(fileSize / TARGET_PARTS);
  const rounded = Math.ceil(needed / (1024 * 1024)) * 1024 * 1024;
  return Math.min(MAX_PART_SIZE, Math.max(MIN_PART_SIZE, rounded));
}

export function partCount(fileSize: number, partSize: number): number {
  if (fileSize <= 0 || partSize <= 0) return 0;
  return Math.ceil(fileSize / partSize);
}

export function partRange(partNumber: number, partSize: number, fileSize: number): { start: number; end: number } {
  const start = (partNumber - 1) * partSize;
  return { start, end: Math.min(start + partSize, fileSize) };
}

export interface UploadProgressSample {
  bytes: number;
  at: number;
}

/**
 * Rolling upload speed and ETA.
 *
 * A plain average is useless on mobile, where the connection changes; this keeps a
 * short window so the number the creator sees reflects the last few seconds.
 */
export class UploadRateTracker {
  private readonly samples: UploadProgressSample[] = [];

  constructor(private readonly windowMs = 8000) {}

  push(bytes: number, at = Date.now()): void {
    this.samples.push({ bytes, at });
    const cutoff = at - this.windowMs;
    while (this.samples.length > 2 && this.samples[0]!.at < cutoff) this.samples.shift();
  }

  /** Bytes per second over the window, or null until there is enough data. */
  bytesPerSecond(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const elapsed = (last.at - first.at) / 1000;
    if (elapsed <= 0.2) return null;
    const delta = last.bytes - first.bytes;
    if (delta <= 0) return 0;
    return delta / elapsed;
  }

  /** Seconds remaining, or null when the rate is not yet known. */
  etaSeconds(uploadedBytes: number, totalBytes: number): number | null {
    const rate = this.bytesPerSecond();
    if (rate === null || rate <= 0) return null;
    const remaining = Math.max(0, totalBytes - uploadedBytes);
    return remaining / rate;
  }

  reset(): void {
    this.samples.length = 0;
  }
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  const mbps = bytesPerSecond / (1024 * 1024);
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${secs}s left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

/** Filenames that survive an S3 key, a Content-Disposition header and a Mac download. */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'video';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 180);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'video' : cleaned;
}

const VIDEO_EXTENSIONS = new Set([
  'mov', 'mp4', 'm4v', 'hevc', 'h265', 'avi', 'mkv', 'webm', 'mpg', 'mpeg', 'm2ts', 'mts', '3gp',
]);

/**
 * iOS often reports an empty or generic MIME type for a Photos asset, so the
 * extension is checked as well. Rejecting a real iPhone video would be worse than
 * letting ffprobe make the final call in the worker.
 */
export function isAcceptableVideo(filename: string, mimeType: string): boolean {
  if (mimeType.startsWith('video/')) return true;
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.has(extension);
}

export function guessContentType(filename: string, provided: string): string {
  if (provided.startsWith('video/')) return provided;
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (extension) {
    case 'mov':
      return 'video/quicktime';
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
    case 'avi':
      return 'video/x-msvideo';
    default:
      return 'application/octet-stream';
  }
}
