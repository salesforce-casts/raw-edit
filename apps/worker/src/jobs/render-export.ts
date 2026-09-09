import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { loadConfig } from "@raw-edit/config";
import { AppError } from "@raw-edit/contracts";
import { getDb, editSegments, editVersions, exports, usageRecords, videos } from "@raw-edit/db";
import { createR2Storage, objectKeys } from "@raw-edit/storage";
import {
  buildRenderPlan,
  estimatedOutputDurationMs,
  parseFfprobe,
  parseFfmpegProgress,
  renderProgress,
} from "@raw-edit/video-core";
import type { QueueJobPayload } from "@raw-edit/queue";
import { ffmpeg, ffprobe } from "../ffmpeg/run";
import { claimJob, finishJob } from "./lock";

export async function processRenderExport(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId);
  if (!claimed || claimed.alreadyDone) return;
  const config = loadConfig();
  const workDir = join(config.scratchDir, payload.jobId);
  const db = getDb();
  const exportId = payload.exportId ?? String(claimed.job.payload.exportId ?? "");
  try {
    await mkdir(workDir, { recursive: true });
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    const [record] = await db.select().from(exports).where(eq(exports.id, exportId)).limit(1);
    if (!video || !record) throw new AppError("NOT_FOUND", "Export target missing", 404);
    if (!video.sourceStorageKey) throw new AppError("SOURCE_MISSING", "Original master missing", 404);

    const storageKey = record.storageKey ?? objectKeys(payload.userId, video.id).export(record.id);
    await db
      .update(videos)
      .set({ status: "RENDERING", progress: 0, progressMessage: "Rendering from original master", updatedAt: new Date() })
      .where(eq(videos.id, video.id));
    await db.update(exports).set({ status: "RENDERING", storageKey, progress: 0 }).where(eq(exports.id, record.id));

    const sourcePath = join(workDir, "original");
    await createR2Storage().downloadToFile(video.sourceStorageKey, sourcePath);
    const sourceStat = await stat(sourcePath);
    if (sourceStat.size * 2 > config.scratchSafetyBytes) {
      throw new AppError("SCRATCH_SPACE_EXCEEDED", "Not enough worker scratch space to render safely", 507);
    }

    const [version] = await db
      .select()
      .from(editVersions)
      .where(and(eq(editVersions.videoId, video.id), eq(editVersions.isCurrent, true)))
      .limit(1);
    if (!version) throw new AppError("NOT_FOUND", "No current edit version", 404);
    const segments = await db
      .select()
      .from(editSegments)
      .where(eq(editSegments.editVersionId, version.id))
      .orderBy(asc(editSegments.sequenceNumber));

    const probe = await ffprobe(["-v", "error", "-show_format", "-show_streams", "-print_format", "json", sourcePath]);
    const metadata = parseFfprobe(JSON.parse(probe.stdout));
    const filterPath = join(workDir, "filter.txt");
    const outputPath = join(workDir, "render.mp4");
    const plan = buildRenderPlan({
      segments,
      metadata,
      preset: record.preset,
      strategy: record.strategy,
      filterScriptPath: filterPath,
      outputPath,
    });
    await writeFile(filterPath, plan.filterScript, "utf8");
    const expectedMs = estimatedOutputDurationMs(segments);
    const args = plan.args.map((arg) => (arg === "INPUT_PLACEHOLDER" ? sourcePath : arg));
    await ffmpeg(args, (chunk) => {
      const { outTimeMs } = parseFfmpegProgress(chunk);
      if (outTimeMs == null) return;
      const progress = renderProgress(outTimeMs, expectedMs);
      void db.update(exports).set({ progress }).where(eq(exports.id, record.id));
      void db.update(videos).set({ progress, updatedAt: new Date() }).where(eq(videos.id, video.id));
    });

    const output = await import("node:fs/promises").then((fs) => fs.readFile(outputPath));
    await createR2Storage().putObject(storageKey, output, "video/mp4");
    const outProbe = await ffprobe(["-v", "error", "-show_format", "-show_streams", "-print_format", "json", outputPath]);
    const outMeta = parseFfprobe(JSON.parse(outProbe.stdout));

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
        videoCodec: plan.videoCodec,
        audioCodec: plan.audioCodec,
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
    await finishJob(payload.jobId, "COMPLETED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Render failed";
    const code = error instanceof AppError ? error.code : "RENDER_FAILED";
    if (exportId) {
      await getDb()
        .update(exports)
        .set({ status: "FAILED", errorMessage: message })
        .where(eq(exports.id, exportId));
    }
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
