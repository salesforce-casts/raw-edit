'use client';

import * as React from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { SILENCE_THRESHOLD_CHOICES, type EditSettings } from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { Card, Spinner, Toggle } from '@/components/ui/primitives';
import { api, cn } from '@/lib/utils';

/**
 * Editing controls.
 *
 * Changing anything here re-derives the proposal from the transcript we already hold
 * — no re-upload, no re-transcription — because the analysis layer is deterministic.
 */
export function EditSettingsPanel({
  videoId,
  saving,
  onApply,
}: {
  videoId: string;
  saving: boolean;
  onApply: (settings: Partial<EditSettings>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [settings, setSettings] = React.useState<EditSettings | null>(null);

  React.useEffect(() => {
    if (!open || settings) return;
    void api<{ settings: EditSettings }>(`/api/videos/${videoId}/edl`)
      .then(() => undefined)
      .catch(() => undefined);
  }, [open, settings, videoId]);

  const [threshold, setThreshold] = React.useState(1);
  const [padPre, setPadPre] = React.useState(160);
  const [padPost, setPadPost] = React.useState(200);
  const [removeFiller, setRemoveFiller] = React.useState(false);
  const [detectRetakes, setDetectRetakes] = React.useState(true);
  const [removeSilence, setRemoveSilence] = React.useState(true);

  const apply = () => {
    onApply({
      silenceThresholdSeconds: threshold,
      padPreMs: padPre,
      padPostMs: padPost,
      removeFillerWords: removeFiller,
      detectRetakes,
      removeSilence,
    });
  };

  return (
    <Card className="p-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-ink">
          <SlidersHorizontal className="h-4 w-4 text-ink-muted" aria-hidden />
          Editing settings
        </span>
        <span className="text-xs text-ink-subtle">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open ? (
        <div className="mt-4 space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium text-ink">Remove silence longer than</p>
            <div className="flex flex-wrap gap-1.5">
              {SILENCE_THRESHOLD_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  onClick={() => setThreshold(choice)}
                  className={cn(
                    'h-9 rounded-lg px-3 text-sm transition-colors',
                    threshold === choice
                      ? 'bg-accent text-white'
                      : 'bg-surface-muted text-ink hover:bg-border',
                  )}
                >
                  {choice}s
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-ink-subtle">
              Shorter pauses are left alone so speech still sounds natural.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <PaddingControl
              label="Keep before speech"
              value={padPre}
              onChange={setPadPre}
              hint="120–200ms feels natural"
            />
            <PaddingControl
              label="Keep after speech"
              value={padPost}
              onChange={setPadPost}
              hint="150–250ms feels natural"
            />
          </div>

          <div className="space-y-1 border-t border-border pt-3">
            <Toggle
              checked={detectRetakes}
              onChange={setDetectRetakes}
              label="Find repeated takes"
              hint="Keeps the attempt you finished and removes the ones you abandoned."
            />
            <Toggle
              checked={removeSilence}
              onChange={setRemoveSilence}
              label="Remove long pauses"
            />
            <Toggle
              checked={removeFiller}
              onChange={setRemoveFiller}
              label="Remove filler words"
              hint="Off by default — cutting every “um” can make the delivery sound clipped."
            />
          </div>

          <Button onClick={apply} disabled={saving} className="w-full gap-2">
            {saving ? <Spinner /> : null}
            Re-analyse with these settings
          </Button>
          <p className="text-xs text-ink-subtle">
            This reuses the existing transcript, so it is instant and costs nothing.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function PaddingControl({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  hint: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink">{label}</span>
      <input
        type="range"
        min={0}
        max={500}
        step={20}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="scrubber mt-2 w-full"
      />
      <span className="mt-1 block text-xs tabular-nums text-ink-subtle">
        {value}ms · {hint}
      </span>
    </label>
  );
}
