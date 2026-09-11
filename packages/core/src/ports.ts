import type {
  EditSegment,
  ExportPreset,
  ExportStrategy,
  FfprobeMetadata,
  JobType,
  PlanId,
  TranscriptionInput,
  TranscriptionResult,
} from "./types";

export type CompletedPart = { partNumber: number; etag: string; sizeBytes?: number };

export interface StorageProvider {
  createMultipartUpload(key: string, mimeType: string): Promise<{ uploadId: string }>;
  signPart(key: string, uploadId: string, partNumber: number, ttlSeconds?: number): Promise<string>;
  signPut(key: string, mimeType: string, ttlSeconds?: number): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<{ etag?: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  listParts(key: string, uploadId: string): Promise<CompletedPart[]>;
  head(key: string): Promise<{ contentLength: number; etag?: string; contentType?: string }>;
  signGet(key: string, ttlSeconds: number, filename?: string): Promise<string>;
  putObject(key: string, body: Buffer | Uint8Array, mimeType: string): Promise<void>;
  downloadToFile(key: string, destPath: string): Promise<{ sizeBytes: number; sha256: string }>;
  deletePrefix(prefix: string): Promise<void>;
  deleteKey(key: string): Promise<void>;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export type QueueJobPayload = {
  jobId: string;
  videoId: string;
  userId: string;
  type: JobType;
  exportId?: string;
  idempotencyKey?: string;
  inputVersion?: string;
};

export type EnqueueOptions = {
  jobId?: string;
  delayMs?: number;
  attempts?: number;
};

export interface QueueProvider {
  enqueue(queueName: string, payload: QueueJobPayload, options?: EnqueueOptions): Promise<string>;
  publishProgress(videoId: string, payload: Record<string, unknown>): Promise<void>;
  subscribeProgress(videoId: string, onEvent: (payload: Record<string, unknown>) => void): Promise<() => Promise<void>>;
}

export type SilenceRegion = { startMs: number; endMs: number };

export type RenderInput = {
  sourceUrlOrPath: string;
  segments: EditSegment[];
  metadata: FfprobeMetadata;
  preset: ExportPreset;
  strategy: ExportStrategy;
  filterScriptPath: string;
  outputPath: string;
  workDir?: string;
  keyframeMs?: number[];
  onProgress?: (outTimeMs: number) => void;
};

export interface VideoProcessor {
  probe(sourceUrlOrPath: string): Promise<FfprobeMetadata>;
  extractPoster(sourceUrlOrPath: string, destPath: string): Promise<void>;
  extractProxy(sourceUrlOrPath: string, destPath: string): Promise<void>;
  extractTranscriptionAudio(sourceUrlOrPath: string, destPath: string): Promise<void>;
  extractAnalysisVisuals(
    sourceUrlOrPath: string,
    dest: { posterPath: string; proxyPath: string; filmstripPath: string },
  ): Promise<void>;
  extractKeyframes(sourceUrlOrPath: string): Promise<number[]>;
  detectSilence(sourceUrlOrPath: string, minSilenceSeconds: number): Promise<SilenceRegion[]>;
  render(input: RenderInput): Promise<void>;
}

export type CloudImportResult = {
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  sourceUrl: string;
};

export interface CloudImportProvider {
  resolve(input: { url: string; provider?: string }): Promise<CloudImportResult>;
}

export interface PaymentProvider {
  createCustomer(input: { userId: string; email: string }): Promise<{ customerId: string }>;
  createCheckout(input: { customerId: string; plan: PlanId }): Promise<{ url: string }>;
  cancelSubscription(input: { subscriptionId: string }): Promise<void>;
  handleWebhook(payload: unknown, signature: string): Promise<void>;
}
