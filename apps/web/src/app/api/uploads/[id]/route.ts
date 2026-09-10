import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { uploadSession, video } from '@rawedit/db';
import { db, storage } from '@/lib/container';
import { notFound, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

/**
 * GET /api/uploads/:id — resume information.
 *
 * The answer comes from R2's own `ListParts`, not from the client's memory or from
 * our mirror of it. That is what makes resume correct after a Safari refresh, a
 * network switch, or a client that has simply lost track.
 */
export const GET = route(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;

  const rows = await db()
    .select()
    .from(uploadSession)
    .where(and(eq(uploadSession.id, id), eq(uploadSession.userId, user.id)))
    .limit(1);

  const session = rows[0];
  if (!session) return notFound('That upload');

  if (session.status === 'COMPLETED') {
    return NextResponse.json({
      status: 'COMPLETED',
      videoId: session.videoId,
      uploadedParts: [],
      bytesUploaded: session.fileSize,
      totalParts: session.totalParts,
      partSize: session.partSize,
    });
  }

  const parts = await storage().listParts(session.storageKey, session.r2UploadId);
  const bytesUploaded = parts.reduce((sum, part) => sum + part.size, 0);

  // Keep our mirror roughly in step; R2 stays the authority.
  await db()
    .update(uploadSession)
    .set({ parts, bytesUploaded, lastActivityAt: new Date() })
    .where(eq(uploadSession.id, session.id));

  return NextResponse.json({
    status: session.status,
    videoId: session.videoId,
    uploadId: session.r2UploadId,
    key: session.storageKey,
    partSize: session.partSize,
    totalParts: session.totalParts,
    fileSize: session.fileSize,
    fingerprint: session.fileFingerprint,
    uploadedParts: parts,
    bytesUploaded,
    expiresAt: session.expiresAt,
  });
});

/**
 * DELETE /api/uploads/:id — abort.
 *
 * Aborting matters for more than tidiness: R2 charges for the parts of an incomplete
 * multipart upload until it is explicitly aborted.
 */
export const DELETE = route(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;

  const rows = await db()
    .select()
    .from(uploadSession)
    .where(and(eq(uploadSession.id, id), eq(uploadSession.userId, user.id)))
    .limit(1);

  const session = rows[0];
  if (!session) return notFound('That upload');

  if (session.status !== 'COMPLETED') {
    await storage()
      .abortMultipartUpload(session.storageKey, session.r2UploadId)
      .catch(() => undefined);
  }

  await db().transaction(async (tx) => {
    await tx.update(uploadSession).set({ status: 'ABORTED' }).where(eq(uploadSession.id, session.id));
    // The video record only ever existed to hold this upload.
    await tx.delete(video).where(and(eq(video.id, session.videoId), eq(video.status, 'UPLOADING')));
  });

  return NextResponse.json({ ok: true });
});
