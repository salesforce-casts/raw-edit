import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  checkUploadQuota,
  ImportError,
  newId,
  PLAN_LIMITS,
  sanitizeFilename,
  StorageKeys,
} from '@rawedit/core';
import { idempotencyKey } from '@rawedit/queue';
import {
  getOrCreateUserSettings,
  getPlanTier,
  getUsageTotals,
  retentionDeadline,
  upsertJob,
  video,
  videoSource,
} from '@rawedit/db';
import { resolveImporter } from '@rawedit/imports';
import { db, importers, queue, storage } from '@/lib/container';
import { jsonError, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';
// Resolving a link means a metadata round trip to the provider.
export const maxDuration = 60;

const ImportSchema = z.object({
  url: z.string().url().max(2000),
  /** Resolve only, so the UI can confirm the filename and size before committing. */
  dryRun: z.boolean().default(false),
});

/**
 * POST /api/imports — import a video from a cloud link.
 *
 * The link is resolved here (fast, so the user gets an immediate answer about whether
 * it will work) and the bytes are fetched by the worker (slow, and must not hold a
 * serverless request open). The file goes provider -> R2 without touching Next.js.
 */
export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const parsed = ImportSchema.safeParse(await request.json());
  if (!parsed.success) {
    return jsonError('That is not a valid link.', 400, 'INVALID_REQUEST');
  }

  const database = db();
  const tier = await getPlanTier(database, user.id);
  if (!PLAN_LIMITS[tier].features.cloudImport) {
    return jsonError('Cloud import is available on the Creator and Pro plans.', 402, 'UPGRADE_REQUIRED');
  }

  let importer;
  let resolved;
  try {
    importer = resolveImporter(parsed.data.url, importers());
    resolved = await importer.resolve(parsed.data.url);
  } catch (error: unknown) {
    if (error instanceof ImportError) {
      const status = error.code === 'NOT_CONFIGURED' ? 503 : error.code === 'FORBIDDEN' ? 403 : 400;
      return jsonError(error.message, status, error.code);
    }
    throw error;
  }

  const usage = await getUsageTotals(database, user.id);
  const quota = checkUploadQuota(tier, usage, { fileSizeBytes: resolved.size ?? 0 });
  if (!quota.allowed) {
    return jsonError(quota.reason ?? 'This import exceeds your plan.', 402, 'QUOTA_EXCEEDED');
  }

  if (parsed.data.dryRun) {
    return NextResponse.json({
      provider: importer.name,
      filename: resolved.filename,
      size: resolved.size,
      mimeType: resolved.mimeType,
      isOriginal: resolved.isOriginal,
      notes: resolved.notes,
    });
  }

  const settings = await getOrCreateUserSettings(database, user.id);
  const videoId = newId('vid');
  const sourceId = newId('src');
  const filename = sanitizeFilename(resolved.filename);

  await database.transaction(async (tx) => {
    await tx.insert(video).values({
      id: videoId,
      userId: user.id,
      title: filename.replace(/\.[^.]+$/, ''),
      originalFilename: filename,
      // The worker rewrites this once it knows the real size; the key is stable.
      storageKey: StorageKeys.original(user.id, videoId, filename),
      storageBucket: storage().bucket,
      mimeType: resolved.mimeType ?? 'video/mp4',
      fileSize: resolved.size ?? 0,
      status: 'UPLOADING',
      statusDetail: `Importing from ${importer.name}`,
      sourceRetention: settings.sourceRetention,
      deleteSourceAfter: retentionDeadline(settings.sourceRetention),
    });

    await tx.insert(videoSource).values({
      id: sourceId,
      videoId,
      kind: importer.kind,
      externalId: resolved.externalId,
      externalUrl: parsed.data.url,
      declaredSize: resolved.size,
      metadata: { isOriginal: resolved.isOriginal, notes: resolved.notes } as never,
    });
  });

  const key = idempotencyKey('IMPORT_SOURCE', videoId, sourceId);
  await upsertJob(database, {
    videoId,
    userId: user.id,
    type: 'IMPORT_SOURCE',
    idempotencyKey: key,
    payload: { videoId, userId: user.id, sourceId },
  });
  await queue().enqueue(
    'IMPORT_SOURCE',
    { videoId, userId: user.id, sourceId },
    { idempotencyKey: key, userId: user.id },
  );

  return NextResponse.json({
    videoId,
    provider: importer.name,
    filename,
    size: resolved.size,
    isOriginal: resolved.isOriginal,
    notes: resolved.notes,
  });
});
