import type { Readable } from 'node:stream';

/**
 * Object storage. R2 today; any S3-compatible endpoint works without a code change.
 * The browser never sees credentials — only URLs produced by the signing methods here.
 */

export interface UploadPartRef {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CreateMultipartResult {
  uploadId: string;
  key: string;
}

export interface SignedPartUrl {
  partNumber: number;
  url: string;
  expiresAt: Date;
}

export interface ObjectHead {
  size: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
  checksumSha256: string | null;
}

export interface PutObjectInput {
  key: string;
  body: Uint8Array | Readable | Buffer;
  contentType?: string;
  contentLength?: number;
  cacheControl?: string;
}

export interface StorageProvider {
  readonly name: string;
  readonly bucket: string;

  createMultipartUpload(key: string, contentType: string): Promise<CreateMultipartResult>;
  signUploadParts(
    key: string,
    uploadId: string,
    partNumbers: readonly number[],
    ttlSeconds: number,
  ): Promise<SignedPartUrl[]>;
  listParts(key: string, uploadId: string): Promise<UploadPartRef[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: readonly UploadPartRef[]): Promise<{ etag: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  putObject(input: PutObjectInput): Promise<{ etag: string }>;
  /** Server-side multipart upload, used by the worker for rendered files. */
  uploadStream(key: string, body: Readable, contentType: string, onProgress?: (bytes: number) => void): Promise<{ etag: string; size: number }>;

  getObjectStream(key: string): Promise<Readable>;
  headObject(key: string): Promise<ObjectHead | null>;
  deleteObject(key: string): Promise<void>;
  deleteObjects(keys: readonly string[]): Promise<void>;

  /** Short-lived GET URL. Used for the player, downloads and ffmpeg's input. */
  signDownloadUrl(key: string, ttlSeconds: number, options?: { filename?: string; contentType?: string }): Promise<string>;
}
