/**
 * Job bookkeeping against a real Postgres.
 *
 * These cover two defects found by running the full stack, both of which are silent
 * in normal use and only show up on the second render of a video or on a worker that
 * dies mid-job:
 *
 *  - claiming by (video, type) found the oldest job of that type, so a re-render was
 *    matched against an already-succeeded row and never ran; and
 *  - the stale-job sweeper interpolated a Date into raw SQL, which postgres.js
 *    rejects, so every sweep threw instead of reclaiming anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newId } from '@rawedit/core';
import { processingJob, user, video } from '@rawedit/db';
import { hasBinary } from './fixtures.js';

const enabled = Boolean(process.env['DATABASE_URL'] && process.env['REDIS_URL'] && process.env['R2_BUCKET']);
const describeIf = enabled ? describe : describe.skip;
void hasBinary;

describeIf('job tracking', () => {
  let ctx: Awaited<ReturnType<typeof import('../src/lib/context.js').createContext>>;
  let userId = '';
  let videoId = '';

  beforeAll(async () => {
    const { createContext } = await import('../src/lib/context.js');
    ctx = await createContext();

    userId = newId('usr');
    videoId = newId('vid');
    await ctx.db.insert(user).values({
      id: userId,
      name: 'Job Test',
      email: `jobs-${Date.now()}@rawedit.test`,
      emailVerified: true,
    });
    await ctx.db.insert(video).values({
      id: videoId,
      userId,
      originalFilename: 'a.mp4',
      storageKey: `originals/${userId}/${videoId}/a.mp4`,
      storageBucket: 'test',
      mimeType: 'video/mp4',
      fileSize: 1000,
      status: 'READY_FOR_REVIEW',
      duration: 10,
    });
  }, 60_000);

  afterAll(async () => {
    if (ctx && userId) await ctx.db.delete(user).where(eq(user.id, userId)).catch(() => undefined);
    if (ctx) await ctx.close();
  });

  async function insertJob(key: string, status: 'QUEUED' | 'SUCCEEDED' | 'RUNNING', patch: Record<string, unknown> = {}) {
    const id = newId('job');
    await ctx.db.insert(processingJob).values({
      id,
      videoId,
      userId,
      type: 'RENDER_VIDEO',
      status,
      idempotencyKey: key,
      payload: { videoId, userId },
      ...patch,
    });
    return id;
  }

  it('claims the job its idempotency key names, not the oldest of that type', async () => {
    const { JobTracker } = await import('../src/lib/job-tracker.js');

    // The shape that broke: an older render that already succeeded, and a new one
    // queued after an edit.
    const oldKey = `render:${videoId}:v1`;
    const newKey = `render:${videoId}:v2`;
    await insertJob(oldKey, 'SUCCEEDED', { finishedAt: new Date(), progress: 100 });
    const newRowId = await insertJob(newKey, 'QUEUED');

    const tracker = await JobTracker.claim(ctx, {
      videoId,
      type: 'RENDER_VIDEO',
      attempt: 1,
      idempotencyKey: newKey,
    });

    expect(tracker).not.toBeNull();
    expect(tracker!.rowId).toBe(newRowId);
    tracker!.stopHeartbeat();

    const [claimed] = await ctx.db.select().from(processingJob).where(eq(processingJob.id, newRowId));
    expect(claimed!.status).toBe('RUNNING');

    await ctx.db.delete(processingJob).where(eq(processingJob.videoId, videoId));
  }, 60_000);

  it('refuses to re-run a job that already succeeded', async () => {
    const { JobTracker } = await import('../src/lib/job-tracker.js');
    const key = `render:${videoId}:done`;
    await insertJob(key, 'SUCCEEDED', { finishedAt: new Date(), progress: 100 });

    const tracker = await JobTracker.claim(ctx, {
      videoId,
      type: 'RENDER_VIDEO',
      attempt: 1,
      idempotencyKey: key,
    });
    expect(tracker).toBeNull();

    await ctx.db.delete(processingJob).where(eq(processingJob.videoId, videoId));
  }, 60_000);

  it('will not steal a job another worker is actively holding', async () => {
    const { JobTracker } = await import('../src/lib/job-tracker.js');
    const key = `render:${videoId}:locked`;
    await insertJob(key, 'RUNNING', {
      lockedBy: 'some-other-worker',
      lockedAt: new Date(),
      heartbeatAt: new Date(),
    });

    const tracker = await JobTracker.claim(ctx, {
      videoId,
      type: 'RENDER_VIDEO',
      attempt: 1,
      idempotencyKey: key,
    });
    expect(tracker).toBeNull();

    await ctx.db.delete(processingJob).where(eq(processingJob.videoId, videoId));
  }, 60_000);

  it('reclaims a job whose worker stopped responding', async () => {
    const { sweepStaleJobs } = await import('../src/lib/job-tracker.js');
    const key = `render:${videoId}:stale`;
    const staleId = await insertJob(key, 'RUNNING', {
      lockedBy: 'dead-worker',
      lockedAt: new Date(Date.now() - 600_000),
      // Well past the 90s staleness window.
      heartbeatAt: new Date(Date.now() - 600_000),
    });

    // The bug this covers made the sweep throw rather than return a count.
    const reclaimed = await sweepStaleJobs(ctx);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const [row] = await ctx.db.select().from(processingJob).where(eq(processingJob.id, staleId));
    expect(row!.status).toBe('FAILED');
    expect(row!.lockedBy).toBeNull();
    expect(row!.errorMessage).toMatch(/stopped responding/i);

    // Once reclaimed it can be picked up again.
    const { JobTracker } = await import('../src/lib/job-tracker.js');
    const tracker = await JobTracker.claim(ctx, {
      videoId,
      type: 'RENDER_VIDEO',
      attempt: 2,
      idempotencyKey: key,
    });
    expect(tracker).not.toBeNull();
    tracker!.stopHeartbeat();

    await ctx.db.delete(processingJob).where(eq(processingJob.videoId, videoId));
  }, 60_000);

  it('leaves a job with a fresh heartbeat alone', async () => {
    const { sweepStaleJobs } = await import('../src/lib/job-tracker.js');
    const liveId = await insertJob(`render:${videoId}:live`, 'RUNNING', {
      lockedBy: 'busy-worker',
      lockedAt: new Date(),
      heartbeatAt: new Date(),
    });

    await sweepStaleJobs(ctx);
    const [row] = await ctx.db.select().from(processingJob).where(eq(processingJob.id, liveId));
    expect(row!.status).toBe('RUNNING');

    await ctx.db.delete(processingJob).where(eq(processingJob.videoId, videoId));
  }, 60_000);

  it('dead-letters a permanent failure instead of retrying it', async () => {
    const { JobTracker } = await import('../src/lib/job-tracker.js');
    const { PermanentError } = await import('@rawedit/core');
    const key = `render:${videoId}:permanent`;
    await insertJob(key, 'QUEUED');

    const tracker = await JobTracker.claim(ctx, {
      videoId,
      type: 'RENDER_VIDEO',
      attempt: 1,
      idempotencyKey: key,
    });
    const result = await tracker!.fail(new PermanentError('No audio stream', 'NO_AUDIO'), 3);

    // Attempt 1 of 3, but a permanent error must not burn the other two.
    expect(result.deadLettered).toBe(true);
    const [row] = await ctx.db
      .select()
      .from(processingJob)
      .where(and(eq(processingJob.videoId, videoId), eq(processingJob.idempotencyKey, key)));
    expect(row!.status).toBe('DEAD');
    expect(row!.deadLetteredAt).not.toBeNull();

    await ctx.db.delete(processingJob).where(eq(processingJob.videoId, videoId));
  }, 60_000);

  it('retries a transient failure while attempts remain', async () => {
    const { JobTracker } = await import('../src/lib/job-tracker.js');
    const { TransientError } = await import('@rawedit/core');
    const key = `render:${videoId}:transient`;
    await insertJob(key, 'QUEUED');

    const tracker = await JobTracker.claim(ctx, {
      videoId,
      type: 'RENDER_VIDEO',
      attempt: 1,
      idempotencyKey: key,
    });
    const result = await tracker!.fail(new TransientError('R2 timed out'), 3);
    expect(result.deadLettered).toBe(false);

    const [row] = await ctx.db
      .select()
      .from(processingJob)
      .where(and(eq(processingJob.videoId, videoId), eq(processingJob.idempotencyKey, key)));
    expect(row!.status).toBe('FAILED');
    expect(row!.deadLetteredAt).toBeNull();

    await ctx.db.delete(processingJob).where(eq(processingJob.videoId, videoId));
  }, 60_000);

  it('dead-letters once the last attempt is used up', async () => {
    const { JobTracker } = await import('../src/lib/job-tracker.js');
    const { TransientError } = await import('@rawedit/core');
    const key = `render:${videoId}:exhausted`;
    await insertJob(key, 'QUEUED');

    const tracker = await JobTracker.claim(ctx, {
      videoId,
      type: 'RENDER_VIDEO',
      attempt: 3,
      idempotencyKey: key,
    });
    const result = await tracker!.fail(new TransientError('R2 timed out'), 3);
    expect(result.deadLettered).toBe(true);

    await ctx.db.delete(processingJob).where(eq(processingJob.videoId, videoId));
  }, 60_000);
});
