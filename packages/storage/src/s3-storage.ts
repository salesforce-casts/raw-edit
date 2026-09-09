import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  CreateMultipartResult,
  ObjectHead,
  PutObjectInput,
  SignedPartUrl,
  StorageProvider,
  UploadPartRef,
} from '@rawedit/core';

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  /** R2: https://<account>.r2.cloudflarestorage.com — omit for real AWS S3. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 and MinIO both need path-style addressing. */
  forcePathStyle?: boolean;
  /** Public base URL, only used when a bucket is deliberately public (it is not). */
  publicBaseUrl?: string;
}

/**
 * S3-compatible object storage. Configured against Cloudflare R2 in production and
 * MinIO locally; the code is identical because both speak the same API.
 *
 * Credentials live here and nowhere else. The browser only ever receives the signed
 * URLs produced by `signUploadParts` and `signDownloadUrl`, each scoped to a single
 * operation on a single key and valid for minutes.
 */
export class S3Storage implements StorageProvider {
  readonly name = 's3';
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.bucket = options.bucket;
    const config: S3ClientConfig = {
      region: options.region ?? 'auto',
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
    };
    if (options.endpoint) config.endpoint = options.endpoint;
    this.client = new S3Client(config);
  }

  async createMultipartUpload(key: string, contentType: string): Promise<CreateMultipartResult> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!response.UploadId) throw new Error('R2 did not return an UploadId');
    return { uploadId: response.UploadId, key };
  }

  async signUploadParts(
    key: string,
    uploadId: string,
    partNumbers: readonly number[],
    ttlSeconds: number,
  ): Promise<SignedPartUrl[]> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.client,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: ttlSeconds },
        ),
        expiresAt,
      })),
    );
  }

  /**
   * R2's view of which parts landed. This is the authority on resume — a client that
   * lost its state, or is lying about it, cannot make us complete a partial object.
   */
  async listParts(key: string, uploadId: string): Promise<UploadPartRef[]> {
    const parts: UploadPartRef[] = [];
    let marker: number | undefined;

    for (;;) {
      const response = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker === undefined ? undefined : String(marker),
        }),
      );
      for (const part of response.Parts ?? []) {
        if (part.PartNumber === undefined || !part.ETag) continue;
        parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size ?? 0 });
      }
      if (!response.IsTruncated) break;
      const next = response.NextPartNumberMarker;
      if (next === undefined) break;
      marker = Number(next);
    }

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly UploadPartRef[],
  ): Promise<{ etag: string }> {
    const response = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
    return { etag: response.ETag ?? '' };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
    );
  }

  async putObject(input: PutObjectInput): Promise<{ etag: string }> {
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body as never,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        CacheControl: input.cacheControl,
      }),
    );
    return { etag: response.ETag ?? '' };
  }

  /** Server-side multipart upload, used by the worker for rendered files. */
  async uploadStream(
    key: string,
    body: Readable,
    contentType: string,
    onProgress?: (bytes: number) => void,
  ): Promise<{ etag: string; size: number }> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
      leavePartsOnError: false,
    });

    let uploaded = 0;
    if (onProgress) {
      upload.on('httpUploadProgress', (progress) => {
        uploaded = progress.loaded ?? uploaded;
        onProgress(uploaded);
      });
    }

    const result = await upload.done();
    const head = await this.headObject(key);
    return { etag: result.ETag ?? '', size: head?.size ?? uploaded };
  }

  async getObjectStream(key: string): Promise<Readable> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = response.Body;
    if (!body) throw new Error(`Object ${key} has no body`);
    if (body instanceof Readable) return body;
    // Web stream (edge/undici); convert so callers only deal with node streams.
    return Readable.fromWeb(body as never);
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: response.ContentLength ?? 0,
        contentType: response.ContentType ?? null,
        etag: response.ETag ?? null,
        lastModified: response.LastModified ?? null,
        checksumSha256: response.ChecksumSHA256 ?? null,
      };
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    // DeleteObjects caps at 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async signDownloadUrl(
    key: string,
    ttlSeconds: number,
    options: { filename?: string; contentType?: string } = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: options.filename
        ? `attachment; filename="${options.filename.replace(/"/g, '')}"`
        : undefined,
      ResponseContentType: options.contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return named.name === 'NotFound' || named.name === 'NoSuchKey' || named.$metadata?.httpStatusCode === 404;
}

export interface StorageEnv {
  R2_BUCKET?: string;
  R2_ACCOUNT_ID?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_REGION?: string;
}

/**
 * Build the provider from environment variables. This is the only function that reads
 * storage credentials, and it is only ever called on the server.
 */
export function createStorageFromEnv(env: NodeJS.ProcessEnv | StorageEnv = process.env): StorageProvider {
  const source = env as StorageEnv;
  const bucket = source.R2_BUCKET;
  const accessKeyId = source.R2_ACCESS_KEY_ID;
  const secretAccessKey = source.R2_SECRET_ACCESS_KEY;
  const endpoint =
    source.R2_ENDPOINT ??
    (source.R2_ACCOUNT_ID ? `https://${source.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

  const missing = [
    !bucket && 'R2_BUCKET',
    !accessKeyId && 'R2_ACCESS_KEY_ID',
    !secretAccessKey && 'R2_SECRET_ACCESS_KEY',
    !endpoint && 'R2_ENDPOINT or R2_ACCOUNT_ID',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Object storage is not configured. Missing: ${missing.join(', ')}. See .env.example.`,
    );
  }

  return new S3Storage({
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    endpoint: endpoint!,
    region: source.R2_REGION ?? 'auto',
    forcePathStyle: true,
  });
}
