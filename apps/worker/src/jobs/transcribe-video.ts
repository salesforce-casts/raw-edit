import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AppError, keepAllEdl } from "@raw-edit/core";
import { editSegments, editVersions, transcriptSegments, transcripts, usageRecords, videos } from "@raw-edit/db";
import type { QueueJobPayload } from "@raw-edit/queue";
import { getWorkerContext } from "../lib/context";
import { enqueueJob } from "../lib/enqueue";
import { claimJob, finishJob, startHeartbeat } from "./lock";

async function writeKeepAllEdl(videoId: string, durationMs: number) {
  const db = getWorkerContext().db;
  await db.update(editVersions).set({ isCurrent: false }).where(eq(editVersions.videoId, videoId));
  const [version] = await db
    .insert(editVersions)
    .values({ videoId, versionNumber: 1, createdBy: "system", isCurrent: true })
    .returning();
  const covering = keepAllEdl(durationMs);
  await db.insert(editSegments).values(
    covering.map((segment, index) => ({
      editVersionId: version.id,
      sequenceNumber: index,
      startMs: segment.startMs,
      endMs: segment.endMs,
      action: segment.action,
      source: segment.source ?? "SYSTEM",
      reason: segment.reason,
      confidence: segment.confidence,
    })),
  );
}

export async function processTranscribeVideo(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId, payload.idempotencyKey);
  if (!claimed || claimed.alreadyDone) return;
  const { config, db, storage, transcription, queue } = getWorkerContext();
  const workDir = join(config.scratchDir, payload.jobId);
  const stopHeartbeat = startHeartbeat(payload.jobId);
  try {
    await mkdir(workDir, { recursive: true });
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video) throw new AppError("NOT_FOUND", "Video missing", 404, true);

    if (!config.transcriptionApiKey && config.transcriptionProvider === "openai") {
      await writeKeepAllEdl(video.id, video.durationMs ?? 0);
      await db
        .update(videos)
        .set({
          status: "READY_FOR_REVIEW",
          progress: 100,
          progressMessage: "Ready for manual review (transcription not configured)",
          updatedAt: new Date(),
        })
        .where(eq(videos.id, video.id));
      await queue.publishProgress(video.id, { status: "READY_FOR_REVIEW", progress: 100 });
      await finishJob(payload.jobId, "SUCCEEDED");
      return;
    }

    if (!video.audioStorageKey) throw new AppError("SOURCE_MISSING", "Analysis audio missing", 404, true);
    const audioPath = join(workDir, "transcription.wav");
    await storage.downloadToFile(video.audioStorageKey, audioPath);
    const result = await transcription.transcribe({
      audioPath,
      videoId: video.id,
      jobId: payload.jobId,
      language: video.language ?? undefined,
    });

    await db.delete(transcripts).where(eq(transcripts.videoId, video.id));
    const [transcript] = await db
      .insert(transcripts)
      .values({
        videoId: video.id,
        provider: result.provider,
        model: result.model,
        language: result.language,
        fullText: result.fullText,
        durationMs: result.durationMs,
      })
      .returning();
    if (result.segments.length > 0) {
      await db.insert(transcriptSegments).values(
        result.segments.map((segment, index) => ({
          transcriptId: transcript.id,
          sequenceNumber: index,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          confidence: segment.confidence,
          wordsJson: segment.words,
        })),
      );
    }
    await db.insert(usageRecords).values({
      userId: payload.userId,
      videoId: video.id,
      type: "TRANSCRIPTION_SECONDS",
      quantity: Math.round((result.durationMs || video.durationMs || 0) / 1000),
      unit: "seconds",
    });
    await db
      .update(videos)
      .set({
        status: "DETECTING_TAKES",
        progress: 65,
        progressMessage: "Finding silence and retakes",
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));

    await enqueueJob({
      videoId: video.id,
      userId: payload.userId,
      type: "DETECT_AUTOMATIC_EDITS",
      inputVersion: `${video.sourceSha256 ?? payload.inputVersion ?? "source"}|${video.silenceThresholdMs}`,
    });
    await queue.publishProgress(video.id, { status: "DETECTING_TAKES", progress: 65 });
    await finishJob(payload.jobId, "SUCCEEDED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transcription failed";
    const code = error instanceof AppError ? error.code : "TRANSCRIPTION_FAILED";
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
