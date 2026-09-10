import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AppError, analysisProgress } from "@raw-edit/core";
import { usageRecords, videos } from "@raw-edit/db";
import { objectKeys } from "@raw-edit/storage";
import type { QueueJobPayload } from "@raw-edit/queue";
import { getWorkerContext } from "../lib/context";
import { enqueueJob } from "../lib/enqueue";
import { claimJob, finishJob, startHeartbeat } from "./lock";

export async function processAnalyzeVideo(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId, payload.idempotencyKey);
  if (!claimed || claimed.alreadyDone) return;
  const { config, db, storage, media, queue } = getWorkerContext();
  const workDir = join(config.scratchDir, payload.jobId);
  const stopHeartbeat = startHeartbeat(payload.jobId);
  try {
    await mkdir(workDir, { recursive: true });
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video?.sourceStorageKey) throw new AppError("SOURCE_MISSING", "Original object key missing", 404, true);

    const sourceUrl = await storage.signGet(video.sourceStorageKey, config.sourceUrlTtlSeconds);
    await queue.publishProgress(video.id, { status: "ANALYZING", progress: analysisProgress("probe") });
    const metadata = await media.probe(sourceUrl);

    const sourcePath = join(workDir, "original");
    const downloaded = await storage.downloadToFile(video.sourceStorageKey, sourcePath);
    if (video.sizeBytes && downloaded.sizeBytes !== video.sizeBytes) {
      throw new AppError("SOURCE_HASH_MISMATCH", "Downloaded original size does not match upload", 409, true);
    }
    if (video.clientSha256 && video.clientSha256 !== downloaded.sha256) {
      throw new AppError("SOURCE_HASH_MISMATCH", "Stored original does not match the client SHA-256", 409, true);
    }

    const keys = objectKeys(payload.userId, video.id);
    const posterPath = join(workDir, "poster.jpg");
    const proxyPath = join(workDir, "proxy.mp4");
    const audioPath = join(workDir, "transcription.wav");
    await media.extractPoster(sourceUrl, posterPath);
    await storage.putObject(keys.thumb, await readFile(posterPath), "image/jpeg");
    await media.extractProxy(sourceUrl, proxyPath);
    await storage.putObject(keys.proxy, await readFile(proxyPath), "video/mp4");
    await media.extractTranscriptionAudio(sourceUrl, audioPath);
    await storage.putObject(keys.audio, await readFile(audioPath), "audio/wav");

    await db
      .update(videos)
      .set({
        status: "TRANSCRIBING",
        durationMs: metadata.durationMs,
        width: metadata.width,
        height: metadata.height,
        fpsNum: metadata.fpsNum,
        fpsDen: metadata.fpsDen,
        videoCodec: metadata.videoCodec,
        audioCodec: metadata.audioCodec,
        pixelFormat: metadata.pixelFormat,
        bitRate: metadata.bitRate,
        colorSpace: metadata.colorSpace,
        colorTransfer: metadata.colorTransfer,
        colorPrimaries: metadata.colorPrimaries,
        hdrType: metadata.hdrType,
        rotationDegrees: metadata.rotationDegrees,
        sourceSha256: downloaded.sha256,
        sizeBytes: downloaded.sizeBytes,
        thumbStorageKey: keys.thumb,
        proxyStorageKey: keys.proxy,
        audioStorageKey: keys.audio,
        progress: analysisProgress("done"),
        progressMessage: "Analysis complete",
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));
    await db.insert(usageRecords).values({
      userId: payload.userId,
      videoId: video.id,
      type: "UPLOAD_SECONDS",
      quantity: Math.round((metadata.durationMs ?? 0) / 1000),
      unit: "seconds",
    });

    await enqueueJob({
      videoId: video.id,
      userId: payload.userId,
      type: "TRANSCRIBE_VIDEO",
      inputVersion: downloaded.sha256,
    });
    await queue.publishProgress(video.id, { status: "TRANSCRIBING", progress: 30 });
    await finishJob(payload.jobId, "SUCCEEDED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analyze failed";
    const code = error instanceof AppError ? error.code : "FFPROBE_FAILED";
    const permanent = error instanceof AppError ? error.permanent : false;
    await getWorkerContext()
      .db.update(videos)
      .set({ status: "FAILED", errorCode: code, errorMessage: message, updatedAt: new Date() })
      .where(eq(videos.id, payload.videoId));
    await finishJob(payload.jobId, permanent ? "DEAD" : "FAILED", {
      errorCode: code,
      errorMessage: message,
      errorClass: permanent ? "permanent" : "transient",
    });
    throw error;
  } finally {
    stopHeartbeat();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
