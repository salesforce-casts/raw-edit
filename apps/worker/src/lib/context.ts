import { loadConfig } from "@raw-edit/config";
import { getDb } from "@raw-edit/db";
import { createR2Storage } from "@raw-edit/storage";
import { createBullmqQueue } from "@raw-edit/queue";
import { getTranscriptionProvider } from "@raw-edit/transcription";
import { createFfmpegProcessor } from "@raw-edit/media";
import { createCloudImportProvider } from "@raw-edit/imports";
import { createNoopPaymentProvider, getTakeJudge } from "@raw-edit/ai";

export function createWorkerContext() {
  const config = loadConfig();
  return {
    config,
    db: getDb(),
    storage: createR2Storage(),
    queue: createBullmqQueue(),
    transcription: getTranscriptionProvider(),
    media: createFfmpegProcessor(config),
    imports: createCloudImportProvider(),
    payment: createNoopPaymentProvider(),
    takeJudge: getTakeJudge(),
  };
}

export type WorkerContext = ReturnType<typeof createWorkerContext>;

let cached: WorkerContext | undefined;

export function getWorkerContext(): WorkerContext {
  cached ??= createWorkerContext();
  return cached;
}
