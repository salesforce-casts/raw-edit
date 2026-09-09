import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type {
  EnqueueOptions,
  EnqueuedJob,
  JobPayloadMap,
  JobType,
  ProgressEvent,
  QueueProvider,
} from '@rawedit/core';
import { QUEUE_NAME, createRedis, progressChannel } from './connection.js';

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  // 10s -> 60s -> 300s, so a transient R2 or provider blip clears itself.
  backoff: { type: 'rawedit-staged', delay: 10_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const RETRY_BACKOFF_MS = [10_000, 60_000, 300_000];

export class BullMqQueue implements QueueProvider {
  readonly name = 'bullmq';
  private readonly queue: Queue;
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;

  constructor(options: { redis?: Redis; url?: string } = {}) {
    this.redis = options.redis ?? createRedis(options.url);
    this.ownsRedis = !options.redis;
    this.queue = new Queue(QUEUE_NAME, {
      connection: this.redis,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }

  /**
   * BullMQ's `jobId` gives us idempotency for free: adding a job with an id that is
   * already present is a no-op, so a replayed webhook or a double-clicked button
   * cannot start a second render.
   */
  async enqueue<T extends JobType>(
    type: T,
    payload: JobPayloadMap[T],
    options: EnqueueOptions,
  ): Promise<EnqueuedJob> {
    const jobId = options.idempotencyKey;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      // A finished job with the same key means the work is already done; a failed one
      // is a genuine retry, so clear it and let the new job through.
      if (state === 'failed') {
        await existing.remove();
      } else {
        return { id: jobId, type, deduplicated: true };
      }
    }

    await this.queue.add(
      type,
      { ...payload, __userId: options.userId },
      {
        jobId,
        priority: options.priority,
        delay: options.delayMs,
        attempts: options.maxAttempts ?? DEFAULT_JOB_OPTIONS.attempts,
      },
    );

    return { id: jobId, type, deduplicated: false };
  }

  /** Fire-and-forget progress fan-out for the SSE endpoint. Never throws. */
  async publishProgress(videoId: string, event: ProgressEvent): Promise<void> {
    try {
      await this.redis.publish(progressChannel(videoId), JSON.stringify(event));
      // Keep the last event so a client connecting mid-job sees state immediately.
      await this.redis.set(`${progressChannel(videoId)}:last`, JSON.stringify(event), 'EX', 3600);
    } catch {
      // Progress is a convenience; the database always holds the real state.
    }
  }

  async getLastProgress(videoId: string): Promise<ProgressEvent | null> {
    try {
      const raw = await this.redis.get(`${progressChannel(videoId)}:last`);
      return raw ? (JSON.parse(raw) as ProgressEvent) : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
    if (this.ownsRedis) await this.redis.quit();
  }
}

let cached: BullMqQueue | null = null;

export function getQueue(): BullMqQueue {
  if (!cached) cached = new BullMqQueue();
  return cached;
}
