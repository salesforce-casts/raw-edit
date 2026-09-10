import { and, eq, sql } from 'drizzle-orm';
import { assertJobTransition, isRetryable } from '@rawedit/core';
import { processingJob, setVideoProgress, setVideoStatus, type Database } from '@rawedit/db';
import type { JobStatus, JobType, VideoStatus } from '@rawedit/core';
import { env } from './env.js';
import { logger } from './logger.js';
import type { WorkerContext } from './context.js';

/**
 * Mirrors a BullMQ job into `processing_job` so state survives a Redis flush, and
 * publishes progress to the SSE channel.
 *
 * The database row is the truth: the browser can be closed at any point and the
 * dashboard will still show exactly where the pipeline got to.
 */
export class JobTracker {
  private heartbeat: NodeJS.Timeout | null = null;
  private lastPublishedProgress = -1;
  private lastPublishAt = 0;

  constructor(
    private readonly ctx: WorkerContext,
    readonly rowId: string,
    readonly videoId: string,
    readonly type: JobType,
    readonly attempt: number,
  ) {}

  /**
   * Claim the job. Returns false when another replica already holds it, which is how
   * a duplicate delivery is made harmless.
   */
  static async claim(
    ctx: WorkerContext,
    input: { videoId: string; type: JobType; attempt: number },
  ): Promise<JobTracker | null> {
    const rows = await ctx.db
      .select()
      .from(processingJob)
      .where(and(eq(processingJob.videoId, input.videoId), eq(processingJob.type, input.type)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      logger.warn({ videoId: input.videoId, type: input.type }, 'No processing_job row for this job');
      return null;
    }

    if (row.status === 'SUCCEEDED') {
      logger.info({ jobId: row.id }, 'Job already succeeded; skipping');
      return null;
    }
    if (row.status === 'CANCELLED') {
      logger.info({ jobId: row.id }, 'Job was cancelled; skipping');
      return null;
    }

    // Another replica holds a live lock on this job.
    const heartbeatAge = row.heartbeatAt ? Date.now() - row.heartbeatAt.getTime() : Infinity;
    if (row.status === 'RUNNING' && row.lockedBy !== env.workerId && heartbeatAge < env.staleJobAfterMs) {
      logger.info({ jobId: row.id, lockedBy: row.lockedBy }, 'Job is locked by another worker; skipping');
      return null;
    }

    assertJobTransition(row.status, 'RUNNING');
    await ctx.db
      .update(processingJob)
      .set({
        status: 'RUNNING',
        attempt: input.attempt,
        lockedBy: env.workerId,
        lockedAt: new Date(),
        heartbeatAt: new Date(),
        startedAt: row.startedAt ?? new Date(),
        errorMessage: null,
        errorStack: null,
      })
      .where(eq(processingJob.id, row.id));

    const tracker = new JobTracker(ctx, row.id, input.videoId, input.type, input.attempt);
    tracker.startHeartbeat();
    return tracker;
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      void this.ctx.db
        .update(processingJob)
        .set({ heartbeatAt: new Date() })
        .where(eq(processingJob.id, this.rowId))
        .catch((error: unknown) => logger.warn({ err: error }, 'Heartbeat failed'));
    }, env.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  /**
   * Record progress. Writes are throttled — a 4K render emits progress several times
   * a second and none of that needs to reach Postgres.
   */
  async progress(
    percent: number,
    options: { stage?: string; status?: VideoStatus; message?: string } = {},
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const now = Date.now();
    const changed = clamped !== this.lastPublishedProgress;
    const throttled = now - this.lastPublishAt < 1000;
    if (!changed && throttled) return;

    this.lastPublishedProgress = clamped;
    this.lastPublishAt = now;

    await this.ctx.db
      .update(processingJob)
      .set({ progress: clamped, progressStage: options.stage ?? null })
      .where(eq(processingJob.id, this.rowId));

    await setVideoProgress(this.ctx.db, this.videoId, clamped, options.stage);

    // Best-effort fan-out for the SSE stream; the database already has the truth.
    await this.ctx.queue.publishProgress(this.videoId, {
      videoId: this.videoId,
      status: options.status ?? 'ANALYZING',
      progress: clamped,
      stage: options.stage,
      message: options.message,
      at: now,
    });
  }

  async succeed(result?: unknown): Promise<void> {
    this.stopHeartbeat();
    await this.finish('SUCCEEDED', { result, progress: 100 });
  }

  /**
   * Record a failure. A permanent error dead-letters immediately rather than burning
   * three attempts on a file that will never decode.
   */
  async fail(error: unknown, maxAttempts: number): Promise<{ deadLettered: boolean }> {
    this.stopHeartbeat();
    const retryable = isRetryable(error);
    const attemptsLeft = this.attempt < maxAttempts;
    const dead = !retryable || !attemptsLeft;

    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack ?? null : null;

    await this.finish(dead ? 'DEAD' : 'FAILED', {
      errorMessage: message.slice(0, 2000),
      errorStack: stack?.slice(0, 8000) ?? null,
      deadLettered: dead,
    });

    logger.error(
      { jobId: this.rowId, videoId: this.videoId, retryable, attempt: this.attempt, maxAttempts, err: error },
      dead ? 'Job dead-lettered' : 'Job failed and will be retried',
    );

    return { deadLettered: dead };
  }

  private async finish(
    status: JobStatus,
    patch: {
      result?: unknown;
      progress?: number;
      errorMessage?: string | null;
      errorStack?: string | null;
      deadLettered?: boolean;
    },
  ): Promise<void> {
    await this.ctx.db
      .update(processingJob)
      .set({
        status,
        finishedAt: new Date(),
        lockedBy: null,
        result: patch.result === undefined ? undefined : (patch.result as never),
        progress: patch.progress ?? undefined,
        errorMessage: patch.errorMessage ?? undefined,
        errorStack: patch.errorStack ?? undefined,
        deadLetteredAt: patch.deadLettered ? new Date() : undefined,
      })
      .where(eq(processingJob.id, this.rowId));
  }

  stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

/**
 * Mark a video FAILED without disturbing anything else about the record.
 *
 * A failing job must never corrupt a video: it only ever touches status, detail,
 * error and progress, so the previous transcript and EDL survive intact.
 */
export async function markVideoFailed(
  db: Database,
  videoId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await setVideoStatus(db, videoId, 'FAILED', {
      errorMessage: message.slice(0, 1000),
      statusDetail: null,
    });
  } catch (statusError: unknown) {
    logger.error({ err: statusError, videoId }, 'Could not mark video as failed');
  }
}

/** Reclaim jobs whose worker died mid-run. */
export async function sweepStaleJobs(ctx: WorkerContext): Promise<number> {
  const cutoff = new Date(Date.now() - env.staleJobAfterMs);
  const reclaimed = await ctx.db
    .update(processingJob)
    .set({ status: 'FAILED', errorMessage: 'Worker stopped responding; job reclaimed.', lockedBy: null })
    .where(
      and(
        eq(processingJob.status, 'RUNNING'),
        sql`(${processingJob.heartbeatAt} is null or ${processingJob.heartbeatAt} < ${cutoff})`,
      ),
    )
    .returning({ id: processingJob.id });

  if (reclaimed.length > 0) {
    logger.warn({ count: reclaimed.length }, 'Reclaimed stale jobs');
  }
  return reclaimed.length;
}
