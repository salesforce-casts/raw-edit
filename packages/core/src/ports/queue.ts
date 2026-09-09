import type { JobType } from '../types/status.js';

export interface JobPayloadMap {
  ANALYZE_VIDEO: { videoId: string; userId: string; reanalyze?: boolean };
  TRANSCRIBE_AUDIO: { videoId: string; userId: string };
  DETECT_TAKES: { videoId: string; userId: string };
  RENDER_VIDEO: { videoId: string; userId: string; exportId: string; edlVersion: number };
  IMPORT_SOURCE: { videoId: string; userId: string; sourceId: string };
  GENERATE_PROXY: { videoId: string; userId: string };
  CLEANUP_SOURCE: { videoId?: string; userId?: string; sweep?: boolean };
}

export interface EnqueueOptions {
  /** Duplicate enqueues with the same key collapse to one job. */
  idempotencyKey: string;
  /** Used for per-user fairness so one account cannot occupy the whole fleet. */
  userId: string;
  priority?: number;
  delayMs?: number;
  maxAttempts?: number;
}

export interface EnqueuedJob {
  id: string;
  type: JobType;
  /** True when an existing job with the same idempotency key was returned. */
  deduplicated: boolean;
}

export interface JobHandle<T extends JobType = JobType> {
  id: string;
  type: T;
  attempt: number;
  maxAttempts: number;
  payload: JobPayloadMap[T];
  updateProgress(progress: number, stage?: string): Promise<void>;
  /** Extends the lock; the sweeper reclaims jobs whose heartbeat goes stale. */
  heartbeat(): Promise<void>;
}

export interface QueueProvider {
  readonly name: string;
  enqueue<T extends JobType>(type: T, payload: JobPayloadMap[T], options: EnqueueOptions): Promise<EnqueuedJob>;
  /** Publish a progress event for the SSE stream. Best-effort; never throws. */
  publishProgress(videoId: string, event: ProgressEvent): Promise<void>;
  close(): Promise<void>;
}

export interface ProgressEvent {
  videoId: string;
  status: string;
  progress: number;
  stage?: string;
  message?: string;
  at: number;
}

/** Errors classified as transient are retried; permanent ones dead-letter immediately. */
export class TransientError extends Error {
  readonly retryable = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientError';
  }
}

export class PermanentError extends Error {
  readonly retryable = false;
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof PermanentError) return false;
  if (error instanceof TransientError) return true;
  // Network-ish failures are worth another attempt; anything else is not assumed to be.
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|503|502|429|timeout/i.test(message);
}
