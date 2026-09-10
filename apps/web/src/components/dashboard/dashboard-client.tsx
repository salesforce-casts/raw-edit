'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Link2 } from 'lucide-react';
import { isActiveStatus, type VideoStatus } from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { EmptyState, Spinner } from '@/components/ui/primitives';
import { UploadButton } from '@/components/upload/upload-button';
import { VideoCard, type VideoSummary } from '@/components/dashboard/video-card';
import { ImportDialog } from '@/components/dashboard/import-dialog';
import { api } from '@/lib/utils';

export function DashboardClient() {
  const router = useRouter();
  const [videos, setVideos] = React.useState<VideoSummary[] | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const data = await api<{ videos: VideoSummary[] }>('/api/videos');
      setVideos(data.videos);
    } catch {
      setVideos([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Anything still processing gets a refresh loop, so a creator who leaves the tab
  // open sees it finish. Each card also streams its own progress over SSE; this is
  // the coarser list-level refresh that picks up status changes.
  const hasActive = (videos ?? []).some((video) => isActiveStatus(video.status as VideoStatus));
  React.useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  return (
    <div className="mt-8">
      <div className="flex flex-col items-start gap-3">
        <UploadButton onUploaded={(videoId) => router.push(`/videos/${videoId}`)} />
        <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)} className="gap-2">
          <Link2 className="h-4 w-4" aria-hidden />
          Or paste a Drive, Dropbox or OneDrive link
        </Button>
      </div>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-ink-muted">Recent videos</h2>

        {videos === null ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-ink-subtle">
            <Spinner /> Loading your library…
          </div>
        ) : videos.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="Nothing here yet"
              description="Upload your first raw recording and we will show you the cut before you commit to it."
            />
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {videos.map((video) => (
              <li key={video.id}>
                <VideoCard video={video} onChanged={load} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(videoId) => router.push(`/videos/${videoId}`)}
      />
    </div>
  );
}
