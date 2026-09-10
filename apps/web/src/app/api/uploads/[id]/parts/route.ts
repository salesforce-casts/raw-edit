import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { uploadSession } from '@rawedit/db';
import { URL_TTL, db, storage } from '@/lib/container';
import { jsonError, notFound, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

const PartsSchema = z.object({
  // Batched so a 500-part upload does not make 500 round trips, but bounded so one
  // request cannot ask us to sign the whole file's worth of URLs at once.
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
});

/**
 * POST /api/uploads/:id/parts — sign a batch of UploadPart URLs.
 *
 * Each URL is valid for five minutes and is scoped to exactly one bucket, key,
 * upload id and part number. Short lifetimes are safe because the client asks again
 * on demand, and signing never touches the file's bytes.
 */
export const POST = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;

  const parsed = PartsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return jsonError('Invalid part numbers.', 400, 'INVALID_REQUEST');
  }

  // Scoped by user id: a session belonging to someone else is simply not found.
  const rows = await db()
    .select()
    .from(uploadSession)
    .where(and(eq(uploadSession.id, id), eq(uploadSession.userId, user.id)))
    .limit(1);

  const session = rows[0];
  if (!session) return notFound('That upload');

  if (session.status === 'COMPLETED') {
    return jsonError('This upload has already finished.', 409, 'ALREADY_COMPLETE');
  }
  if (session.status === 'ABORTED' || session.status === 'EXPIRED') {
    return jsonError('This upload was cancelled. Please start it again.', 409, 'UPLOAD_GONE');
  }
  if (session.expiresAt.getTime() < Date.now()) {
    return jsonError('This upload expired. Please start it again.', 409, 'UPLOAD_EXPIRED');
  }

  const outOfRange = parsed.data.partNumbers.find((part) => part > session.totalParts);
  if (outOfRange !== undefined) {
    return jsonError(`Part ${outOfRange} is beyond this upload's ${session.totalParts} parts.`, 400, 'BAD_PART');
  }

  const urls = await storage().signUploadParts(
    session.storageKey,
    session.r2UploadId,
    parsed.data.partNumbers,
    URL_TTL.uploadPart,
  );

  // Touching the session keeps it out of the abandoned-upload sweep.
  await db()
    .update(uploadSession)
    .set({ status: 'IN_PROGRESS', lastActivityAt: new Date() })
    .where(eq(uploadSession.id, session.id));

  return NextResponse.json({ parts: urls });
});
