import { Worker, type Job } from 'bullmq';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { QUEUE_NAME, RETRY_BACKOFF_MS, createRedis } from '@rawedit/queue';
import { processingJob } from '@rawedit/db';
import type { JobType } from '@rawedit/core';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { createContext, type WorkerContext } from './lib/context.js';
import { JobTracker, markVideoFailed, sweepStaleJobs } from './lib/job-tracker.js';
import { handleAnalyze } from './handlers/analyze.js';
import { handleRender } from './handlers/render.js';
import { handleImport } from './handlers/import.js';
import { handleCleanup } from './handlers/cleanup.js';

/**
 * The media worker.
 *
 * Deployed as a Docker image on Railway. `WORKER_CONCURRENCY` sets how many jobs a
 * replica runs at once, and replicas can be scaled horizontally — job locking plus
 * the per-user cap keeps that safe.
 */
async function main(): Promise<void> {
  const ctx = await createContext();
  let shuttingDown = false;

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => processJob(ctx, job),
    {
      connection: createRedis(env.redisUrl),
      concurrency: env.concurrency,
      // A 4K render can legitimately take a long time; the heartbeat is what proves
      // the job is alive, so the stall check has to be generous.
      stalledInterval: 60_000,
      maxStalledCount: 2,
      lockDuration: 120_000,
      settings: {
        backoffStrategy: (attemptsMade: number) =>
          RETRY_BACKOFF_MS[Math.min(attemptsMade, RETRY_BACKOFF_MS.length - 1)] ?? 300_000,
      },
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, type: job.name }, 'Job completed');
  });
  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, type: job?.name, err: error }, 'Job failed');
  });
  worker.on('error', (error) => {
    logger.error({ err: error }, 'Worker error');
  });

  // Reclaim jobs whose worker died, and run retention sweeps.
  const sweeper = setInterval(() => {
    void sweepStaleJobs(ctx).catch((error: unknown) => logger.error({ err: error }, 'Sweep failed'));
    void handleCleanup(ctx).catch((error: unknown) => logger.error({ err: error }, 'Cleanup failed'));
  }, env.sweepIntervalMs);
  sweeper.unref?.();

  logger.info(
    { queue: QUEUE_NAME, concurrency: env.concurrency, workerId: env.workerId },
    'Worker started',
  );

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down; finishing in-flight jobs');
    clearInterval(sweeper);
    // `false` lets running jobs finish rather than orphaning a half-written render.
    await worker.close(false);
    await ctx.close();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Route one job.
 *
 * Everything a handler can throw is funnelled through the tracker so the database
 * always ends up consistent — a failing job only ever changes the video's status,
 * detail, error and progress, never its transcript or EDL.
 */
async function processJob(ctx: WorkerContext, job: Job): Promise<unknown> {
  const type = job.name as JobType;
  const payload = job.data as Record<string, unknown> & { videoId?: string; userId?: string };

  if (type === 'CLEANUP_SOURCE') {
    return handleCleanup(ctx);
  }

  const videoId = payload.videoId;
  const userId = payload.userId ?? (payload['__userId'] as string | undefined);
  if (!videoId || !userId) {
    logger.error({ jobId: job.id, type }, 'Job payload is missing videoId or userId');
    return { skipped: 'invalid-payload' };
  }

  // Fairness: one account must not occupy the whole fleet. Delaying rather than
  // failing keeps the job in the queue without burning an attempt.
  const active = await countOtherActiveJobs(ctx, userId, videoId, type);
  if (active >= env.maxConcurrentJobsPerUser) {
    logger.info({ userId, active, jobId: job.id }, 'Deferring job: user is at their concurrency limit');
    await job.moveToDelayed(Date.now() + 15_000, job.token);
    return { deferred: true };
  }

  const attempt = job.attemptsMade + 1;
  const tracker = await JobTracker.claim(ctx, { videoId, type, attempt });
  if (!tracker) return { skipped: 'not-claimable' };

  try {
    switch (type) {
      case 'ANALYZE_VIDEO':
        await handleAnalyze(ctx, tracker, { videoId, userId });
        break;
      case 'RENDER_VIDEO':
        await handleRender(ctx, tracker, {
          videoId,
          userId,
          exportId: String(payload['exportId']),
          edlVersion: Number(payload['edlVersion'] ?? 1),
        });
        break;
      case 'IMPORT_SOURCE':
        await handleImport(ctx, tracker, { videoId, userId, sourceId: String(payload['sourceId']) });
        break;
      default:
        logger.warn({ type }, 'No handler for this job type');
        break;
    }

    await tracker.succeed();
    return { ok: true };
  } catch (error: unknown) {
    const { deadLettered } = await tracker.fail(error, job.opts.attempts ?? 3);

    // Only surface a failure to the user once retries are exhausted; a transient R2
    // blip should not flash "Failed" on their dashboard.
    if (deadLettered) {
      await markVideoFailed(ctx.db, videoId, error);
      await ctx.queue.publishProgress(videoId, {
        videoId,
        status: 'FAILED',
        progress: 0,
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
      // Swallowing the error stops BullMQ retrying a job we deliberately killed.
      return { failed: true, deadLettered: true };
    }
    throw error;
  } finally {
    tracker.stopHeartbeat();
  }
}

/** How many other jobs this user already has in flight. */
async function countOtherActiveJobs(
  ctx: WorkerContext,
  userId: string,
  videoId: string,
  type: JobType,
): Promise<number> {
  const rows = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(processingJob)
    .where(
      and(
        eq(processingJob.userId, userId),
        eq(processingJob.status, 'RUNNING'),
        // Exclude this job itself, which may already be marked RUNNING by a retry.
        ne(processingJob.videoId, videoId),
        inArray(processingJob.type, ['ANALYZE_VIDEO', 'RENDER_VIDEO', 'IMPORT_SOURCE']),
      ),
    );
  void type;
  return rows[0]?.count ?? 0;
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Worker failed to start');
  process.exit(1);
});
