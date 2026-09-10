'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Upload, X, Pause, Play, AlertCircle, ShieldCheck } from 'lucide-react';
import { formatBytes, formatEta, formatSpeed } from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { Card, Progress } from '@/components/ui/primitives';
import {
  forgetPendingUpload,
  readPendingUploads,
  startUpload,
  type PendingUpload,
  type UploadHandle,
  type UploadStats,
} from '@/lib/uploader';

/**
 * The main call to action.
 *
 * On iOS, a bare `accept="video/*"` file input is what makes Safari offer both the
 * Photos library and Files, and it hands over the original asset. There is
 * deliberately no `capture` attribute — that would force the camera and skip the
 * library the creator has already recorded into.
 */
export function UploadButton({ onUploaded }: { onUploaded?: (videoId: string) => void }) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const handleRef = React.useRef<UploadHandle | null>(null);

  const [stats, setStats] = React.useState<UploadStats | null>(null);
  const [pending, setPending] = React.useState<PendingUpload[]>([]);
  const [resumeTarget, setResumeTarget] = React.useState<PendingUpload | null>(null);

  React.useEffect(() => {
    setPending(readPendingUploads());
  }, []);

  // An upload in flight is worth a browser warning; the file handle cannot be
  // recovered after the tab closes, only the parts already in R2.
  React.useEffect(() => {
    if (!stats || (stats.status !== 'uploading' && stats.status !== 'completing')) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [stats]);

  const begin = React.useCallback(
    async (file: File) => {
      setResumeTarget(null);
      try {
        handleRef.current = await startUpload({
          file,
          onStats: setStats,
          onComplete: (videoId) => {
            setPending(readPendingUploads());
            if (onUploaded) onUploaded(videoId);
            else router.push(`/videos/${videoId}`);
          },
          onError: () => setPending(readPendingUploads()),
        });
      } catch (error: unknown) {
        setStats({
          filename: file.name,
          fileSize: file.size,
          bytesUploaded: 0,
          percent: 0,
          bytesPerSecond: null,
          etaSeconds: null,
          hashProgress: 0,
          resolution: null,
          status: 'error',
          error: error instanceof Error ? error.message : 'Upload could not start.',
          videoId: null,
          resumedFromPart: 0,
        });
      }
    },
    [onUploaded, router],
  );

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file still fires a change event.
    event.target.value = '';
    if (!file) return;

    if (resumeTarget) {
      const matches =
        file.name === resumeTarget.filename && file.size === resumeTarget.fileSize;
      if (!matches) {
        window.alert(
          `That is a different file. To resume, pick "${resumeTarget.filename}" (${formatBytes(resumeTarget.fileSize)}).`,
        );
        return;
      }
    }
    void begin(file);
  };

  const active = stats && stats.status !== 'idle' && stats.status !== 'error';

  return (
    <div className="w-full">
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mov,.mp4,.m4v"
        className="sr-only"
        onChange={onPick}
      />

      {!active ? (
        <div className="space-y-3">
          <Button
            size="xl"
            onClick={() => inputRef.current?.click()}
            className="gap-3 shadow-sm"
          >
            <Upload className="h-5 w-5" aria-hidden />
            Upload Raw Video
          </Button>
          <p className="text-sm text-ink-subtle">
            Straight from Photos or Files. Nothing is compressed on the way up.
          </p>

          {stats?.status === 'error' ? (
            <Card className="flex items-start gap-3 border-cut-retake/40 bg-cut-retake-soft p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-cut-retake" aria-hidden />
              <div className="min-w-0 text-sm">
                <p className="font-medium text-ink">Upload failed</p>
                <p className="text-ink-muted">{stats.error}</p>
              </div>
            </Card>
          ) : null}

          {pending.length > 0 ? (
            <ResumeList
              pending={pending}
              onResume={(entry) => {
                setResumeTarget(entry);
                inputRef.current?.click();
              }}
              onForget={(entry) => {
                forgetPendingUpload(entry.sessionId);
                setPending(readPendingUploads());
              }}
            />
          ) : null}
        </div>
      ) : (
        <UploadProgressCard
          stats={stats!}
          onPause={() => handleRef.current?.pause()}
          onResume={() => handleRef.current?.resume()}
          onCancel={async () => {
            await handleRef.current?.cancel();
            setStats(null);
            setPending(readPendingUploads());
          }}
        />
      )}
    </div>
  );
}

function UploadProgressCard({
  stats,
  onPause,
  onResume,
  onCancel,
}: {
  stats: UploadStats;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => Promise<void>;
}) {
  const paused = stats.status === 'paused';
  const completing = stats.status === 'completing';

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{stats.filename}</p>
          <p className="mt-0.5 text-xs text-ink-subtle">
            {formatBytes(stats.fileSize)}
            {stats.resolution ? ` · ${stats.resolution}` : ''}
            {stats.resumedFromPart > 0 ? ` · resumed from part ${stats.resumedFromPart}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {!completing ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={paused ? onResume : onPause}
              aria-label={paused ? 'Resume upload' : 'Pause upload'}
            >
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" onClick={() => void onCancel()} aria-label="Cancel upload">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Progress value={stats.percent} className="mt-3" />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span className="tabular-nums">
          {formatBytes(stats.bytesUploaded)} of {formatBytes(stats.fileSize)} ·{' '}
          {stats.percent.toFixed(1)}%
        </span>
        <span className="tabular-nums">
          {completing
            ? 'Finishing…'
            : paused
              ? 'Paused'
              : `${formatSpeed(stats.bytesPerSecond)} · ${formatEta(stats.etaSeconds)}`}
        </span>
      </div>

      {stats.hashProgress < 1 ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-subtle">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Checking file integrity… {Math.round(stats.hashProgress * 100)}%
        </p>
      ) : null}
    </Card>
  );
}

function ResumeList({
  pending,
  onResume,
  onForget,
}: {
  pending: PendingUpload[];
  onResume: (entry: PendingUpload) => void;
  onForget: (entry: PendingUpload) => void;
}) {
  return (
    <Card className="p-3">
      <p className="text-xs font-medium text-ink-muted">Unfinished uploads</p>
      <ul className="mt-2 space-y-2">
        {pending.map((entry) => (
          <li key={entry.sessionId} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">{entry.filename}</p>
              <p className="text-xs text-ink-subtle">{formatBytes(entry.fileSize)}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="outline" onClick={() => onResume(entry)}>
                Resume
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onForget(entry)}>
                Discard
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {/* The browser cannot restore a File handle after a refresh, so be honest
          about what "resume" requires instead of implying it continues by itself. */}
      <p className="mt-2 text-xs text-ink-subtle">
        Pick the same file again and we will carry on from the parts already uploaded.
      </p>
    </Card>
  );
}
