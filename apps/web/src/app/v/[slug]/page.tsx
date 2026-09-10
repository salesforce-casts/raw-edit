import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { formatBytes, formatTimecode } from '@rawedit/core';
import { getShareLinkBySlug, recordShareView } from '@rawedit/db';
import { URL_TTL, db, storage } from '@/lib/container';
import { ShareActions } from '@/components/share-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const row = await getShareLinkBySlug(db(), slug);
  if (!row) return { title: 'Video not found — RawEdit' };
  return {
    title: `${row.video.title ?? row.video.originalFilename} — RawEdit`,
    // A shared link should not put someone's video into a search index.
    robots: { index: false, follow: false },
  };
}

/**
 * The public share page.
 *
 * The slug is resolved server-side and a short-lived signed URL is minted per view.
 * The bucket itself is never public, so revoking a link or letting it expire takes
 * effect immediately rather than leaving a permanent URL in circulation.
 */
export default async function SharePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const row = await getShareLinkBySlug(db(), slug);

  // Not found, revoked, expired and not-yet-rendered all look identical from
  // outside, which is what stops a link being used to probe for a video's existence.
  if (!row) notFound();

  const { link, video, export: rendered } = row;
  if (!rendered.storageKey) notFound();

  await recordShareView(db(), link.id).catch(() => undefined);

  const playbackUrl = await storage().signDownloadUrl(rendered.storageKey, URL_TTL.playback);
  const downloadUrl = link.allowDownload
    ? await storage().signDownloadUrl(rendered.storageKey, URL_TTL.download, {
        filename: `${(video.title ?? video.originalFilename).replace(/\.[^.]+$/, '')}.mp4`,
      })
    : null;

  const portrait = (rendered.height ?? 0) > (rendered.width ?? 0);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-6 safe-top safe-bottom">
      <header className="mb-4 flex items-center justify-between">
        <span className="text-sm font-semibold tracking-tight text-ink-muted">RawEdit</span>
      </header>

      <div className="overflow-hidden rounded-card border border-border bg-black">
        <video
          src={playbackUrl}
          controls
          playsInline
          preload="metadata"
          className={`w-full ${portrait ? 'max-h-[75dvh]' : ''} object-contain`}
        />
      </div>

      <div className="mt-4">
        <h1 className="text-lg font-semibold tracking-tight">
          {video.title ?? video.originalFilename}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {rendered.duration ? formatTimecode(rendered.duration) : null}
          {rendered.width ? ` · ${rendered.width}×${rendered.height}` : ''}
          {rendered.fileSize ? ` · ${formatBytes(rendered.fileSize)}` : ''}
        </p>

        {link.expiresAt ? (
          <p className="mt-2 text-xs text-ink-subtle">
            This link expires on{' '}
            {link.expiresAt.toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
            .
          </p>
        ) : null}

        <ShareActions downloadUrl={downloadUrl} />
      </div>

      <footer className="mt-auto pt-10 text-xs text-ink-subtle">
        Edited with RawEdit — upload a raw recording, get a clean cut.
      </footer>
    </main>
  );
}
