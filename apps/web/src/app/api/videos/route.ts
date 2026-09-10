import { NextResponse, type NextRequest } from 'next/server';
import { desc, eq, inArray } from 'drizzle-orm';
import { getActiveEdl, listVideosForUser, video, videoExport } from '@rawedit/db';
import { summarizeEdl } from '@rawedit/core';
import { URL_TTL, db, storage } from '@/lib/container';
import { requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

/**
 * GET /api/videos — the dashboard library.
 *
 * Each card needs a thumbnail, the original and edited durations, status and size.
 * Those come from three batched queries rather than a query per card.
 */
export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const url = new URL(request.url);
  const limit = Math.min(100, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50);
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);

  const database = db();
  const rows = await listVideosForUser(database, user.id, { limit, offset });
  if (rows.length === 0) return NextResponse.json({ videos: [] });

  const ids = rows.map((row) => row.id);

  const exports = await database
    .select()
    .from(videoExport)
    .where(inArray(videoExport.videoId, ids))
    .orderBy(desc(videoExport.finishedAt));

  const latestExport = new Map<string, (typeof exports)[number]>();
  for (const row of exports) {
    if (row.status !== 'COMPLETE') continue;
    if (!latestExport.has(row.videoId)) latestExport.set(row.videoId, row);
  }

  const videos = await Promise.all(
    rows.map(async (row) => {
      const decisions = await getActiveEdl(database, row.id);
      const summary = summarizeEdl(decisions, row.duration ?? 0);
      const finished = latestExport.get(row.id);

      return {
        id: row.id,
        title: row.title ?? row.originalFilename,
        originalFilename: row.originalFilename,
        status: row.status,
        statusDetail: row.statusDetail,
        progress: row.progress,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt,
        fileSize: row.fileSize,
        duration: row.duration,
        width: row.width,
        height: row.height,
        isHdr: row.isHdr,
        videoCodec: row.videoCodec,
        sourceDeletedAt: row.sourceDeletedAt,
        // "Edited duration" is the finished render when there is one, otherwise the
        // current proposal — which is what the creator is actually looking at.
        editedDuration: finished?.duration ?? (decisions.length > 0 ? summary.proposedDuration : null),
        removedDuration: summary.removedDuration,
        cutCount: summary.cutCount,
        latestExportId: finished?.id ?? null,
        latestExportSize: finished?.fileSize ?? null,
        thumbnailUrl: row.thumbnailKey
          ? await storage().signDownloadUrl(row.thumbnailKey, URL_TTL.thumbnail)
          : null,
      };
    }),
  );

  return NextResponse.json({ videos });
});
