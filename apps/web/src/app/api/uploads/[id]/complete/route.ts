import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { idempotencyKey } from '@rawedit/queue';
import { recordUsage, setVideoStatus, upsertJob, uploadSession, video } from '@rawedit/db';
import { db, queue, storage } from '@/lib/container';
import { jsonError, notFound, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';
// Completing a large multipart upload can take R2 a little while to assemble.
export const maxDuration = 60;

const CompleteSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().min(1).max(200),
        size: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  /** Full-file SHA-256 the browser computed while uploading. */
  sha256: z.string().length(64).optional(),
});

/**
 * POST /api/uploads/:id/complete — finish the upload and start processing.
 *
 * The client's part list is treated as a hint. R2's `ListParts` is reconciled against
 * it and wins, so a confused or dishonest client cannot complete a partial object.
 */
export const POST = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;

  const body = await request.json().catch(() => ({}));
  const parsed = CompleteSchema.safeParse(body);
  if (!parsed.success) return jsonError('Invalid completion payload.', 400, 'INVALID_REQUEST');

  const database = db();
  const rows = await database
    .select()
    .from(uploadSession)
    .where(and(eq(uploadSession.id, id), eq(uploadSession.userId, user.id)))
    .limit(1);

  const session = rows[0];
  if (!session) return notFound('That upload');

  // Completing twice is not an error — a retried request should be harmless.
  if (session.status === 'COMPLETED') {
    return NextResponse.json({ ok: true, videoId: session.videoId, alreadyComplete: true });
  }
  if (session.status === 'ABORTED' || session.status === 'EXPIRED') {
    return jsonError('This upload was cancelled. Please start it again.', 409, 'UPLOAD_GONE');
  }

  // ---- reconcile with R2 ----------------------------------------------------
  const actualParts = await storage().listParts(session.storageKey, session.r2UploadId);
  if (actualParts.length === 0) {
    return jsonError('R2 has none of this upload. Please start it again.', 409, 'NO_PARTS');
  }
  if (actualParts.length !== session.totalParts) {
    return jsonError(
      `Only ${actualParts.length} of ${session.totalParts} parts have been uploaded.`,
      409,
      'INCOMPLETE_UPLOAD',
    );
  }

  const uploadedBytes = actualParts.reduce((sum, part) => sum + part.size, 0);
  if (uploadedBytes !== session.fileSize) {
    return jsonError(
      `The uploaded parts total ${uploadedBytes} bytes but the file is ${session.fileSize}.`,
      409,
      'SIZE_MISMATCH',
    );
  }

  await storage().completeMultipartUpload(session.storageKey, session.r2UploadId, actualParts);

  // ---- confirm the assembled object -----------------------------------------
  const head = await storage().headObject(session.storageKey);
  if (!head) {
    return jsonError('The upload completed but the object is missing.', 500, 'OBJECT_MISSING');
  }
  if (head.size !== session.fileSize) {
    return jsonError(
      `The stored object is ${head.size} bytes but the file is ${session.fileSize}.`,
      409,
      'SIZE_MISMATCH',
    );
  }

  const videoRows = await database.select().from(video).where(eq(video.id, session.videoId)).limit(1);
  const videoRow = videoRows[0];
  if (!videoRow) return notFound('That video');

  await database.transaction(async (tx) => {
    await tx
      .update(uploadSession)
      .set({
        status: 'COMPLETED',
        parts: actualParts,
        bytesUploaded: uploadedBytes,
        clientSha256: parsed.data.sha256 ?? null,
        lastActivityAt: new Date(),
      })
      .where(eq(uploadSession.id, session.id));

    await tx
      .update(video)
      .set({
        fileSize: head.size,
        // The worker recomputes this over the stored object and sets
        // checksumVerifiedAt, which is the actual end-to-end integrity check.
        checksumSha256: parsed.data.sha256 ?? null,
        updatedAt: new Date(),
      })
      .where(eq(video.id, session.videoId));
  });

  if (videoRow.status === 'UPLOADING') {
    await setVideoStatus(database, session.videoId, 'UPLOADED', {
      progress: 0,
      statusDetail: 'Queued for processing',
      errorMessage: null,
    });
  }

  await recordUsage(database, {
    userId: user.id,
    videoId: session.videoId,
    kind: 'STORAGE_BYTES',
    quantity: head.size,
    unit: 'bytes',
  });

  // ---- enqueue analysis ------------------------------------------------------
  // The key is derived from the stored bytes, so a replayed request or a
  // double-clicked button collapses to one job rather than two.
  const key = idempotencyKey('ANALYZE_VIDEO', session.videoId, parsed.data.sha256 ?? head.etag ?? head.size);
  const { job } = await upsertJob(database, {
    videoId: session.videoId,
    userId: user.id,
    type: 'ANALYZE_VIDEO',
    idempotencyKey: key,
    payload: { videoId: session.videoId, userId: user.id },
  });

  const enqueued = await queue().enqueue(
    'ANALYZE_VIDEO',
    { videoId: session.videoId, userId: user.id },
    { idempotencyKey: key, userId: user.id },
  );

  await database
    .update(video)
    .set({ statusDetail: 'Queued for processing' })
    .where(eq(video.id, session.videoId));

  return NextResponse.json({
    ok: true,
    videoId: session.videoId,
    jobId: job.id,
    queued: !enqueued.deduplicated,
    size: head.size,
  });
});
