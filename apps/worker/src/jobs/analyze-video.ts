import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { loadConfig } from "@raw-edit/config";
import { AppError } from "@raw-edit/contracts";
import { getDb, usageRecords, videos } from "@raw-edit/db";
import { createR2Storage, objectKeys } from "@raw-edit/storage";
import { parseFfprobe, analysisProgress } from "@raw-edit/video-core";
import type { QueueJobPayload } from "@raw-edit/queue";
import { createBullmqQueue, queueNameForJob } from "@raw-edit/queue";
import { ffmpeg, ffprobe } from "../ffmpeg/run";
import { claimJob, finishJob } from "./lock";

export async function processAnalyzeVideo(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId);
  if (!claimed || claimed.alreadyDone) return;
  const config = loadConfig();
  const workDir = join(config.scratchDir, payload.jobId);
  const db = getDb();
  const storage = createR2Storage();
  try {
    await mkdir(workDir, { recursive: true });
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video?.sourceStorageKey) throw new AppError("SOURCE_MISSING", "Original object key missing", 404);

    await db
      .update(videos)
      .set({ status: "ANALYZING", progress: analysisProgress("probe"), progressMessage: "Reading source metadata", updatedAt: new Date() })
      .where(eq(videos.id, video.id));

    const sourcePath = join(workDir, "original");
    const downloaded = await storage.downloadToFile(video.sourceStorageKey, sourcePath);
    if (video.sizeBytes && downloaded.sizeBytes !== video.sizeBytes) {
      throw new AppError("SOURCE_HASH_MISMATCH", "Downloaded original size does not match upload", 409);
    }

    const probe = await ffprobe([
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-print_format",
      "json",
      sourcePath,
    ]);
    const metadata = parseFfprobe(JSON.parse(probe.stdout));

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
        progress: analysisProgress("hash"),
        progressMessage: "Hashed original master",
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));

    const keys = objectKeys(payload.userId, video.id);
    const posterPath = join(workDir, "poster.jpg");
    await ffmpeg(["-y", "-i", sourcePath, "-frames:v", "1", "-q:v", "3", posterPath]);
    const poster = await import("node:fs/promises").then((fs) => fs.readFile(posterPath));
    await storage.putObject(keys.thumb, poster, "image/jpeg");

    await db
      .update(videos)
      .set({
        thumbStorageKey: keys.thumb,
        progress: analysisProgress("poster"),
        progressMessage: "Poster generated",
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));

    const proxyPath = join(workDir, "proxy.mp4");
    await ffmpeg([
      "-y",
      "-i",
      sourcePath,
      "-vf",
      "scale='min(1280,iw)':-2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      "2500k",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      proxyPath,
    ]);
    const proxyBytes = await import("node:fs/promises").then((fs) => fs.readFile(proxyPath));
    await storage.putObject(keys.proxy, proxyBytes, "video/mp4");

    const audioPath = join(workDir, "transcription.wav");
    await ffmpeg(["-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath]);
    const audioBytes = await import("node:fs/promises").then((fs) => fs.readFile(audioPath));
    await storage.putObject(keys.audio, audioBytes, "audio/wav");

    await db
      .update(videos)
      .set({
        proxyStorageKey: keys.proxy,
        audioStorageKey: keys.audio,
        progress: analysisProgress("done"),
        progressMessage: "Analysis complete",
        status: "TRANSCRIBING",
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

    const queue = createBullmqQueue();
    const [next] = await db
      .insert((await import("@raw-edit/db")).processingJobs)
      .values({ videoId: video.id, type: "TRANSCRIBE_VIDEO", status: "QUEUED", payload: { userId: payload.userId } })
      .returning();
    const bullmqJobId = await queue.enqueue(queueNameForJob("TRANSCRIBE_VIDEO"), {
      jobId: next.id,
      videoId: video.id,
      userId: payload.userId,
      type: "TRANSCRIBE_VIDEO",
    });
    await db
      .update((await import("@raw-edit/db")).processingJobs)
      .set({ bullmqJobId })
      .where(eq((await import("@raw-edit/db")).processingJobs.id, next.id));

    await finishJob(payload.jobId, "COMPLETED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analyze failed";
    const code = error instanceof AppError ? error.code : "FFPROBE_FAILED";
    await getDb()
      .update(videos)
      .set({ status: "FAILED", errorCode: code, errorMessage: message, updatedAt: new Date() })
      .where(eq(videos.id, payload.videoId));
    await finishJob(payload.jobId, "FAILED", { errorCode: code, errorMessage: message });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
