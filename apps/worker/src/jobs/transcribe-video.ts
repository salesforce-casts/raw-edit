import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { loadConfig } from "@raw-edit/config";
import { AppError } from "@raw-edit/contracts";
import { getDb, editSegments, editVersions, transcriptSegments, transcripts, usageRecords, videos } from "@raw-edit/db";
import { createR2Storage } from "@raw-edit/storage";
import { getTranscriptionProvider } from "@raw-edit/transcription";
import { createBullmqQueue, queueNameForJob, type QueueJobPayload } from "@raw-edit/queue";
import { claimJob, finishJob } from "./lock";

async function writeKeepAllEdl(videoId: string, durationMs: number) {
  const db = getDb();
  await db.update(editVersions).set({ isCurrent: false }).where(eq(editVersions.videoId, videoId));
  const [version] = await db
    .insert(editVersions)
    .values({ videoId, versionNumber: 1, createdBy: "system", isCurrent: true })
    .returning();
  await db.insert(editSegments).values({
    editVersionId: version.id,
    sequenceNumber: 0,
    startMs: 0,
    endMs: durationMs,
    action: "KEEP",
    source: "SYSTEM",
    reason: "Full timeline kept until automatic detection runs",
    confidence: 1,
  });
}

export async function processTranscribeVideo(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId);
  if (!claimed || claimed.alreadyDone) return;
  const config = loadConfig();
  const workDir = join(config.scratchDir, payload.jobId);
  const db = getDb();
  try {
    await mkdir(workDir, { recursive: true });
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video) throw new AppError("NOT_FOUND", "Video missing", 404);

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
      await finishJob(payload.jobId, "COMPLETED");
      return;
    }

    if (!video.audioStorageKey) throw new AppError("SOURCE_MISSING", "Analysis audio missing", 404);
    const audioPath = join(workDir, "transcription.wav");
    await createR2Storage().downloadToFile(video.audioStorageKey, audioPath);
    const result = await getTranscriptionProvider().transcribe({
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
        status: "DETECTING_EDITS",
        progress: 65,
        progressMessage: "Finding silence and retakes",
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));

    const queue = createBullmqQueue();
    const [next] = await db
      .insert((await import("@raw-edit/db")).processingJobs)
      .values({ videoId: video.id, type: "DETECT_AUTOMATIC_EDITS", status: "QUEUED", payload: { userId: payload.userId } })
      .returning();
    const bullmqJobId = await queue.enqueue(queueNameForJob("DETECT_AUTOMATIC_EDITS"), {
      jobId: next.id,
      videoId: video.id,
      userId: payload.userId,
      type: "DETECT_AUTOMATIC_EDITS",
    });
    await db
      .update((await import("@raw-edit/db")).processingJobs)
      .set({ bullmqJobId })
      .where(eq((await import("@raw-edit/db")).processingJobs.id, next.id));
    await finishJob(payload.jobId, "COMPLETED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transcription failed";
    const code = error instanceof AppError ? error.code : "TRANSCRIPTION_FAILED";
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
