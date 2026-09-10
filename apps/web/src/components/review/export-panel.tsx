'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, Download, Share2 } from 'lucide-react';
import { formatBytes, formatTimecode } from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { Card, Progress, Spinner } from '@/components/ui/primitives';
import type { ExportRow, PresetOption } from '@/components/review/types';
import { api, cn } from '@/lib/utils';

/**
 * Approve the edit and render it.
 *
 * Every preset shows the resolution, codec and estimated size it will produce
 * *before* the render is queued, and any warning it carries — a tone-map, a downscale
 * — is shown next to the choice rather than discovered afterwards.
 */
export function ExportPanel({
  videoId,
  exports,
  onRendered,
}: {
  videoId: string;
  exports: ExportRow[];
  onRendered: () => void;
}) {
  const [presets, setPresets] = React.useState<PresetOption[] | null>(null);
  const [selected, setSelected] = React.useState('ORIGINAL_QUALITY');
  const [outputDuration, setOutputDuration] = React.useState<number | null>(null);
  const [rendering, setRendering] = React.useState(false);
  const [rows, setRows] = React.useState(exports);

  const load = React.useCallback(async () => {
    try {
      const data = await api<{
        presets: PresetOption[];
        exports: ExportRow[];
        outputDuration: number;
      }>(`/api/videos/${videoId}/exports`);
      setPresets(data.presets);
      setRows(data.exports);
      setOutputDuration(data.outputDuration);
    } catch {
      setPresets([]);
    }
  }, [videoId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const inFlight = rows.some((row) => row.status === 'QUEUED' || row.status === 'RENDERING');
  React.useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      void load();
      onRendered();
    }, 3000);
    return () => clearInterval(timer);
  }, [inFlight, load, onRendered]);

  const complete = rows.find((row) => row.status === 'COMPLETE');

  async function render() {
    setRendering(true);
    try {
      await api(`/api/videos/${videoId}/exports`, {
        method: 'POST',
        body: JSON.stringify({ preset: selected }),
      });
      toast.success('Rendering started. You can close this tab.');
      await load();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not start the render.');
    } finally {
      setRendering(false);
    }
  }

  async function download(exportId?: string) {
    try {
      const result = await api<{ url: string }>(
        `/api/videos/${videoId}/download${exportId ? `?exportId=${exportId}` : ''}`,
      );
      window.location.href = result.url;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not prepare the download.');
    }
  }

  async function share() {
    try {
      const result = await api<{ url: string }>(`/api/videos/${videoId}/share`, {
        method: 'POST',
        body: JSON.stringify({ expiresIn: 'never', allowDownload: true }),
      });
      await navigator.clipboard.writeText(result.url).catch(() => undefined);
      toast.success('Share link copied.');
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not create a share link.');
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-ink">Export</h2>
        {outputDuration !== null ? (
          <span className="text-xs tabular-nums text-ink-subtle">
            {formatTimecode(outputDuration)} output
          </span>
        ) : null}
      </div>

      {presets === null ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-ink-subtle">
          <Spinner /> Working out your options…
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => setSelected(preset.id)}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                selected === preset.id
                  ? 'border-accent bg-accent-soft/50'
                  : 'border-border hover:bg-surface-muted',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
                  selected === preset.id ? 'border-accent bg-accent' : 'border-border',
                )}
              >
                {selected === preset.id ? <Check className="h-2.5 w-2.5 text-white" /> : null}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium text-ink">{preset.label}</span>
                  {preset.id === 'ORIGINAL_QUALITY' ? (
                    <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                      Default
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-ink-muted">{preset.description}</span>
                <span className="mt-1 block text-xs tabular-nums text-ink-subtle">
                  {preset.result.width}×{preset.result.height} ·{' '}
                  {preset.result.videoCodec.toUpperCase()} · {Math.round(preset.result.frameRate)}fps ·{' '}
                  ~{formatBytes(preset.result.estimatedSize)}
                </span>

                {preset.result.warnings.length > 0 ? (
                  <span className="mt-1.5 flex items-start gap-1.5 text-xs text-cut-silence">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    <span>{preset.result.warnings.join(' ')}</span>
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}

      <Button onClick={() => void render()} disabled={rendering || inFlight} className="mt-4 w-full gap-2">
        {rendering ? <Spinner /> : null}
        {inFlight ? 'Rendering…' : 'Accept edits and render'}
      </Button>

      {rows.length > 0 ? (
        <ul className="mt-4 space-y-2 border-t border-border pt-3">
          {rows.map((row) => (
            <li key={row.id} className="text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink">
                  {row.width}×{row.height}
                  {row.fileSize ? ` · ${formatBytes(row.fileSize)}` : ''}
                </span>
                {row.status === 'COMPLETE' ? (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => void download(row.id)}
                      aria-label="Download"
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => void share()}
                      aria-label="Share"
                    >
                      <Share2 className="h-4 w-4" />
                    </Button>
                  </div>
                ) : row.status === 'FAILED' ? (
                  <span className="text-xs text-danger">Failed</span>
                ) : (
                  <span className="text-xs tabular-nums text-ink-subtle">{row.progress}%</span>
                )}
              </div>

              {row.status === 'RENDERING' || row.status === 'QUEUED' ? (
                <Progress value={row.progress} className="mt-1.5" />
              ) : null}

              {row.status === 'FAILED' && row.errorMessage ? (
                <p className="mt-1 text-xs text-ink-muted">{row.errorMessage}</p>
              ) : null}

              {row.warnings.length > 0 ? (
                <p className="mt-1 text-xs text-cut-silence">{row.warnings.join(' ')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {complete ? (
        <p className="mt-3 text-xs text-ink-subtle">
          Your edit is ready. The original is untouched and still available to re-render.
        </p>
      ) : null}
    </Card>
  );
}
