import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  buildRenderCommand,
  buildRenderPlan,
  PermanentError,
  StorageKeys,
  toMetadataFromRow,
  type MediaMetadata,
} from '@rawedit/core';
import {
  editSettings,
  getActiveEdl,
  recordUsage,
  setVideoStatus,
  video,
  videoExport,
} from '@rawedit/db';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { withScratchDir, type WorkerContext } from '../lib/context.js';
import type { JobTracker } from '../lib/job-tracker.js';

export interface RenderInput {
  videoId: string;
  userId: string;
  exportId: string;
  edlVersion: number;
}

/**
 * RENDER_VIDEO: read the approved EDL, build a render plan, run one ffmpeg pass over
 * the ORIGINAL master, upload the result.
 *
 * Progress is ffmpeg's own `out_time_us` against the planned output duration, so the
 * bar reflects encoded seconds rather than a timer.
 */
export async function handleRender(
  ctx: WorkerContext,
  tracker: JobTracker,
  input: RenderInput,
): Promise<void> {
  const { videoRow, exportRow } = await load(ctx, input);

  await ctx.db
    .update(videoExport)
    .set({ status: 'RENDERING', progress: 0, startedAt: new Date(), errorMessage: null })
    .where(eq(videoExport.id, input.exportId));

  await setVideoStatus(ctx.db, input.videoId, 'RENDERING', {
    progress: 0,
    statusDetail: 'Rendering',
    errorMessage: null,
  });

  await withScratchDir(`render-${input.exportId}`, async (dir) => {
    const metadata = toMetadata(videoRow);
    const decisions = await getActiveEdl(ctx.db, input.videoId);
    const settingsRows = await ctx.db
      .select()
      .from(editSettings)
      .where(eq(editSettings.videoId, input.videoId))
      .limit(1);
    const settings = settingsRows[0];

    const plan = buildRenderPlan(decisions, {
      duration: metadata.duration,
      frameRate: metadata.video?.avgFrameRate ?? 30,
      minSegmentSeconds: settings?.minSegmentSeconds,
      mergeGapMs: settings?.mergeGapMs,
    });

    if (plan.outputDuration <= 0.2) {
      throw new PermanentError(
        'Every part of this video is marked for removal, so there is nothing to render.',
        'EMPTY_EDIT',
      );
    }

    // The render always reads the original master, never the preview proxy.
    const sourceUrl = await ctx.storage.signDownloadUrl(videoRow.storageKey, env.sourceUrlTtlSeconds);
    const outputPath = join(dir, `${input.exportId}.mp4`);

    const command = buildRenderCommand({
      inputUrl: sourceUrl,
      outputPath,
      metadata,
      plan,
      presetId: exportRow.preset,
    });

    logger.info(
      {
        videoId: input.videoId,
        exportId: input.exportId,
        strategy: command.strategy,
        segments: plan.keepRanges.length,
        outputDuration: plan.outputDuration,
        resolution: `${command.plan.width}x${command.plan.height}`,
        codec: command.plan.videoCodec,
        warnings: command.warnings,
      },
      'Starting render',
    );

    // Record the exact invocation before running it, so a crashed render is still
    // reproducible from the database.
    await ctx.db
      .update(videoExport)
      .set({
        strategy: command.plan.strategy,
        width: command.plan.width,
        height: command.plan.height,
        frameRate: command.plan.frameRate,
        videoCodec: command.plan.videoCodec,
        audioCodec: command.plan.audioCodec,
        container: command.plan.container,
        estimatedSize: command.plan.estimatedSize,
        duration: plan.outputDuration,
        warnings: command.warnings,
        ffmpegCommand: `ffmpeg ${command.args.map(redactSignedUrl).join(' ')}`,
      })
      .where(eq(videoExport.id, input.exportId));

    // Encoding is 0-92%; the upload of the result is the rest.
    const result = await ctx.processor.render({
      command,
      onProgress: (fraction) => {
        const percent = Math.round(fraction * 92);
        void tracker.progress(percent, { stage: 'Rendering', status: 'RENDERING' });
        void ctx.db
          .update(videoExport)
          .set({ progress: percent })
          .where(eq(videoExport.id, input.exportId))
          .catch(() => undefined);
      },
    });

    await tracker.progress(92, { stage: 'Uploading', status: 'RENDERING' });

    const exportKey = StorageKeys.export(input.userId, input.videoId, input.exportId, 'mp4');
    const uploaded = await ctx.storage.uploadStream(
      exportKey,
      createReadStream(outputPath),
      'video/mp4',
      (bytes) => {
        const fraction = result.size > 0 ? bytes / result.size : 0;
        void tracker.progress(92 + Math.round(Math.min(1, fraction) * 7), {
          stage: 'Uploading',
          status: 'RENDERING',
        });
      },
    );

    await ctx.db
      .update(videoExport)
      .set({
        status: 'COMPLETE',
        progress: 100,
        storageKey: exportKey,
        fileSize: uploaded.size || result.size,
        duration: result.duration,
        renderLog: result.log.slice(0, 20_000),
        finishedAt: new Date(),
      })
      .where(eq(videoExport.id, input.exportId));

    await recordUsage(ctx.db, {
      userId: input.userId,
      videoId: input.videoId,
      kind: 'RENDERED_MINUTES',
      quantity: result.duration / 60,
      unit: 'minutes',
    });

    await setVideoStatus(ctx.db, input.videoId, 'COMPLETE', {
      progress: 100,
      statusDetail: null,
      errorMessage: null,
    });
    await tracker.progress(100, { stage: 'Complete', status: 'COMPLETE' });

    logger.info(
      { videoId: input.videoId, exportId: input.exportId, bytes: uploaded.size, duration: result.duration },
      'Render complete',
    );
  });
}

async function load(ctx: WorkerContext, input: RenderInput) {
  const videoRows = await ctx.db.select().from(video).where(eq(video.id, input.videoId)).limit(1);
  const videoRow = videoRows[0];
  if (!videoRow) throw new PermanentError('Video no longer exists', 'VIDEO_MISSING');
  if (videoRow.userId !== input.userId) throw new PermanentError('Video belongs to another user', 'FORBIDDEN');
  if (videoRow.sourceDeletedAt) {
    throw new PermanentError(
      'The original file was deleted under your retention policy, so it cannot be re-rendered.',
      'SOURCE_DELETED',
    );
  }

  const exportRows = await ctx.db
    .select()
    .from(videoExport)
    .where(eq(videoExport.id, input.exportId))
    .limit(1);
  const exportRow = exportRows[0];
  if (!exportRow) throw new PermanentError('Export record no longer exists', 'EXPORT_MISSING');
  if (exportRow.status === 'COMPLETE') {
    throw new PermanentError('This export has already been rendered', 'ALREADY_RENDERED');
  }

  return { videoRow, exportRow };
}

/** Rebuild the probe-shaped metadata the render planner needs from the video row. */
function toMetadata(row: typeof video.$inferSelect): MediaMetadata {
  return toMetadataFromRow({
    duration: row.duration ?? 0,
    width: row.width ?? 0,
    height: row.height ?? 0,
    rotation: row.rotation,
    frameRate: row.frameRate ?? 30,
    avgFrameRate: row.avgFrameRate ?? row.frameRate ?? 30,
    isVariableFrameRate: row.isVariableFrameRate,
    videoCodec: row.videoCodec,
    videoProfile: row.videoProfile,
    pixelFormat: row.pixelFormat,
    bitDepth: row.bitDepth,
    displayAspectRatio: row.displayAspectRatio,
    bitrate: row.bitrate,
    audioCodec: row.audioCodec,
    audioChannels: row.audioChannels,
    audioSampleRate: row.audioSampleRate,
    colorPrimaries: row.colorPrimaries,
    colorTransfer: row.colorTransfer,
    colorSpace: row.colorSpace,
    colorRange: row.colorRange,
    isHdr: row.isHdr,
    hdrFormat: row.hdrFormat,
    masterDisplay: row.masterDisplay,
    maxCll: row.maxCll,
    container: null,
    size: row.fileSize,
  });
}

/** Signed URLs carry credentials in the query string; never store one. */
function redactSignedUrl(arg: string): string {
  if (!/^https?:\/\//i.test(arg)) return arg;
  try {
    const url = new URL(arg);
    return `${url.origin}${url.pathname}?<signed>`;
  } catch {
    return '<url>';
  }
}
