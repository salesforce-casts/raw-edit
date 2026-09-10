import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  checkUploadQuota,
  choosePartSize,
  guessContentType,
  isAcceptableVideo,
  newId,
  partCount,
  sanitizeFilename,
  StorageKeys,
} from '@rawedit/core';
import {
  getOrCreateUserSettings,
  getPlanTier,
  getUsageTotals,
  retentionDeadline,
  uploadSession,
  video,
  videoSource,
} from '@rawedit/db';
import { and, desc, eq } from 'drizzle-orm';
import { db, storage } from '@/lib/container';
import { jsonError, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

const CreateUploadSchema = z.object({
  filename: z.string().min(1).max(500),
  fileSize: z.number().int().positive(),
  mimeType: z.string().max(200).default(''),
  lastModified: z.number().int().nonnegative(),
  /** sha256(name:size:lastModified) — matches a re-picked file to a live session. */
  fingerprint: z.string().length(64),
  durationHint: z.number().positive().optional(),
});

/**
 * POST /api/uploads — begin a direct-to-R2 multipart upload.
 *
 * The response carries an upload id, a key and a part size. It never carries an R2
 * credential: the browser gets short-lived signed URLs from `/parts`, each scoped to
 * one PUT of one part of one object.
 */
export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const parsed = CreateUploadSchema.safeParse(await request.json());
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid request', 400, 'INVALID_REQUEST');
  }
  const input = parsed.data;

  if (!isAcceptableVideo(input.filename, input.mimeType)) {
    return jsonError(
      `"${input.filename}" does not look like a video file. Pick a .mov or .mp4 recording.`,
      400,
      'NOT_A_VIDEO',
    );
  }

  const database = db();
  const tier = await getPlanTier(database, user.id);
  const usage = await getUsageTotals(database, user.id);
  const quota = checkUploadQuota(tier, usage, {
    fileSizeBytes: input.fileSize,
    estimatedDurationSeconds: input.durationHint,
  });
  if (!quota.allowed) {
    return jsonError(quota.reason ?? 'This upload exceeds your plan.', 402, 'QUOTA_EXCEEDED');
  }

  // Resuming beats starting over: if this exact file already has a live session,
  // hand it back rather than orphaning the parts R2 is already holding.
  const existing = await findResumableSession(user.id, input.fingerprint);
  if (existing) {
    const parts = await storage().listParts(existing.storageKey, existing.r2UploadId);
    return NextResponse.json({
      resumed: true,
      videoId: existing.videoId,
      sessionId: existing.id,
      uploadId: existing.r2UploadId,
      key: existing.storageKey,
      partSize: existing.partSize,
      totalParts: existing.totalParts,
      uploadedParts: parts,
    });
  }

  const settings = await getOrCreateUserSettings(database, user.id);
  const videoId = newId('vid');
  const filename = sanitizeFilename(input.filename);
  const storageKey = StorageKeys.original(user.id, videoId, filename);
  const contentType = guessContentType(filename, input.mimeType);
  const partSize = choosePartSize(input.fileSize);
  const totalParts = partCount(input.fileSize, partSize);

  const created = await storage().createMultipartUpload(storageKey, contentType);

  const sessionId = newId('ups');
  await database.transaction(async (tx) => {
    await tx.insert(video).values({
      id: videoId,
      userId: user.id,
      title: filename.replace(/\.[^.]+$/, ''),
      originalFilename: filename,
      storageKey,
      storageBucket: storage().bucket,
      mimeType: contentType,
      fileSize: input.fileSize,
      status: 'UPLOADING',
      progress: 0,
      sourceRetention: settings.sourceRetention,
      deleteSourceAfter: retentionDeadline(settings.sourceRetention),
    });

    await tx.insert(videoSource).values({
      id: newId('src'),
      videoId,
      kind: 'DIRECT_UPLOAD',
      declaredSize: input.fileSize,
    });

    await tx.insert(uploadSession).values({
      id: sessionId,
      videoId,
      userId: user.id,
      storageKey,
      r2UploadId: created.uploadId,
      partSize,
      totalParts,
      fileSize: input.fileSize,
      fileFingerprint: input.fingerprint,
      status: 'PENDING',
      // R2 bills for the parts of an incomplete upload, so abandoned sessions are
      // swept after a day.
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  });

  return NextResponse.json({
    resumed: false,
    videoId,
    sessionId,
    uploadId: created.uploadId,
    key: storageKey,
    partSize,
    totalParts,
    uploadedParts: [],
  });
});

/**
 * A session is resumable when it belongs to this user, matches the file's
 * fingerprint, has not been completed or aborted, and has not expired.
 */
async function findResumableSession(userId: string, fingerprint: string) {
  const rows = await db()
    .select()
    .from(uploadSession)
    .where(
      and(
        eq(uploadSession.userId, userId),
        eq(uploadSession.fileFingerprint, fingerprint),
      ),
    )
    .orderBy(desc(uploadSession.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.status === 'COMPLETED' || row.status === 'ABORTED' || row.status === 'EXPIRED') return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}
