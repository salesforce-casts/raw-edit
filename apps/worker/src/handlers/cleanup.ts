import { eq, inArray } from 'drizzle-orm';
import { findExpiredSources, findExpiredUploadSessions, uploadSession, video } from '@rawedit/db';
import { StorageKeys } from '@rawedit/core';
import { logger } from '../lib/logger.js';
import type { WorkerContext } from '../lib/context.js';

/**
 * CLEANUP_SOURCE: retention sweeps.
 *
 * Two jobs in one, both conservative by design:
 *
 *  - abort R2 multipart uploads that were abandoned (R2 bills for the parts of an
 *    incomplete upload until it is aborted), and
 *  - delete original files whose retention deadline has passed.
 *
 * A source is only ever deleted when the user's own rule set `deleteSourceAfter` and
 * that time is in the past. Nothing is deleted because a sweep felt like tidying up,
 * and exports are never touched — deleting the original does not take the finished
 * video with it.
 */
export async function handleCleanup(ctx: WorkerContext): Promise<{ sessions: number; sources: number }> {
  const sessions = await abortExpiredUploads(ctx);
  const sources = await deleteExpiredSources(ctx);
  return { sessions, sources };
}

async function abortExpiredUploads(ctx: WorkerContext): Promise<number> {
  const expired = await findExpiredUploadSessions(ctx.db, 100);
  if (expired.length === 0) return 0;

  for (const session of expired) {
    try {
      await ctx.storage.abortMultipartUpload(session.storageKey, session.r2UploadId);
    } catch (error: unknown) {
      // Already aborted or already completed; the row still needs closing out.
      logger.warn({ err: error, sessionId: session.id }, 'Could not abort multipart upload');
    }
  }

  await ctx.db
    .update(uploadSession)
    .set({ status: 'EXPIRED' })
    .where(
      inArray(
        uploadSession.id,
        expired.map((session) => session.id),
      ),
    );

  logger.info({ count: expired.length }, 'Expired upload sessions aborted');
  return expired.length;
}

async function deleteExpiredSources(ctx: WorkerContext): Promise<number> {
  const expired = await findExpiredSources(ctx.db, 50);
  if (expired.length === 0) return 0;

  let deleted = 0;
  for (const row of expired) {
    // Belt and braces: the query already filters on the deadline, but deleting an
    // original is irreversible, so the condition is checked again here.
    if (!row.deleteSourceAfter || row.deleteSourceAfter.getTime() > Date.now()) continue;
    if (row.sourceDeletedAt) continue;
    if (!StorageKeys.isOriginal(row.storageKey)) {
      logger.error({ videoId: row.id, key: row.storageKey }, 'Refusing to delete a non-original key');
      continue;
    }

    try {
      await ctx.storage.deleteObject(row.storageKey);
      await ctx.db
        .update(video)
        .set({ sourceDeletedAt: new Date() })
        .where(eq(video.id, row.id));
      deleted += 1;
      logger.info({ videoId: row.id, retention: row.sourceRetention }, 'Original deleted per retention policy');
    } catch (error: unknown) {
      logger.error({ err: error, videoId: row.id }, 'Could not delete expired source');
    }
  }

  return deleted;
}
