'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Copy,
  Download,
  Film,
  MoreVertical,
  RefreshCw,
  RotateCcw,
  Share2,
  Trash2,
} from 'lucide-react';
import {
  formatBytes,
  formatTimecode,
  isActiveStatus,
  STATUS_LABELS,
  type VideoStatus,
} from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { Card, Progress, StatusBadge } from '@/components/ui/primitives';
import { useVideoProgress } from '@/hooks/use-video-progress';
import { api, cn } from '@/lib/utils';

export interface VideoSummary {
  id: string;
  title: string;
  originalFilename: string;
  status: VideoStatus;
  statusDetail: string | null;
  progress: number;
  errorMessage: string | null;
  createdAt: string;
  fileSize: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  isHdr: boolean;
  videoCodec: string | null;
  sourceDeletedAt: string | null;
  editedDuration: number | null;
  removedDuration: number;
  cutCount: number;
  latestExportId: string | null;
  latestExportSize: number | null;
  thumbnailUrl: string | null;
}

export function VideoCard({ video, onChanged }: { video: VideoSummary; onChanged: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);

  const live = useVideoProgress(
    video.id,
    {
      status: video.status,
      progress: video.progress,
      stage: video.statusDetail,
      message: video.errorMessage,
    },
    { onSettled: onChanged },
  );

  const active = isActiveStatus(live.status);
  const href = `/videos/${video.id}`;

  async function download() {
    setBusy(true);
    try {
      const result = await api<{ url: string; filename: string }>(
        `/api/videos/${video.id}/download`,
      );
      // The signed URL is short-lived, so navigate straight to it.
      window.location.href = result.url;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not prepare the download.');
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    setBusy(true);
    try {
      const result = await api<{ url: string }>(`/api/videos/${video.id}/share`, {
        method: 'POST',
        body: JSON.stringify({ expiresIn: 'never', allowDownload: true }),
      });
      await navigator.clipboard.writeText(result.url).catch(() => undefined);
      toast.success('Share link copied to your clipboard.');
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not create a share link.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${video.title}"? This removes the original and every render.`)) {
      return;
    }
    setBusy(true);
    try {
      await api(`/api/videos/${video.id}`, { method: 'DELETE' });
      toast.success('Deleted.');
      onChanged();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not delete that video.');
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try {
      await api(`/api/videos/${video.id}/retry`, { method: 'POST' });
      toast.success('Queued again.');
      onChanged();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not retry.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden transition-colors hover:border-ink-subtle/40">
      <Link href={href} className="block">
        <div className="relative aspect-video w-full overflow-hidden bg-surface-muted">
          {video.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={video.thumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-ink-subtle">
              <Film className="h-8 w-8" aria-hidden />
            </div>
          )}
          {video.isHdr ? (
            <span className="absolute right-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">
              HDR
            </span>
          ) : null}
        </div>
      </Link>

      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <Link href={href} className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{video.title}</p>
            <p className="mt-0.5 truncate text-xs text-ink-subtle">
              {new Date(video.createdAt).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
              {' · '}
              {formatBytes(video.fileSize)}
              {video.width && video.height ? ` · ${video.width}×${video.height}` : ''}
            </p>
          </Link>

          <div className="relative shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setMenuOpen((value) => !value)}
              aria-label="Video actions"
              aria-expanded={menuOpen}
              disabled={busy}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
            {menuOpen ? (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden
                />
                <div className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-border bg-surface p-1 shadow-lg">
                  <MenuItem
                    icon={<Film className="h-4 w-4" />}
                    label="Open"
                    onClick={() => router.push(href)}
                  />
                  {video.latestExportId ? (
                    <>
                      <MenuItem
                        icon={<Download className="h-4 w-4" />}
                        label="Download"
                        onClick={() => void download()}
                      />
                      <MenuItem
                        icon={<Share2 className="h-4 w-4" />}
                        label="Copy share link"
                        onClick={() => void share()}
                      />
                      <MenuItem
                        icon={<RefreshCw className="h-4 w-4" />}
                        label="Re-render"
                        onClick={() => router.push(`${href}?render=1`)}
                      />
                    </>
                  ) : null}
                  {live.status === 'FAILED' ? (
                    <MenuItem
                      icon={<RotateCcw className="h-4 w-4" />}
                      label="Try again"
                      onClick={() => void retry()}
                    />
                  ) : null}
                  <MenuItem
                    icon={<Copy className="h-4 w-4" />}
                    label="Duplicate edit"
                    onClick={() => router.push(`${href}?duplicate=1`)}
                  />
                  <MenuItem
                    icon={<Trash2 className="h-4 w-4" />}
                    label="Delete"
                    destructive
                    onClick={() => void remove()}
                  />
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="mt-3">
          {active ? (
            <>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="text-ink-muted">{live.stage ?? STATUS_LABELS[live.status]}</span>
                <span className="tabular-nums text-ink-subtle">{live.progress}%</span>
              </div>
              <Progress value={live.progress} />
            </>
          ) : live.status === 'FAILED' ? (
            <div className="flex items-center justify-between gap-2">
              <StatusBadge status="FAILED" />
              <Button size="sm" variant="outline" onClick={() => void retry()} disabled={busy}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={live.status} />
              <DurationSummary video={video} />
            </div>
          )}

          {live.status === 'FAILED' && live.message ? (
            <p className="mt-2 text-xs text-ink-muted">{live.message}</p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function DurationSummary({ video }: { video: VideoSummary }) {
  if (video.duration === null) return null;
  const edited = video.editedDuration;

  return (
    <span className="text-xs tabular-nums text-ink-muted">
      {edited !== null && Math.abs(edited - video.duration) > 0.5 ? (
        <>
          <span className="text-ink-subtle line-through">{formatTimecode(video.duration)}</span>{' '}
          <span className="font-medium text-ink">{formatTimecode(edited)}</span>
          {video.cutCount > 0 ? (
            <span className="text-ink-subtle"> · {video.cutCount} cuts</span>
          ) : null}
        </>
      ) : (
        formatTimecode(video.duration)
      )}
    </span>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-muted',
        destructive ? 'text-danger' : 'text-ink',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
