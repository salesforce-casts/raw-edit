import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import {
  guessContentType,
  ImportError,
  PermanentError,
  PLAN_LIMITS,
  sanitizeFilename,
  StorageKeys,
  TransientError,
} from '@rawedit/core';
import { getPlanTier, recordUsage, setVideoStatus, video, videoSource } from '@rawedit/db';
import { resolveImporter } from '@rawedit/imports';
import { logger } from '../lib/logger.js';
import type { WorkerContext } from '../lib/context.js';
import type { JobTracker } from '../lib/job-tracker.js';

export interface ImportSourceInput {
  videoId: string;
  userId: string;
  sourceId: string;
}

/**
 * IMPORT_SOURCE: stream a file from a cloud provider straight into R2.
 *
 * The bytes never touch the worker's disk — they flow provider -> R2 through a
 * multipart upload, hashed on the way so the stored object can be verified exactly
 * like a browser upload.
 */
export async function handleImport(
  ctx: WorkerContext,
  tracker: JobTracker,
  input: ImportSourceInput,
): Promise<void> {
  const sourceRows = await ctx.db
    .select()
    .from(videoSource)
    .where(eq(videoSource.id, input.sourceId))
    .limit(1);
  const source = sourceRows[0];
  if (!source) throw new PermanentError('Import source record is missing', 'SOURCE_MISSING');
  if (!source.externalUrl) throw new PermanentError('Import source has no URL', 'SOURCE_MISSING');

  const tier = await getPlanTier(ctx.db, input.userId);
  const limits = PLAN_LIMITS[tier];

  await tracker.progress(2, { stage: 'Resolving link', status: 'UPLOADING' });

  try {
    const importer = resolveImporter(source.externalUrl, ctx.importers);
    const resolved = await importer.resolve(source.externalUrl);

    if (resolved.size !== null && resolved.size > limits.maxFileSizeBytes) {
      throw new PermanentError(
        `That file is ${(resolved.size / 1024 ** 3).toFixed(1)} GB, above your plan's limit.`,
        'TOO_LARGE',
      );
    }

    const filename = sanitizeFilename(resolved.filename);
    const storageKey = StorageKeys.original(input.userId, input.videoId, filename);
    const contentType = guessContentType(filename, resolved.mimeType ?? '');

    await ctx.db
      .update(videoSource)
      .set({
        externalId: resolved.externalId,
        declaredSize: resolved.size,
        metadata: { isOriginal: resolved.isOriginal, notes: resolved.notes, provider: importer.name } as never,
      })
      .where(eq(videoSource.id, input.sourceId));

    if (!resolved.isOriginal) {
      // Say so plainly rather than importing a compressed copy under a promise of
      // original quality.
      logger.warn(
        { videoId: input.videoId, provider: importer.name },
        'Provider serves a derivative rather than the original upload',
      );
    }

    await tracker.progress(5, { stage: `Importing from ${importer.name}`, status: 'UPLOADING' });

    const remote = await importer.open(source.externalUrl);
    const expected = remote.size ?? resolved.size;

    // Tee the stream: one copy goes to R2, the other through a SHA-256 digest, so
    // integrity is established without a second pass over the bytes.
    const hash = createHash('sha256');
    let bytesFetched = 0;
    const toStorage = new PassThrough();

    remote.stream.on('data', (chunk: Buffer) => {
      bytesFetched += chunk.length;
      hash.update(chunk);
    });

    const pump = pipeline(remote.stream, toStorage);
    const upload = ctx.storage.uploadStream(storageKey, toStorage, contentType, (bytes) => {
      if (!expected || expected <= 0) return;
      const fraction = Math.min(1, bytes / expected);
      void tracker.progress(5 + Math.round(fraction * 90), {
        stage: `Importing from ${importer.name}`,
        status: 'UPLOADING',
      });
    });

    const [, uploaded] = await Promise.all([pump, upload]);

    if (expected && expected > 0 && Math.abs(uploaded.size - expected) > 1024) {
      throw new TransientError(
        `Import finished with ${uploaded.size} bytes but the provider declared ${expected}.`,
      );
    }

    await ctx.db
      .update(video)
      .set({
        originalFilename: filename,
        storageKey,
        mimeType: contentType,
        fileSize: uploaded.size,
        checksumSha256: hash.digest('hex'),
        updatedAt: new Date(),
      })
      .where(eq(video.id, input.videoId));

    await ctx.db
      .update(videoSource)
      .set({ bytesFetched, completedAt: new Date(), importError: null })
      .where(eq(videoSource.id, input.sourceId));

    await recordUsage(ctx.db, {
      userId: input.userId,
      videoId: input.videoId,
      kind: 'STORAGE_BYTES',
      quantity: uploaded.size,
      unit: 'bytes',
    });

    await setVideoStatus(ctx.db, input.videoId, 'UPLOADED', {
      progress: 100,
      statusDetail: null,
      errorMessage: null,
    });
    await tracker.progress(100, { stage: 'Imported', status: 'UPLOADED' });

    logger.info(
      { videoId: input.videoId, provider: importer.name, bytes: uploaded.size },
      'Cloud import complete',
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.db
      .update(videoSource)
      .set({ importError: message.slice(0, 1000) })
      .where(eq(videoSource.id, input.sourceId));

    // An ImportError already knows whether retrying could help.
    if (error instanceof ImportError) {
      throw error.retryable ? new TransientError(message) : new PermanentError(message, error.code);
    }
    throw error;
  }
}
