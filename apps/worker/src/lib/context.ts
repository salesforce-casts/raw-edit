import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDb, type Database } from '@rawedit/db';
import { createStorageFromEnv } from '@rawedit/storage';
import { BullMqQueue, createRedis } from '@rawedit/queue';
import { FfmpegVideoProcessor } from '@rawedit/media';
import { createEditAdvisorFromEnv, createTranscriptionFromEnv } from '@rawedit/transcription';
import { createImporters } from '@rawedit/imports';
import type {
  CloudImportProvider,
  EditAdvisor,
  StorageProvider,
  TranscriptionProvider,
  VideoProcessor,
} from '@rawedit/core';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * The worker's composition root: every concrete provider is constructed here, once,
 * from environment variables. Handlers receive interfaces and never see an SDK.
 */
export interface WorkerContext {
  db: Database;
  storage: StorageProvider;
  queue: BullMqQueue;
  processor: VideoProcessor;
  transcription: TranscriptionProvider;
  advisor: EditAdvisor;
  importers: CloudImportProvider[];
  workDir: string;
  close: () => Promise<void>;
}

export async function createContext(): Promise<WorkerContext> {
  const { db, sql } = createDb({
    connectionString: env.databaseUrl,
    // The worker connects directly rather than through the pooler, so prepared
    // statements are available and a handful of connections is fine.
    max: Math.max(2, env.concurrency + 1),
    prepare: true,
  });

  const redis = createRedis(env.redisUrl);
  const queue = new BullMqQueue({ redis });
  const storage = createStorageFromEnv();
  const transcription = createTranscriptionFromEnv();
  const advisor = createEditAdvisorFromEnv();

  await mkdir(env.workDir, { recursive: true });

  logger.info(
    {
      transcription: transcription.name,
      transcriptionModel: transcription.model,
      advisor: advisor.name,
      storage: storage.name,
      bucket: storage.bucket,
      concurrency: env.concurrency,
    },
    'Worker providers ready',
  );

  return {
    db,
    storage,
    queue,
    processor: new FfmpegVideoProcessor(),
    transcription,
    advisor,
    importers: createImporters(),
    workDir: env.workDir,
    close: async () => {
      await queue.close();
      await redis.quit().catch(() => undefined);
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Per-job scratch directory. Always removed, even when the job fails, so a crashed
 * render cannot fill the container's disk.
 */
export async function withScratchDir<T>(
  jobId: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = join(env.workDir, jobId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn({ err: error, dir }, 'Could not clean up scratch directory');
    });
  }
}
