import { mkdir, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { AppError, applyOverrides, estimatedOutputDurationMs, renderProgress } from "@raw-edit/core";
import { editOverrides, editSegments, editVersions, exports, usageRecords, videos } from "@raw-edit/db";
import { objectKeys } from "@raw-edit/storage";
import type { QueueJobPayload } from "@raw-edit/queue";
import { getWorkerContext } from "../lib/context";
import { claimJob, finishJob, startHeartbeat } from "./lock";

export async function processRenderExport(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId, payload.idempotencyKey);
  if (!claimed || claimed.alreadyDone) return;
  const { config, db, storage, media, queue } = getWorkerContext();
  const workDir = join(config.scratchDir, payload.jobId);
  const exportId = payload.exportId ?? String(claimed.job.payload.exportId ?? "");
  const stopHeartbeat = startHeartbeat(payload.jobId);
  try {
    await mkdir(workDir, { recursive: true });
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    const [record] = await db.select().from(exports).where(eq(exports.id, exportId)).limit(1);
    if (!video || !record) throw new AppError("NOT_FOUND", "Export target missing", 404, true);
    if (!video.sourceStorageKey) throw new AppError("SOURCE_MISSING", "Original master missing", 404, true);

    const storageKey = record.storageKey ?? objectKeys(payload.userId, video.id).export(record.id);
    await db
      .update(videos)
      .set({ status: "RENDERING", progress: 0, progressMessage: "Rendering from original master", updatedAt: new Date() })
      .where(eq(videos.id, video.id));
    await db.update(exports).set({ status: "RENDERING", storageKey, progress: 0 }).where(eq(exports.id, record.id));

    const sourceUrl = await storage.signGet(video.sourceStorageKey, config.sourceUrlTtlSeconds);
    const metadata = await media.probe(sourceUrl);
    const [version] = await db
      .select()
      .from(editVersions)
      .where(and(eq(editVersions.videoId, video.id), eq(editVersions.isCurrent, true)))
      .limit(1);
    if (!version) throw new AppError("NOT_FOUND", "No current edit version", 404, true);
    const autoSegments = await db
      .select()
      .from(editSegments)
      .where(eq(editSegments.editVersionId, version.id))
      .orderBy(asc(editSegments.sequenceNumber));
    const overrides = await db
      .select()
      .from(editOverrides)
      .where(eq(editOverrides.videoId, video.id))
      .orderBy(asc(editOverrides.sequenceNumber));
    const segments = applyOverrides(
      autoSegments.map((row) => ({
        startMs: row.startMs,
        endMs: row.endMs,
        action: row.action,
        source: row.source,
        reason: row.reason ?? undefined,
        confidence: row.confidence ?? undefined,
      })),
      overrides.map((row) => ({
        startMs: row.startMs,
        endMs: row.endMs,
        action: row.action,
        reason: row.reason ?? undefined,
      })),
    );

    const filterPath = join(workDir, "filter.txt");
    const outputPath = join(workDir, "render.mp4");
    const expectedMs = estimatedOutputDurationMs(segments);
    await media.render({
      sourceUrlOrPath: sourceUrl,
      segments,
      metadata,
      preset: record.preset,
      strategy: record.strategy,
      filterScriptPath: filterPath,
      outputPath,
      workDir,
      keyframeMs: video.keyframeMs ?? [],
      onProgress: (outTimeMs) => {
        const progress = renderProgress(outTimeMs, expectedMs);
        void (async () => {
          await Promise.all([
            db.update(exports).set({ progress }).where(eq(exports.id, record.id)),
            db.update(videos).set({ progress, updatedAt: new Date() }).where(eq(videos.id, video.id)),
            queue.publishProgress(video.id, { status: "RENDERING", progress }),
          ]);
        })().catch(() => undefined);
      },
    });

    const output = await readFile(outputPath);
    const outputStat = await stat(outputPath);
    if (outputStat.size * 2 > config.scratchSafetyBytes) {
      throw new AppError("SCRATCH_SPACE_EXCEEDED", "Not enough worker scratch space to render safely", 507);
    }
    await storage.putObject(storageKey, output, "video/mp4");
    const outMeta = await media.probe(outputPath);

    await db
      .update(exports)
      .set({
        status: "COMPLETE",
        storageKey,
        sizeBytes: output.byteLength,
        durationMs: outMeta.durationMs,
        width: outMeta.width ?? video.width,
        height: outMeta.height ?? video.height,
        fpsNum: outMeta.fpsNum ?? video.fpsNum,
        fpsDen: outMeta.fpsDen ?? video.fpsDen,
        videoCodec: outMeta.videoCodec,
        audioCodec: outMeta.audioCodec,
        progress: 100,
        completedAt: new Date(),
      })
      .where(eq(exports.id, record.id));
    await db
      .update(videos)
      .set({ status: "COMPLETE", progress: 100, progressMessage: "Export ready", updatedAt: new Date() })
      .where(eq(videos.id, video.id));
    await db.insert(usageRecords).values({
      userId: payload.userId,
      videoId: video.id,
      type: "RENDER_SECONDS",
      quantity: Math.round((outMeta.durationMs ?? 0) / 1000),
      unit: "seconds",
    });
    await queue.publishProgress(video.id, { status: "COMPLETE", progress: 100 });
    await finishJob(payload.jobId, "SUCCEEDED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Render failed";
    const code = error instanceof AppError ? error.code : "RENDER_FAILED";
    const permanent = error instanceof AppError ? error.permanent : false;
    if (exportId) {
      await getWorkerContext()
        .db.update(exports)
        .set({ status: "FAILED", errorMessage: message })
        .where(eq(exports.id, exportId));
    }
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
