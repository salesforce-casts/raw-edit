import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import IORedis from "ioredis";
import { loadConfig } from "@raw-edit/config";
import {
  QUEUE_NAMES,
  JOB_RETRY_DELAYS_MS,
  progressChannel,
  retryDelayMs,
  type JobType,
  type QueueJobPayload,
  type QueueProvider,
} from "@raw-edit/core";

export type { QueueJobPayload, QueueProvider };

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "custom",
    delay: JOB_RETRY_DELAYS_MS[0],
  },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

export function createRedisConnection(config = loadConfig()) {
  if (config.redis.url) {
    return new IORedis(config.redis.url, { maxRetriesPerRequest: null });
  }
  return new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    tls: config.redis.tls ? {} : undefined,
    maxRetriesPerRequest: null,
  });
}

const queues = new Map<string, Queue>();

export function getQueue(name: string, connection = createRedisConnection()) {
  const existing = queues.get(name);
  if (existing) return existing;
  const queue = new Queue(name, {
    connection,
    defaultJobOptions,
  });
  queues.set(name, queue);
  return queue;
}

export function queueNameForJob(type: JobType): string {
  switch (type) {
    case "ANALYZE_VIDEO":
      return QUEUE_NAMES.analysis;
    case "TRANSCRIBE_VIDEO":
      return QUEUE_NAMES.transcription;
    case "DETECT_AUTOMATIC_EDITS":
      return QUEUE_NAMES.editDetection;
    case "RENDER_EXPORT":
      return QUEUE_NAMES.render;
    case "DELETE_VIDEO":
      return QUEUE_NAMES.maintenance;
    default:
      return QUEUE_NAMES.analysis;
  }
}

export function createBullmqQueue(
  connection = createRedisConnection(),
  subscriber = createRedisConnection(),
): QueueProvider {
  return {
    async enqueue(queueName, payload, options) {
      const queue = getQueue(queueName, connection);
      const id = options?.jobId ?? payload.idempotencyKey ?? payload.jobId;
      try {
        const job = await queue.add(payload.type, payload, {
          jobId: id,
          delay: options?.delayMs,
          attempts: options?.attempts,
        });
        return String(job.id);
      } catch {
        const existing = await queue.getJob(id);
        if (existing) {
          await existing.retry().catch(() => undefined);
          return String(existing.id);
        }
        throw new Error(`Could not enqueue ${payload.type}`);
      }
    },
    async publishProgress(videoId, payload) {
      await connection.publish(progressChannel(videoId), JSON.stringify(payload));
    },
    async subscribeProgress(videoId, onEvent) {
      const channel = progressChannel(videoId);
      const handler = (incoming: string, message: string) => {
        if (incoming !== channel) return;
        try {
          onEvent(JSON.parse(message) as Record<string, unknown>);
        } catch {
          onEvent({ raw: message });
        }
      };
      subscriber.on("message", handler);
      await subscriber.subscribe(channel);
      return async () => {
        subscriber.off("message", handler);
        await subscriber.unsubscribe(channel);
      };
    },
  };
}

export function createWorker(
  queueName: string,
  processor: Processor<QueueJobPayload>,
  concurrency: number,
  connection = createRedisConnection(),
) {
  return new Worker<QueueJobPayload>(queueName, processor, {
    connection,
    concurrency,
    settings: {
      backoffStrategy: (attemptsMade: number) => retryDelayMs(Math.max(0, attemptsMade - 1)),
    },
  });
}

export { defaultJobOptions };
