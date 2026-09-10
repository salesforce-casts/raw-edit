import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { idempotencyKey } from '@rawedit/queue';
import { processingJob, requireVideoForUser, setVideoStatus, upsertJob } from '@rawedit/db';
import { db, queue } from '@/lib/container';
import { jsonError, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

/**
 * POST /api/videos/:id/retry — re-queue a failed video.
 *
 * A dead-lettered job keeps its row and its error, so retrying is a state change
 * rather than a rebuild: the video record, its storage key and any previous analysis
 * are all still there. This is what makes "never force users to regenerate a video
 * because they refreshed" true even after a failure.
 */
export const POST = route(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const database = db();

  const row = await requireVideoForUser(database, id, user.id);
  if (row.status !== 'FAILED') {
    return jsonError('This video has not failed, so there is nothing to retry.', 409, 'NOT_FAILED');
  }
  if (row.sourceDeletedAt) {
    return jsonError('The original file was deleted, so this cannot be retried.', 409, 'SOURCE_DELETED');
  }

  // Re-analysis is the right recovery for everything before READY_FOR_REVIEW; a
  // failed render is retried by approving the edit again from the review screen.
  const key = idempotencyKey('ANALYZE_VIDEO', id, `retry:${Date.now()}`);

  await database
    .update(processingJob)
    .set({ status: 'CANCELLED' })
    .where(
      and(
        eq(processingJob.videoId, id),
        eq(processingJob.type, 'ANALYZE_VIDEO'),
        eq(processingJob.status, 'DEAD'),
      ),
    );

  await upsertJob(database, {
    videoId: id,
    userId: user.id,
    type: 'ANALYZE_VIDEO',
    idempotencyKey: key,
    payload: { videoId: id, userId: user.id },
  });

  await setVideoStatus(database, id, 'UPLOADED', {
    progress: 0,
    statusDetail: 'Queued for processing',
    errorMessage: null,
  });

  await queue().enqueue(
    'ANALYZE_VIDEO',
    { videoId: id, userId: user.id },
    { idempotencyKey: key, userId: user.id },
  );

  return NextResponse.json({ ok: true, status: 'UPLOADED' });
});
