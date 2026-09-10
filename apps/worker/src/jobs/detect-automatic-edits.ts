import { eq } from "drizzle-orm";
import {
  AppError,
  buildCoveringEdl,
  dualSignalSilenceRemovals,
  fillerRemovals,
  groupRetakeCandidates,
  retakeRemovals,
} from "@raw-edit/core";
import {
  detectedTakeGroups,
  detectedTakeSegments,
  editOverrides,
  editSegments,
  editVersions,
  transcriptSegments,
  transcripts,
  videos,
} from "@raw-edit/db";
import type { QueueJobPayload } from "@raw-edit/queue";
import { getWorkerContext } from "../lib/context";
import { claimJob, finishJob, startHeartbeat } from "./lock";

export async function processDetectAutomaticEdits(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId, payload.idempotencyKey);
  if (!claimed || claimed.alreadyDone) return;
  const { config, db, storage, media, takeJudge, queue } = getWorkerContext();
  const stopHeartbeat = startHeartbeat(payload.jobId);
  try {
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video?.sourceStorageKey) throw new AppError("SOURCE_MISSING", "Original missing", 404, true);
    const sourceUrl = await storage.signGet(video.sourceStorageKey, config.sourceUrlTtlSeconds);
    const acoustic = await media.detectSilence(sourceUrl, video.silenceThresholdMs / 1000);

    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.videoId, video.id)).limit(1);
    const rows = transcript
      ? await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcript.id))
      : [];
    const timed = rows.map((row) => ({
      startMs: row.startMs,
      endMs: row.endMs,
      text: row.text,
      words: row.wordsJson ?? [],
    }));
    const silenceCuts = dualSignalSilenceRemovals(acoustic, timed, video.durationMs ?? 0, {
      minSilenceMs: video.silenceThresholdMs,
      preRollMs: video.preRollMs,
      postRollMs: video.postRollMs,
    });
    const groups = groupRetakeCandidates(timed);
    const decisions = await Promise.all(groups.map((group) => takeJudge.judge(group)));
    const retakes = retakeRemovals(groups, decisions);
    const fillers = fillerRemovals(timed, video.removeFillers);

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

    const covering = buildCoveringEdl(
      video.durationMs ?? 0,
      [...retakes, ...silenceCuts, ...fillers].map((segment) => ({ ...segment, action: "REMOVE" as const })),
    );
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
    await db.delete(editOverrides).where(eq(editOverrides.videoId, video.id));

    await db
      .update(videos)
      .set({
        status: "READY_FOR_REVIEW",
        progress: 100,
        progressMessage: "Ready for review",
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));
    await queue.publishProgress(video.id, { status: "READY_FOR_REVIEW", progress: 100 });
    await finishJob(payload.jobId, "SUCCEEDED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Detection failed";
    const code = error instanceof AppError ? error.code : "AI_ANALYSIS_FAILED";
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
  }
}
