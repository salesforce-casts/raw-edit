import {
  MULTIPART_MAX_PART_BYTES,
  MULTIPART_MIN_PART_BYTES,
  MULTIPART_S3_MAX_PARTS,
  MULTIPART_TARGET_PARTS,
  MULTIPART_THRESHOLD_BYTES,
} from "./types";

export function multipartPartSizeBytes(fileSize: number): number {
  const raw = Math.ceil(fileSize / MULTIPART_TARGET_PARTS);
  const clamped = Math.min(MULTIPART_MAX_PART_BYTES, Math.max(MULTIPART_MIN_PART_BYTES, raw));
  const parts = Math.max(1, Math.ceil(fileSize / clamped));
  if (parts <= MULTIPART_S3_MAX_PARTS) return clamped;
  return Math.min(MULTIPART_MAX_PART_BYTES, Math.ceil(fileSize / MULTIPART_S3_MAX_PARTS));
}

export function shouldUseMultipart(fileSize: number, threshold = MULTIPART_THRESHOLD_BYTES): boolean {
  return fileSize >= threshold;
}

export function fileFingerprint(input: { name: string; size: number; lastModified: number }): string {
  return `${input.name}|${input.size}|${input.lastModified}`;
}

export function originalsKey(userId: string, videoId: string, filename: string): string {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : ".mov";
  return `users/${userId}/videos/${videoId}/originals/original${ext}`;
}

export function isOriginalsKey(key: string): boolean {
  return /\/originals\//.test(key);
}
