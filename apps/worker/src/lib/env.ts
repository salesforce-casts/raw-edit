/** Worker configuration. Fail loudly at boot rather than on the first job. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. See .env.example.`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),

  /** Jobs processed in parallel by this replica. */
  concurrency: integer('WORKER_CONCURRENCY', 2),
  /**
   * Ceiling on jobs from one account across the whole fleet, so a creator queuing
   * ten 4K renders cannot starve everyone else.
   */
  maxConcurrentJobsPerUser: integer('MAX_CONCURRENT_JOBS_PER_USER', 1),

  /** Scratch space for extracted audio and rendered output. */
  workDir: process.env['WORKER_TMP_DIR'] ?? '/tmp/rawedit',
  /** Identifies this replica in `processing_job.locked_by`. */
  workerId: process.env['RAILWAY_REPLICA_ID'] ?? process.env['HOSTNAME'] ?? `worker-${process.pid}`,

  /** Signed-URL lifetime for ffmpeg's input; must outlast the longest render. */
  sourceUrlTtlSeconds: integer('SOURCE_URL_TTL_SECONDS', 6 * 3600),
  heartbeatIntervalMs: integer('WORKER_HEARTBEAT_MS', 10_000),
  /** A RUNNING job with no heartbeat for this long is reclaimable. */
  staleJobAfterMs: integer('WORKER_STALE_JOB_MS', 90_000),
  sweepIntervalMs: integer('WORKER_SWEEP_MS', 60_000),

  /** Skip proxy/thumbnail/waveform generation (useful for a cheap render-only pool). */
  generatePreviews: process.env['WORKER_GENERATE_PREVIEWS'] !== '0',

  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
} as const;

export type WorkerEnv = typeof env;
