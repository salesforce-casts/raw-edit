import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { loadConfig } from "@raw-edit/config";
import { AppError, type EditSegment } from "@raw-edit/contracts";
import {
  getDb,
  detectedTakeGroups,
  detectedTakeSegments,
  editSegments,
  editVersions,
  transcriptSegments,
  transcripts,
  videos,
} from "@raw-edit/db";
import { createR2Storage } from "@raw-edit/storage";
import { getTakeJudge } from "@raw-edit/ai";
import {
  buildCoveringEdl,
  groupRetakeCandidates,
  parseSilencedetect,
  retakeRemovals,
  silenceRemovals,
} from "@raw-edit/video-core";
import type { QueueJobPayload } from "@raw-edit/queue";
import { ffmpeg } from "../ffmpeg/run";
import { claimJob, finishJob } from "./lock";

export async function processDetectAutomaticEdits(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId);
  if (!claimed || claimed.alreadyDone) return;
  const config = loadConfig();
  const workDir = join(config.scratchDir, payload.jobId);
  const db = getDb();
  try {
    await mkdir(workDir, { recursive: true });
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video) throw new AppError("NOT_FOUND", "Video missing", 404);
    const sourceKey = video.sourceStorageKey;
    if (!sourceKey) throw new AppError("SOURCE_MISSING", "Original missing", 404);
    const sourcePath = join(workDir, "original");
    await createR2Storage().downloadToFile(sourceKey, sourcePath);

    const silence = await ffmpeg([
      "-i",
      sourcePath,
      "-af",
      `silencedetect=noise=-35dB:d=${(video.silenceThresholdMs / 1000).toFixed(2)}`,
      "-f",
      "null",
      "-",
    ]).catch((error: Error) => ({ stdout: "", stderr: error.message }));
    const silenceRegions = parseSilencedetect(silence.stderr);
    const silenceCuts = silenceRemovals(silenceRegions, video.durationMs ?? 0, {
      minSilenceMs: video.silenceThresholdMs,
      preRollMs: video.preRollMs,
      postRollMs: video.postRollMs,
    });

    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.videoId, video.id)).limit(1);
    const rows = transcript
      ? await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcript.id))
      : [];
    const groups = groupRetakeCandidates(
      rows.map((row) => ({
        startMs: row.startMs,
        endMs: row.endMs,
        text: row.text,
        words: row.wordsJson ?? [],
      })),
    );
    const judge = getTakeJudge();
    const decisions = await Promise.all(groups.map((group) => judge.judge(group)));
    const retakes = retakeRemovals(groups, decisions);

    await db.delete(detectedTakeGroups).where(eq(detectedTakeGroups.videoId, video.id));
    for (const [index, group] of groups.entries()) {
      const [saved] = await db
        .insert(detectedTakeGroups)
        .values({
          videoId: video.id,
          similarityScore: group.similarityScore,
          confidence: decisions[index]?.confidence ?? group.confidence,
          reason: decisions[index]?.reason,
        })
        .returning();
      if (group.candidates.length > 0) {
        await db.insert(detectedTakeSegments).values(
          group.candidates.map((candidate) => ({
            takeGroupId: saved.id,
            startMs: candidate.startMs,
            endMs: candidate.endMs,
            text: candidate.text,
            completenessScore: candidate.completenessScore,
            fluencyScore: candidate.fluencyScore,
            semanticScore: candidate.semanticScore,
            isSelected: candidate.id === decisions[index]?.keepCandidateId,
          })),
        );
      }
    }

    const removals = [...silenceCuts, ...retakes] as Array<EditSegment & { action: "REMOVE" }>;
    const covering = buildCoveringEdl(video.durationMs ?? 0, removals);
    const existing = await db.select().from(editVersions).where(eq(editVersions.videoId, video.id));
    const nextNumber = existing.reduce((max, version) => Math.max(max, version.versionNumber), 0) + 1;
    await db.update(editVersions).set({ isCurrent: false }).where(eq(editVersions.videoId, video.id));
    const [version] = await db
      .insert(editVersions)
      .values({ videoId: video.id, versionNumber: nextNumber, createdBy: "system", isCurrent: true })
      .returning();
    if (covering.length > 0) {
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

    await db
      .update(videos)
      .set({
        status: "READY_FOR_REVIEW",
        progress: 100,
        progressMessage: "Ready for review",
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));
    await finishJob(payload.jobId, "COMPLETED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Detection failed";
    const code = error instanceof AppError ? error.code : "AI_ANALYSIS_FAILED";
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
