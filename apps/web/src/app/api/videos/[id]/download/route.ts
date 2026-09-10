import { NextResponse, type NextRequest } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { requireVideoForUser, videoExport } from '@rawedit/db';
import { URL_TTL, db, storage } from '@/lib/container';
import { jsonError, notFound, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

/**
 * GET /api/videos/:id/download — a short-lived signed URL for a finished render.
 *
 * The bucket is private and stays private: this mints a 15-minute URL with a
 * Content-Disposition filename, scoped to one object, after checking ownership.
 * `?source=original` downloads the untouched master instead.
 */
export const GET = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const params = new URL(request.url).searchParams;
  const database = db();

  const row = await requireVideoForUser(database, id, user.id);
  const baseName = (row.title ?? row.originalFilename).replace(/\.[^.]+$/, '');

  if (params.get('source') === 'original') {
    if (row.sourceDeletedAt) {
      return jsonError('The original was deleted under your retention policy.', 410, 'SOURCE_DELETED');
    }
    const url = await storage().signDownloadUrl(row.storageKey, URL_TTL.download, {
      filename: row.originalFilename,
      contentType: row.mimeType,
    });
    return NextResponse.json({ url, filename: row.originalFilename, kind: 'original' });
  }

  const exportId = params.get('exportId');
  const rows = exportId
    ? await database
        .select()
        .from(videoExport)
        .where(
          and(eq(videoExport.id, exportId), eq(videoExport.videoId, id), eq(videoExport.userId, user.id)),
        )
        .limit(1)
    : await database
        .select()
        .from(videoExport)
        .where(
          and(
            eq(videoExport.videoId, id),
            eq(videoExport.userId, user.id),
            eq(videoExport.status, 'COMPLETE'),
          ),
        )
        .orderBy(desc(videoExport.finishedAt))
        .limit(1);

  const exportRow = rows[0];
  if (!exportRow) return notFound('A finished render');
  if (exportRow.status !== 'COMPLETE' || !exportRow.storageKey) {
    return jsonError('That render has not finished yet.', 409, 'EXPORT_NOT_READY');
  }

  const filename = `${baseName}-edited.${exportRow.container}`;
  const url = await storage().signDownloadUrl(exportRow.storageKey, URL_TTL.download, {
    filename,
    contentType: 'video/mp4',
  });

  return NextResponse.json({ url, filename, kind: 'export', size: exportRow.fileSize });
});
