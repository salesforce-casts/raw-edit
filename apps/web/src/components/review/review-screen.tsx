'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Eye, EyeOff, Redo2, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import {
  buildRenderPlan,
  formatTimecode,
  isActiveStatus,
  type EdlOverride,
  type EditDecision,
  type EditSettings,
  type EdlSummary,
} from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { Card, Progress, StatusBadge } from '@/components/ui/primitives';
import { Timeline } from '@/components/timeline/timeline';
import { Player, type PlayerHandle } from '@/components/review/player';
import { TranscriptPanel } from '@/components/review/transcript-panel';
import { EditSettingsPanel } from '@/components/review/edit-settings-panel';
import { ExportPanel } from '@/components/review/export-panel';
import { useVideoProgress } from '@/hooks/use-video-progress';
import type { ReviewPayload, ReviewSegment } from '@/components/review/types';
import { api, cn } from '@/lib/utils';

export function ReviewScreen({ initial }: { initial: ReviewPayload }) {
  const router = useRouter();
  const playerRef = React.useRef<PlayerHandle>(null);

  const [data, setData] = React.useState(initial);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [previewEdit, setPreviewEdit] = React.useState(false);
  const [peaks, setPeaks] = React.useState<number[] | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Undo/redo is a stack of overrides replayed over the automatic proposal, so a
  // step back is just "send one fewer override" rather than an inverse operation.
  const [undoStack, setUndoStack] = React.useState<EdlOverride[]>([]);
  const [redoStack, setRedoStack] = React.useState<EdlOverride[]>([]);

  const video = data.video;
  const duration = video.duration ?? 0;

  const live = useVideoProgress(
    video.id,
    {
      status: video.status,
      progress: video.progress,
      stage: video.statusDetail,
      message: video.errorMessage,
    },
    { onSettled: () => router.refresh() },
  );

  React.useEffect(() => {
    if (!video.waveformUrl) return;
    void fetch(video.waveformUrl)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { peaks?: number[] } | null) => setPeaks(body?.peaks ?? null))
      .catch(() => undefined);
  }, [video.waveformUrl]);

  const keepRanges = React.useMemo(
    () =>
      buildRenderPlan(data.decisions, {
        duration,
        frameRate: video.frameRate ?? 30,
      }).keepRanges,
    [data.decisions, duration, video.frameRate],
  );

  /** Send the whole override stack; the server replays it deterministically. */
  const commit = React.useCallback(
    async (overrides: EdlOverride[], settings?: Partial<EditSettings>, reset?: boolean) => {
      setSaving(true);
      try {
        const result = await api<{ decisions: EditDecision[]; summary: EdlSummary }>(
          `/api/videos/${video.id}/edl`,
          {
            method: 'PATCH',
            body: JSON.stringify({ overrides, settings, reset }),
          },
        );
        setData((previous) => ({ ...previous, decisions: result.decisions, summary: result.summary }));
      } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : 'Could not save that edit.');
      } finally {
        setSaving(false);
      }
    },
    [video.id],
  );

  const push = React.useCallback(
    (override: EdlOverride) => {
      const next = [...undoStack, override];
      setUndoStack(next);
      setRedoStack([]);
      void commit(next);
    },
    [undoStack, commit],
  );

  const undo = React.useCallback(() => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1]!;
    const next = undoStack.slice(0, -1);
    setUndoStack(next);
    setRedoStack((stack) => [...stack, last]);
    void commit(next);
  }, [undoStack, commit]);

  const redo = React.useCallback(() => {
    if (redoStack.length === 0) return;
    const restored = redoStack[redoStack.length - 1]!;
    const next = [...undoStack, restored];
    setUndoStack(next);
    setRedoStack((stack) => stack.slice(0, -1));
    void commit(next);
  }, [redoStack, undoStack, commit]);

  const resetAuto = React.useCallback(() => {
    setUndoStack([]);
    setRedoStack([]);
    void commit([], undefined, true);
    toast.success('Back to the automatic edit.');
  }, [commit]);

  // Keyboard shortcuts a desktop editor will reach for without being told.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (event.key === ' ') {
        event.preventDefault();
        playerRef.current?.play();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const seek = React.useCallback((time: number) => {
    playerRef.current?.seek(time);
    setCurrentTime(time);
  }, []);

  const aspect =
    video.width && video.height
      ? video.rotation === 90 || video.rotation === 270
        ? video.height / video.width
        : video.width / video.height
      : 16 / 9;

  if (isActiveStatus(live.status)) {
    return <ProcessingView status={live} title={video.title ?? video.originalFilename} />;
  }

  if (live.status === 'FAILED') {
    return <FailedView videoId={video.id} message={live.message} />;
  }

  return (
    <div className="py-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">
            {video.title ?? video.originalFilename}
          </h1>
          <p className="mt-0.5 text-xs text-ink-subtle">
            {video.width}×{video.height}
            {video.frameRate ? ` · ${Math.round(video.frameRate)}fps` : ''}
            {video.videoCodec ? ` · ${video.videoCodec.toUpperCase()}` : ''}
            {video.isHdr ? ` · ${video.hdrFormat ?? 'HDR'}` : ''}
            {video.usingProxy ? ' · previewing a proxy; rendering uses the original' : ''}
          </p>
        </div>
        <StatusBadge status={live.status} />
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          <Player
            ref={playerRef}
            src={video.playbackUrl}
            aspect={aspect}
            keepRanges={keepRanges}
            previewEdit={previewEdit}
            onTimeUpdate={setCurrentTime}
          />

          <Timeline
            duration={duration}
            currentTime={currentTime}
            decisions={data.decisions}
            peaks={peaks}
            selectedId={selectedId}
            onSeek={seek}
            onSelect={setSelectedId}
            onAdjust={(id, startTime, endTime) => push({ type: 'adjust', decisionId: id, startTime, endTime })}
          />

          <SummaryBar summary={data.summary} />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={previewEdit ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setPreviewEdit((value) => !value)}
              className="gap-1.5"
            >
              {previewEdit ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              {previewEdit ? 'Previewing the edit' : 'Preview edited version'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={undo}
              disabled={undoStack.length === 0 || saving}
              className="gap-1.5"
            >
              <Undo2 className="h-4 w-4" /> Undo
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={redo}
              disabled={redoStack.length === 0 || saving}
              className="gap-1.5"
            >
              <Redo2 className="h-4 w-4" /> Redo
            </Button>
            <Button variant="ghost" size="sm" onClick={resetAuto} disabled={saving} className="gap-1.5">
              <RotateCcw className="h-4 w-4" /> Reset automatic edits
            </Button>
          </div>

          <ExportPanel
            videoId={video.id}
            exports={data.exports}
            onRendered={() => router.refresh()}
          />
        </div>

        <div className="flex min-h-0 flex-col gap-4">
          <EditSettingsPanel
            videoId={video.id}
            saving={saving}
            onApply={(settings) => {
              setUndoStack([]);
              setRedoStack([]);
              void commit([], settings);
            }}
          />

          <Card className="flex min-h-0 flex-1 flex-col p-3 lg:max-h-[52vh]">
            <TranscriptPanel
              className="min-h-0 flex-1"
              segments={data.segments}
              decisions={data.decisions}
              takes={data.takes}
              currentTime={currentTime}
              onSeek={seek}
              onRestore={(decisionId) => push({ type: 'restore', decisionId })}
              onRemoveSegment={(segment: ReviewSegment) =>
                push({
                  type: 'remove',
                  startTime: segment.startTime,
                  endTime: segment.endTime,
                  segmentIndex: segment.index,
                })
              }
              onKeepTake={(takeId, segmentIndex) => push({ type: 'keepTake', takeId, segmentIndex })}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

/** The three numbers the brief asks for, in the order a creator reads them. */
function SummaryBar({ summary }: { summary: EdlSummary }) {
  return (
    <Card className="grid grid-cols-3 divide-x divide-border">
      <Stat label="Original" value={formatTimecode(summary.originalDuration)} />
      <Stat label="Proposed" value={formatTimecode(summary.proposedDuration)} accent />
      <Stat
        label="Time removed"
        value={formatTimecode(summary.removedDuration)}
        hint={summary.cutCount > 0 ? `${summary.cutCount} cuts` : undefined}
      />
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="px-3 py-2.5 text-center">
      <p className="text-xs text-ink-subtle">{label}</p>
      <p className={cn('mt-0.5 text-base font-semibold tabular-nums', accent ? 'text-accent' : 'text-ink')}>
        {value}
      </p>
      {hint ? <p className="text-[11px] text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

function ProcessingView({
  status,
  title,
}: {
  status: { status: string; progress: number; stage: string | null };
  title: string;
}) {
  return (
    <div className="py-16">
      <Card className="mx-auto max-w-md p-6 text-center">
        <Sparkles className="mx-auto h-6 w-6 text-accent" aria-hidden />
        <h1 className="mt-3 truncate text-base font-medium text-ink">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">{status.stage ?? 'Working on it'}</p>
        <Progress value={status.progress} className="mt-4" />
        <p className="mt-2 text-xs tabular-nums text-ink-subtle">{status.progress}%</p>
        <p className="mt-4 text-xs text-ink-subtle">
          You can close this tab. Processing carries on and your video will be waiting.
        </p>
      </Card>
    </div>
  );
}

function FailedView({ videoId, message }: { videoId: string; message: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  return (
    <div className="py-16">
      <Card className="mx-auto max-w-md p-6 text-center">
        <h1 className="text-base font-medium text-ink">This video could not be processed</h1>
        <p className="mt-2 text-sm text-ink-muted">{message ?? 'Something went wrong.'}</p>
        <div className="mt-5 flex justify-center gap-2">
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/videos/${videoId}/retry`, { method: 'POST' });
                router.refresh();
              } catch (error: unknown) {
                toast.error(error instanceof Error ? error.message : 'Could not retry.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Try again
          </Button>
          <Button variant="outline" onClick={() => router.push('/dashboard')}>
            Back to videos
          </Button>
        </div>
      </Card>
    </div>
  );
}
