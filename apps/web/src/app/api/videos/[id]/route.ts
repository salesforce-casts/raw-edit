import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import {
  getActiveEdl,
  getTakesWithMembers,
  getTranscriptWithSegments,
  requireVideoForUser,
  video,
  videoExport,
} from '@rawedit/db';
import { StorageKeys, summarizeEdl } from '@rawedit/core';
import { URL_TTL, db, storage } from '@/lib/container';
import { requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

/**
 * GET /api/videos/:id — everything the review screen needs, in one round trip.
 *
 * Playback prefers the 720p proxy so the review screen is usable on cellular; the
 * original is offered alongside it, and rendering always reads the original
 * regardless of what the player is showing.
 */
export const GET = route(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const database = db();

  const row = await requireVideoForUser(database, id, user.id);
  const [decisions, takes, transcriptData, exports] = await Promise.all([
    getActiveEdl(database, id),
    getTakesWithMembers(database, id),
    getTranscriptWithSegments(database, id),
    database
      .select()
      .from(videoExport)
      .where(and(eq(videoExport.videoId, id), eq(videoExport.userId, user.id))),
  ]);

  const sign = async (key: string | null) =>
    key ? storage().signDownloadUrl(key, URL_TTL.playback) : null;

  const [proxyUrl, originalUrl, thumbnailUrl, waveformUrl] = await Promise.all([
    sign(row.proxyKey),
    row.sourceDeletedAt ? null : sign(row.storageKey),
    sign(row.thumbnailKey),
    sign(row.waveformKey),
  ]);

  return NextResponse.json({
    video: {
      ...row,
      probeJson: undefined,
      playbackUrl: proxyUrl ?? originalUrl,
      usingProxy: Boolean(proxyUrl),
      originalUrl,
      thumbnailUrl,
      waveformUrl,
    },
    decisions,
    takes,
    transcript: transcriptData?.transcript ?? null,
    segments: transcriptData?.segments ?? [],
    summary: summarizeEdl(decisions, row.duration ?? 0),
    exports,
  });
});

/**
 * DELETE /api/videos/:id — remove the video and everything derived from it.
 *
 * Storage objects go first: an orphaned row is a nuisance, but an orphaned 4 GB
 * object in R2 is a bill.
 */
export const DELETE = route(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const database = db();

  const row = await requireVideoForUser(database, id, user.id);

  const exports = await database
    .select({ storageKey: videoExport.storageKey })
    .from(videoExport)
    .where(eq(videoExport.videoId, id));

  const keys = [
    row.storageKey,
    StorageKeys.proxy(user.id, id),
    StorageKeys.thumbnail(user.id, id),
    StorageKeys.waveform(user.id, id),
    ...exports.map((row) => row.storageKey).filter((key): key is string => Boolean(key)),
  ];

  await storage().deleteObjects(keys).catch((error: unknown) => {
    // Report the row as deleted regardless; the retention sweep will catch strays.
    console.error('[api] Could not delete every object for', id, error);
  });

  // Cascades take the transcript, takes, EDL, exports and share links with it.
  await database.delete(video).where(and(eq(video.id, id), eq(video.userId, user.id)));

  return NextResponse.json({ ok: true });
});
