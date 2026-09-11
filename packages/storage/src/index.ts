import { IncrementalSha256, originalsKey, type CompletedPart, type StorageProvider } from "@raw-edit/core";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadConfig } from "@raw-edit/config";
import { SIGNED_URL_TTL_SECONDS } from "@raw-edit/contracts";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";


export function objectKeys(userId: string, videoId: string) {
  const root = `users/${userId}/videos/${videoId}`;
  return {
    original: (filename: string) => originalsKey(userId, videoId, filename),
    originalsPrefix: `${root}/originals/`,
    proxy: `${root}/proxy/720p.mp4`,
    audio: `${root}/audio/transcription.wav`,
    thumb: `${root}/thumb/poster.jpg`,
    filmstrip: `${root}/thumb/filmstrip.jpg`,
    export: (exportId: string) => `${root}/exports/${exportId}.mp4`,
    prefix: `${root}/`,
  };
}

export { originalsKey };
export type { CompletedPart, StorageProvider };

export function createR2Storage(config = loadConfig()): StorageProvider {
  const endpoint =
    config.r2.endpoint ||
    (config.r2.accountId ? `https://${config.r2.accountId}.r2.cloudflarestorage.com` : "");
  if (!endpoint || !config.r2.accessKeyId || !config.r2.secretAccessKey) {
    throw new Error("R2 storage is not configured");
  }

  const client = new S3Client({
    region: config.r2.region,
    endpoint,
    forcePathStyle: config.r2.forcePathStyle || endpoint.includes("localhost") || endpoint.includes("minio"),
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
  const bucket = config.r2.bucket;

  return {
    async createMultipartUpload(key, mimeType) {
      const result = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: mimeType,
        }),
      );
      if (!result.UploadId) throw new Error("R2 CreateMultipartUpload returned no uploadId");
      return { uploadId: result.UploadId };
    },

    async signPart(key, uploadId, partNumber, ttlSeconds = SIGNED_URL_TTL_SECONDS.uploadPart) {
      return getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: ttlSeconds },
      );
    },

    async signPut(key, mimeType, ttlSeconds = SIGNED_URL_TTL_SECONDS.uploadPart) {
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: mimeType,
        }),
        { expiresIn: ttlSeconds },
      );
    },

    async completeMultipartUpload(key, uploadId, parts) {
      const result = await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
          },
        }),
      );
      return { etag: result.ETag };
    },

    async abortMultipartUpload(key, uploadId) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    },

    async listParts(key, uploadId) {
      const result = await client.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
      return (result.Parts ?? []).map((part) => ({
        partNumber: part.PartNumber ?? 0,
        etag: (part.ETag ?? "").replaceAll('"', ""),
      }));
    },

    async head(key) {
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        contentLength: result.ContentLength ?? 0,
        etag: result.ETag,
        contentType: result.ContentType,
      };
    },

    async signGet(key, ttlSeconds, filename) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: filename ? `attachment; filename="${filename}"` : undefined,
        }),
        { expiresIn: ttlSeconds },
      );
    },

    async putObject(key, body, mimeType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
        }),
      );
    },

    async downloadToFile(key, destPath) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error("Empty object body");
      const hash = new IncrementalSha256();
      let sizeBytes = 0;
      const body = result.Body as Readable;
      body.on("data", (chunk: Buffer) => {
        sizeBytes += chunk.length;
        hash.update(chunk);
      });
      await pipeline(body, createWriteStream(destPath));
      return { sizeBytes, sha256: hash.digestHex() };
    },

    async deleteKey(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async deletePrefix(prefix) {
      let token: string | undefined;
      do {
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        const objects = (listed.Contents ?? [])
          .map((object) => ({ Key: object.Key }))
          .filter((object): object is { Key: string } => Boolean(object.Key));
        if (objects.length > 0) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects },
            }),
          );
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
    },
  };
}
