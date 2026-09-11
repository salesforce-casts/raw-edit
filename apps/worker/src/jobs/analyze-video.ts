import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AppError, PACING_SETTINGS, analysisProgress, waveformPeaksFromPcm16Wav, type PacingPreset } from "@raw-edit/core";
import { usageRecords, userProfiles, videos } from "@raw-edit/db";
import { objectKeys } from "@raw-edit/storage";
import type { QueueJobPayload } from "@raw-edit/queue";
import { getWorkerContext } from "../lib/context";
import { enqueueJob } from "../lib/enqueue";
import { claimJob, finishJob, startHeartbeat } from "./lock";

function isPacing(value: string | null | undefined): PacingPreset {
  return value === "tight" || value === "very_tight" ? value : "natural";
}

export async function processAnalyzeVideo(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId, payload.idempotencyKey);
  if (!claimed || claimed.alreadyDone) return;
  const { config, db, storage, media, queue } = getWorkerContext();
  const workDir = join(config.scratchDir, payload.jobId);
  const stopHeartbeat = startHeartbeat(payload.jobId);
  const stageDurations: Record<string, number> = {};
  async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      stageDurations[name] = Date.now() - started;
    }
  }
  try {
    await mkdir(workDir, { recursive: true });
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video?.sourceStorageKey) throw new AppError("SOURCE_MISSING", "Original object key missing", 404, true);

    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, payload.userId)).limit(1);
    const pacing = isPacing(video.pacingPreset || profile?.pacingPreset);
    const pacingSettings = PACING_SETTINGS[pacing];

    await queue.publishProgress(video.id, { status: "ANALYZING", progress: analysisProgress("hash") });
    const sourcePath = join(workDir, "original");
    const downloaded = await timed("download", () => storage.downloadToFile(video.sourceStorageKey!, sourcePath));
    if (video.sizeBytes && downloaded.sizeBytes !== video.sizeBytes) {
      throw new AppError("SOURCE_HASH_MISMATCH", "Downloaded original size does not match upload", 409, true);
    }
    if (video.clientSha256 && video.clientSha256 !== downloaded.sha256) {
      throw new AppError("SOURCE_HASH_MISMATCH", "Stored original does not match the client SHA-256", 409, true);
    }

    const metadata = await timed("probe", () => media.probe(sourcePath));
    const keys = objectKeys(payload.userId, video.id);
    const audioPath = join(workDir, "transcription.wav");
    await timed("audio", () => media.extractTranscriptionAudio(sourcePath, audioPath));
    const audioBytes = await readFile(audioPath);
    await Promise.all([
      storage.putObject(keys.audio, audioBytes, "audio/wav"),
      storage.putObject(
        keys.waveform,
        new TextEncoder().encode(JSON.stringify(waveformPeaksFromPcm16Wav(audioBytes))),
        "application/json",
      ),
    ]);

    const [current] = await db.select({ status: videos.status }).from(videos).where(eq(videos.id, video.id)).limit(1);
    if (current?.status === "ANALYZING" || current?.status === "UPLOADED") {
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
          audioStorageKey: keys.audio,
          pacingPreset: pacing,
          silenceThresholdMs: pacingSettings.minSilenceMs,
          preRollMs: pacingSettings.preRollMs,
          postRollMs: pacingSettings.postRollMs,
          progress: 30,
          progressMessage: "Transcribing",
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(videos.id, video.id));
    } else {
      await db
        .update(videos)
        .set({
          audioStorageKey: keys.audio,
          sourceSha256: downloaded.sha256,
          sizeBytes: downloaded.sizeBytes,
          updatedAt: new Date(),
        })
        .where(eq(videos.id, video.id));
    }

    await enqueueJob({
      videoId: video.id,
      userId: payload.userId,
      type: "TRANSCRIBE_VIDEO",
      inputVersion: downloaded.sha256,
    });
    await queue.publishProgress(video.id, { status: "TRANSCRIBING", progress: 30 });

    const posterPath = join(workDir, "poster.jpg");
    const proxyPath = join(workDir, "proxy.mp4");
    const filmstripPath = join(workDir, "filmstrip.jpg");
    const [keyframes] = await Promise.all([
      timed("keyframes", () => media.extractKeyframes(sourcePath)),
      timed("visuals", () => media.extractAnalysisVisuals(sourcePath, { posterPath, proxyPath, filmstripPath })),
    ]);
    await storage.putObject(keys.thumb, await readFile(posterPath), "image/jpeg");
    await storage.putObject(keys.proxy, await readFile(proxyPath), "video/mp4");
    await storage.putObject(keys.filmstrip, await readFile(filmstripPath), "image/jpeg");

    await db
      .update(videos)
      .set({
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
        filmstripStorageKey: keys.filmstrip,
        audioStorageKey: keys.audio,
        keyframeMs: keyframes,
        pacingPreset: pacing,
        silenceThresholdMs: pacingSettings.minSilenceMs,
        preRollMs: pacingSettings.preRollMs,
        postRollMs: pacingSettings.postRollMs,
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
    await queue.publishProgress(video.id, { progress: analysisProgress("done") });
    await finishJob(payload.jobId, "SUCCEEDED", { stageDurations });
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
      stageDurations,
    });
    throw error;
  } finally {
    stopHeartbeat();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
