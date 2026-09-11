import { asc, eq } from "drizzle-orm";
import {
  AppError,
  SCRIPT_PASS_PROMPT_VERSION,
  acousticMinSilenceSeconds,
  applyScriptPassGuards,
  buildCoveringEdl,
  dualSignalSilenceRemovals,
  deriveRetakeUtterances,
  fillerRemovals,
  flattenWords,
  groupRetakeCandidates,
  overlayUnappliedProposals,
  retakeRemovals,
  scriptPassCacheKey,
  snapSegmentBounds,
  wordBoundaryMs,
  type PacingPreset,
  type ScriptPassDecision,
} from "@raw-edit/core";
import { runScriptPass } from "@raw-edit/ai";
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

function isPacing(value: string | null | undefined): PacingPreset {
  return value === "tight" || value === "very_tight" ? value : "natural";
}

export async function processDetectAutomaticEdits(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId, payload.idempotencyKey);
  if (!claimed || claimed.alreadyDone) return;
  const { config, db, storage, media, takeJudge, queue } = getWorkerContext();
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
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video?.sourceStorageKey) throw new AppError("SOURCE_MISSING", "Original missing", 404, true);
    const analysisStorageKey = video.audioStorageKey ?? video.sourceStorageKey;
    const analysisUrl = await storage.signGet(analysisStorageKey, config.sourceUrlTtlSeconds);
    const acoustic = await timed("silence", () => media.detectSilence(analysisUrl, acousticMinSilenceSeconds()));

    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.videoId, video.id)).limit(1);
    const rows = transcript
      ? await db
          .select()
          .from(transcriptSegments)
          .where(eq(transcriptSegments.transcriptId, transcript.id))
          .orderBy(asc(transcriptSegments.sequenceNumber))
      : [];
    const timedRows = rows
      .map((row) => ({
        startMs: row.startMs,
        endMs: row.endMs,
        text: row.text,
        words: [...(row.wordsJson ?? [])].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
      }))
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const words = flattenWords(timedRows);
    const pacing = isPacing(video.pacingPreset);
    const silenceCuts = dualSignalSilenceRemovals(acoustic, timedRows, video.durationMs ?? 0, pacing);
    const groups = groupRetakeCandidates(deriveRetakeUtterances(timedRows));
    const decisions = await Promise.all(groups.map((group) => takeJudge.judge(group)));
    const retakes = retakeRemovals(groups, decisions);
    const fillers = fillerRemovals(timedRows, video.removeFillers);

    const model = process.env.AI_MODEL ?? "gpt-5.4-mini";
    const cacheKey = scriptPassCacheKey({
      words,
      promptVersion: SCRIPT_PASS_PROMPT_VERSION,
      model,
    });
    const previous = await db.select().from(editVersions).where(eq(editVersions.videoId, video.id));
    const cached = previous.find(
      (version) =>
        version.scriptPassCacheKey === cacheKey &&
        Array.isArray(version.scriptPassDecisions) &&
        version.scriptPassDecisions.length > 0,
    );
    let rawDecisions: Partial<ScriptPassDecision>[] = Array.isArray(cached?.scriptPassDecisions)
      ? (cached?.scriptPassDecisions as Partial<ScriptPassDecision>[])
      : [];
    let scriptPassStatusWarning: string | undefined;
    if (!cached) {
      const ran = await timed("scriptPass", () => runScriptPass(timedRows));
      rawDecisions = ran.decisions;
      if (ran.status !== "success") {
        scriptPassStatusWarning =
          ran.status === "disabled"
            ? "AI script cleanup is disabled; deterministic take detection was used."
            : `AI script cleanup failed; deterministic take detection was used. ${ran.error ?? ""}`.trim();
      }
    }
    const guarded = applyScriptPassGuards(rawDecisions, words, video.durationMs ?? 0);
    const scriptPassWarning = [scriptPassStatusWarning, guarded.warning].filter(Boolean).join(" ") || undefined;
    const snapTargets = {
      wordBoundaryMs: wordBoundaryMs(words),
      keyframeMs: video.keyframeMs ?? [],
      silentGaps: acoustic,
    };
    const scriptCuts = guarded.applied.map((segment) => snapSegmentBounds(segment, snapTargets));
    const silenceSnapped = silenceCuts.map((segment) => snapSegmentBounds(segment, snapTargets));

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

    const covering = overlayUnappliedProposals(
      buildCoveringEdl(
        video.durationMs ?? 0,
        [...retakes, ...silenceSnapped, ...fillers, ...scriptCuts].map((segment) => ({ ...segment, action: "REMOVE" as const })),
      ),
      guarded.unapplied,
    );
    const existing = previous;
    const nextNumber = existing.reduce((max, version) => Math.max(max, version.versionNumber), 0) + 1;
    await db.update(editVersions).set({ isCurrent: false }).where(eq(editVersions.videoId, video.id));
    const [version] = await db
      .insert(editVersions)
      .values({
        videoId: video.id,
        versionNumber: nextNumber,
        createdBy: "system",
        isCurrent: true,
        promptVersion: SCRIPT_PASS_PROMPT_VERSION,
        scriptPassModel: model,
        scriptPassCacheKey: rawDecisions.length > 0 ? cacheKey : null,
        scriptPassDecisions: rawDecisions,
      })
      .returning();
    if (covering.length > 0) {
      await db.insert(editSegments).values(
        covering.map((segment, index) => ({
          editVersionId: version.id,
          sequenceNumber: index,
          startMs: Math.round(segment.startMs),
          endMs: Math.round(segment.endMs),
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
        progressMessage: scriptPassWarning ?? "Ready for review",
        scriptPassWarning: scriptPassWarning ?? null,
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));
    await queue.publishProgress(video.id, {
      status: "READY_FOR_REVIEW",
      progress: 100,
      scriptPassWarning: scriptPassWarning ?? null,
    });
    await finishJob(payload.jobId, "SUCCEEDED", { stageDurations });
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
      stageDurations,
    });
    throw error;
  } finally {
    stopHeartbeat();
  }
}
