import { asc, eq } from "drizzle-orm";
import {
  AppError,
  CANONICAL_SCRIPT_PROMPT_VERSION,
  acousticMinSilenceSeconds,
  buildCoveringEdl,
  compileCanonicalScript,
  dualSignalSilenceRemovals,
  deriveRetakeUtterances,
  flattenWords,
  groupRetakeCandidates,
  isCanonicalScriptPlan,
  scriptPassCacheKey,
  snapSegmentBounds,
  wordBoundaryMs,
  type PacingPreset,
  type CanonicalScriptPlan,
} from "@raw-edit/core";
import { runCanonicalScriptPass } from "@raw-edit/ai";
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
  const { config, db, storage, media, queue } = getWorkerContext();
  const stopHeartbeat = startHeartbeat(payload.jobId);
  const stageDurations: Record<string, number> = {};
  async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    console.info(
      JSON.stringify({
        service: "worker",
        event: "edit_detection.stage_started",
        videoId: payload.videoId,
        jobId: payload.jobId,
        stage: name,
      }),
    );
    try {
      return await work();
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "worker",
          event: "edit_detection.stage_failed",
          videoId: payload.videoId,
          jobId: payload.jobId,
          stage: name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    } finally {
      stageDurations[name] = Date.now() - started;
      console.info(
        JSON.stringify({
          service: "worker",
          event: "edit_detection.stage_finished",
          videoId: payload.videoId,
          jobId: payload.jobId,
          stage: name,
          durationMs: stageDurations[name],
        }),
      );
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

    const model = process.env.AI_MODEL ?? "gpt-5.4-mini";
    const cacheKey = scriptPassCacheKey({
      words,
      promptVersion: CANONICAL_SCRIPT_PROMPT_VERSION,
      model,
    });
    const previous = await db.select().from(editVersions).where(eq(editVersions.videoId, video.id));
    const cached = previous.find(
      (version) =>
        version.scriptPassCacheKey === cacheKey &&
        isCanonicalScriptPlan(version.scriptPassDecisions),
    );
    let canonicalPlan: CanonicalScriptPlan = isCanonicalScriptPlan(cached?.scriptPassDecisions)
      ? cached.scriptPassDecisions
      : {
          version: CANONICAL_SCRIPT_PROMPT_VERSION,
          keepSpans: [],
          restoreSpans: [],
        };
    let scriptPassStatusWarning: string | undefined;
    if (!cached) {
      const ran = await timed("canonicalScript", () => runCanonicalScriptPass(timedRows));
      canonicalPlan = ran.plan;
      console.info(
        JSON.stringify({
          service: "worker",
          event: "edit_detection.canonical_plan",
          videoId: payload.videoId,
          jobId: payload.jobId,
          status: ran.status,
          model: ran.model,
          keepSpanCount: canonicalPlan.keepSpans.length,
          restoreSpanCount: canonicalPlan.restoreSpans.length,
          cleanedClipCount: canonicalPlan.cleanedClips?.length ?? 0,
          cleanedWordCount: canonicalPlan.cleanedScript?.trim().split(/\s+/).filter(Boolean).length ?? 0,
          alignmentCoverage: canonicalPlan.alignmentCoverage,
        }),
      );
      if (ran.status !== "success") {
        scriptPassStatusWarning =
          ran.status === "disabled"
            ? "Canonical script selection is disabled, so all speech was kept."
            : `Canonical script selection failed, so all speech was kept. ${ran.error ?? ""}`.trim();
      }
    }
    const compiled = compileCanonicalScript(canonicalPlan, words, video.durationMs ?? 0, {
      preRollMs: video.preRollMs,
      postRollMs: video.postRollMs,
    });
    const scriptPassWarning = [scriptPassStatusWarning, compiled.warning].filter(Boolean).join(" ") || undefined;
    const snapTargets = {
      wordBoundaryMs: wordBoundaryMs(words),
      keyframeMs: video.keyframeMs ?? [],
      silentGaps: acoustic,
    };
    const silenceSnapped = silenceCuts.map((segment) => snapSegmentBounds(segment, snapTargets));

    await db.delete(detectedTakeGroups).where(eq(detectedTakeGroups.videoId, video.id));
    for (const group of groups) {
      const selectedCandidate = [...group.candidates]
        .map((candidate) => ({
          candidate,
          overlapMs: compiled.keptSourceRanges.reduce(
            (sum, range) => sum + Math.max(0, Math.min(candidate.endMs, range.endMs) - Math.max(candidate.startMs, range.startMs)),
            0,
          ),
        }))
        .sort((left, right) => right.overlapMs - left.overlapMs)[0];
      const [saved] = await db
        .insert(detectedTakeGroups)
        .values({
          videoId: video.id,
          similarityScore: group.similarityScore,
          confidence: group.confidence,
          reason: canonicalPlan.summary ?? "Selected by the source-linked canonical script",
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
            isSelected: selectedCandidate?.overlapMs > 0 && candidate.id === selectedCandidate.candidate.id,
          })),
        );
      }
    }

    const covering = buildCoveringEdl(
      video.durationMs ?? 0,
      [...silenceSnapped, ...compiled.removals].map((segment) => ({ ...segment, action: "REMOVE" as const })),
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
        promptVersion: CANONICAL_SCRIPT_PROMPT_VERSION,
        scriptPassModel: model,
        scriptPassCacheKey: canonicalPlan.keepSpans.length > 0 ? cacheKey : null,
        scriptPassDecisions: canonicalPlan,
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
    console.info(
      JSON.stringify({
        service: "worker",
        event: "edit_detection.completed",
        videoId: payload.videoId,
        jobId: payload.jobId,
        promptVersion: CANONICAL_SCRIPT_PROMPT_VERSION,
        editVersion: nextNumber,
        keepSpanCount: canonicalPlan.keepSpans.length,
        keptDurationMs: covering
          .filter((segment) => segment.action === "KEEP")
          .reduce((total, segment) => total + segment.endMs - segment.startMs, 0),
      }),
    );
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
