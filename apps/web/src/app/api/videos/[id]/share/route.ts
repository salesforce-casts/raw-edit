import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { newId, shareSlug } from '@rawedit/core';
import { requireVideoForUser, shareLink, videoExport } from '@rawedit/db';
import { appUrl, db } from '@/lib/container';
import { jsonError, notFound, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

const EXPIRY_CHOICES = ['24h', '7d', '30d', 'never'] as const;

const CreateShareSchema = z.object({
  exportId: z.string().min(1).optional(),
  expiresIn: z.enum(EXPIRY_CHOICES).default('never'),
  allowDownload: z.boolean().default(true),
});

function expiryDate(choice: (typeof EXPIRY_CHOICES)[number]): Date | null {
  const hours = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, never: 0 }[choice];
  return hours === 0 ? null : new Date(Date.now() + hours * 60 * 60 * 1000);
}

/**
 * POST /api/videos/:id/share — create a share link.
 *
 * The link is a slug, not a storage URL. The share page resolves it server-side and
 * mints a short-lived signed URL per view, so the bucket stays private and revoking
 * or expiring a link actually takes effect.
 */
export const POST = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const database = db();

  await requireVideoForUser(database, id, user.id);

  const parsed = CreateShareSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError('Invalid share options.', 400, 'INVALID_REQUEST');

  const target = parsed.data.exportId
    ? await database
        .select()
        .from(videoExport)
        .where(
          and(
            eq(videoExport.id, parsed.data.exportId),
            eq(videoExport.videoId, id),
            eq(videoExport.userId, user.id),
          ),
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

  const exportRow = target[0];
  if (!exportRow) {
    return jsonError('Render the video before sharing it.', 409, 'NO_EXPORT');
  }
  if (exportRow.status !== 'COMPLETE') {
    return jsonError('That render has not finished yet.', 409, 'EXPORT_NOT_READY');
  }

  const [created] = await database
    .insert(shareLink)
    .values({
      id: newId('shr'),
      slug: shareSlug(),
      videoId: id,
      exportId: exportRow.id,
      userId: user.id,
      allowDownload: parsed.data.allowDownload,
      expiresAt: expiryDate(parsed.data.expiresIn),
    })
    .returning();

  return NextResponse.json({
    link: created,
    url: `${appUrl()}/v/${created!.slug}`,
  });
});

/** GET /api/videos/:id/share — the links that already exist for this video. */
export const GET = route(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const database = db();

  await requireVideoForUser(database, id, user.id);
  const links = await database
    .select()
    .from(shareLink)
    .where(and(eq(shareLink.videoId, id), eq(shareLink.userId, user.id)))
    .orderBy(desc(shareLink.createdAt));

  return NextResponse.json({
    links: links.map((link) => ({ ...link, url: `${appUrl()}/v/${link.slug}` })),
  });
});

/** DELETE /api/videos/:id/share?slug=… — revoke a link without deleting the render. */
export const DELETE = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const slug = new URL(request.url).searchParams.get('slug');
  if (!slug) return jsonError('Which link should be revoked?', 400, 'INVALID_REQUEST');

  const database = db();
  const updated = await database
    .update(shareLink)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareLink.slug, slug), eq(shareLink.videoId, id), eq(shareLink.userId, user.id)))
    .returning();

  if (updated.length === 0) return notFound('That link');
  return NextResponse.json({ ok: true });
});
