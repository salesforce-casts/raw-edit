'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { AlertTriangle, X } from 'lucide-react';
import { formatBytes } from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { Card, Field, Input, Spinner } from '@/components/ui/primitives';
import { api } from '@/lib/utils';

interface Resolved {
  provider: string;
  filename: string;
  size: number | null;
  isOriginal: boolean;
  notes: string[];
}

/**
 * Paste a cloud link.
 *
 * The link is resolved before anything is committed, so the creator sees the real
 * filename and size — and, importantly, a warning when the provider will only give us
 * a derivative rather than the camera original.
 */
export function ImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (videoId: string) => void;
}) {
  const [url, setUrl] = React.useState('');
  const [resolved, setResolved] = React.useState<Resolved | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setUrl('');
      setResolved(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function check() {
    setBusy(true);
    try {
      const result = await api<Resolved>('/api/imports', {
        method: 'POST',
        body: JSON.stringify({ url, dryRun: true }),
      });
      setResolved(result);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not read that link.');
      setResolved(null);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    try {
      const result = await api<{ videoId: string }>('/api/imports', {
        method: 'POST',
        body: JSON.stringify({ url, dryRun: false }),
      });
      toast.success('Import started.');
      onImported(result.videoId);
      onClose();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not start the import.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Import from a link"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <Card className="w-full max-w-md p-5 safe-bottom">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Import from a link</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Google Drive, Dropbox, OneDrive, iCloud, or a direct https link.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-4">
          <Field label="Link">
            <Input
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setResolved(null);
              }}
              placeholder="https://drive.google.com/file/d/…"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        </div>

        {resolved ? (
          <div className="mt-4 space-y-3">
            <div className="rounded-xl bg-surface-muted p-3 text-sm">
              <p className="font-medium text-ink">{resolved.filename}</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {resolved.provider}
                {resolved.size ? ` · ${formatBytes(resolved.size)}` : ''}
              </p>
            </div>

            {!resolved.isOriginal || resolved.notes.length > 0 ? (
              <div className="flex items-start gap-2 rounded-xl bg-cut-silence-soft p-3 text-xs">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-cut-silence" aria-hidden />
                <div className="space-y-1 text-ink-muted">
                  {!resolved.isOriginal ? (
                    <p className="font-medium text-ink">
                      This service serves a converted copy, not your camera original.
                    </p>
                  ) : null}
                  {resolved.notes.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex gap-2">
          {resolved ? (
            <Button className="flex-1" onClick={() => void start()} disabled={busy}>
              {busy ? <Spinner /> : null}
              Import this file
            </Button>
          ) : (
            <Button className="flex-1" onClick={() => void check()} disabled={busy || url.length < 8}>
              {busy ? <Spinner /> : null}
              Check link
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
