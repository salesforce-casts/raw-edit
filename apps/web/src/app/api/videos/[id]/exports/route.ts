import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import {
  buildRenderPlan,
  EXPORT_PRESETS,
  getPreset,
  newId,
  planExport,
  toMetadataFromRow,
  type ExportPresetId,
} from '@rawedit/core';
import { idempotencyKey } from '@rawedit/queue';
import {
  editSettings,
  getActiveEdl,
  getEdlVersion,
  requireVideoForUser,
  setVideoStatus,
  upsertJob,
  videoExport,
} from '@rawedit/db';
import { db, queue } from '@/lib/container';
import { jsonError, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

const CreateExportSchema = z.object({
  preset: z.enum(EXPORT_PRESETS).default('ORIGINAL_QUALITY'),
});

/**
 * POST /api/videos/:id/exports — approve the edit and queue a render.
 *
 * Nothing is rendered here. The route validates, records an `export` row and
 * enqueues; the Railway worker does the encoding, so a request never holds a
 * connection open for an ffmpeg run.
 */
export const POST = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const database = db();

  const row = await requireVideoForUser(database, id, user.id);
  if (row.status === 'UPLOADING' || row.status === 'UPLOADED') {
    return jsonError('This video is still being processed.', 409, 'NOT_READY');
  }
  if (row.sourceDeletedAt) {
    return jsonError(
      'The original file was deleted under your retention policy, so it cannot be rendered again.',
      409,
      'SOURCE_DELETED',
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = CreateExportSchema.safeParse(body);
  if (!parsed.success) return jsonError('Invalid export preset.', 400, 'INVALID_REQUEST');
  const presetId: ExportPresetId = parsed.data.preset;

  const decisions = await getActiveEdl(database, id);
  const metadata = toMetadataFromRow(toStoredRow(row));

  const settingsRows = await database
    .select()
    .from(editSettings)
    .where(eq(editSettings.videoId, id))
    .limit(1);
  const settings = settingsRows[0];

  const plan = buildRenderPlan(decisions, {
    duration: metadata.duration,
    frameRate: metadata.video?.avgFrameRate ?? 30,
    minSegmentSeconds: settings?.minSegmentSeconds,
    mergeGapMs: settings?.mergeGapMs,
  });

  if (plan.outputDuration <= 0.2) {
    return jsonError(
      'Everything in this video is marked for removal, so there is nothing to render.',
      400,
      'EMPTY_EDIT',
    );
  }

  const summary = planExport(metadata, presetId, plan.outputDuration);
  const edlVersion = await getEdlVersion(database, id);

  // The key covers the edit and the preset, so approving the same edit twice is free
  // but changing one cut queues real work.
  const key = idempotencyKey('RENDER_VIDEO', id, `${edlVersion}:${presetId}`);

  // An identical render that already succeeded is returned rather than repeated.
  const existing = await database
    .select()
    .from(videoExport)
    .where(
      and(
        eq(videoExport.videoId, id),
        eq(videoExport.preset, presetId),
        eq(videoExport.edlVersion, edlVersion),
      ),
    )
    .orderBy(desc(videoExport.createdAt))
    .limit(1);

  const previous = existing[0];
  if (previous && (previous.status === 'COMPLETE' || previous.status === 'RENDERING' || previous.status === 'QUEUED')) {
    return NextResponse.json({ export: previous, reused: true, plan: summary });
  }

  const exportId = newId('exp');
  const [created] = await database
    .insert(videoExport)
    .values({
      id: exportId,
      videoId: id,
      userId: user.id,
      preset: presetId,
      strategy: summary.strategy,
      status: 'QUEUED',
      progress: 0,
      width: summary.width,
      height: summary.height,
      frameRate: summary.frameRate,
      videoCodec: summary.videoCodec,
      audioCodec: summary.audioCodec,
      container: summary.container,
      estimatedSize: summary.estimatedSize,
      duration: plan.outputDuration,
      edlVersion,
      warnings: summary.warnings,
    })
    .returning();

  await upsertJob(database, {
    videoId: id,
    userId: user.id,
    type: 'RENDER_VIDEO',
    idempotencyKey: key,
    payload: { videoId: id, userId: user.id, exportId, edlVersion },
  });

  await queue().enqueue(
    'RENDER_VIDEO',
    { videoId: id, userId: user.id, exportId, edlVersion },
    { idempotencyKey: key, userId: user.id },
  );

  await setVideoStatus(database, id, 'RENDERING', {
    progress: 0,
    statusDetail: 'Queued for rendering',
    errorMessage: null,
  });

  return NextResponse.json({ export: created, reused: false, plan: summary });
});

/**
 * GET /api/videos/:id/exports — existing exports, plus what each preset would
 * produce, so the UI can show resolution, codec and estimated size before rendering.
 */
export const GET = route(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const database = db();

  const row = await requireVideoForUser(database, id, user.id);
  const decisions = await getActiveEdl(database, id);
  const metadata = toMetadataFromRow(toStoredRow(row));
  const plan = buildRenderPlan(decisions, {
    duration: metadata.duration,
    frameRate: metadata.video?.avgFrameRate ?? 30,
  });

  const exports = await database
    .select()
    .from(videoExport)
    .where(and(eq(videoExport.videoId, id), eq(videoExport.userId, user.id)))
    .orderBy(desc(videoExport.createdAt));

  return NextResponse.json({
    exports,
    outputDuration: plan.outputDuration,
    presets: EXPORT_PRESETS.map((presetId) => ({
      ...getPreset(presetId),
      result: planExport(metadata, presetId, plan.outputDuration),
    })),
  });
});

/** Map the wide `video` row onto the shape `toMetadataFromRow` expects. */
function toStoredRow(row: Awaited<ReturnType<typeof requireVideoForUser>>) {
  return {
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
  };
}
