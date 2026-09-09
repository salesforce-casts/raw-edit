import { createHash } from 'node:crypto';
import type { JobType } from '@rawedit/core';

/**
 * A job's identity is (video, type, input version).
 *
 * Analysis is versioned by the source checksum, so re-uploading identical bytes will
 * not re-analyse; a render is versioned by the EDL version and preset, so approving
 * the same edit twice is free but changing one cut queues real work.
 */
export function idempotencyKey(type: JobType, videoId: string, inputVersion: string | number): string {
  const digest = createHash('sha256')
    .update(`${type}|${videoId}|${inputVersion}`)
    .digest('hex')
    .slice(0, 32);
  return `${type.toLowerCase()}:${videoId}:${digest}`;
}
