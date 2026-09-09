import { Redis, type RedisOptions } from 'ioredis';

/** BullMQ requires this; a blocking command must not be cut short by a retry cap. */
const BULLMQ_REQUIRED: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export function createRedis(url?: string, extra: RedisOptions = {}): Redis {
  const connectionString = url ?? process.env['REDIS_URL'];
  if (!connectionString) {
    throw new Error('REDIS_URL is not set. Run `docker compose up -d` or point it at a managed Redis.');
  }

  const options: RedisOptions = {
    ...BULLMQ_REQUIRED,
    ...extra,
    // Managed Redis (Upstash, Railway) uses rediss:// with a real certificate.
    ...(connectionString.startsWith('rediss://') ? { tls: { rejectUnauthorized: true } } : {}),
  };

  return new Redis(connectionString, options);
}

export const QUEUE_NAME = 'rawedit-media';
export const PROGRESS_CHANNEL_PREFIX = 'video:';

export function progressChannel(videoId: string): string {
  return `${PROGRESS_CHANNEL_PREFIX}${videoId}:progress`;
}
