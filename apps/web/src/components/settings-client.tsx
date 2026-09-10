'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  formatBytes,
  RETENTION_POLICIES,
  SILENCE_THRESHOLD_CHOICES,
  type PlanLimits,
  type RetentionPolicy,
  type UsageTotals,
} from '@rawedit/core';
import { Button } from '@/components/ui/button';
import { Card, Progress, Spinner, Toggle } from '@/components/ui/primitives';
import { api, cn } from '@/lib/utils';

interface Settings {
  silenceThresholdSeconds: number;
  padPreMs: number;
  padPostMs: number;
  removeFillerWords: boolean;
  detectRetakes: boolean;
  removeSilence: boolean;
  defaultExportPreset: string;
  sourceRetention: RetentionPolicy;
}

const RETENTION_LABELS: Record<RetentionPolicy, string> = {
  DAYS_7: 'Delete after 7 days',
  DAYS_30: 'Delete after 30 days',
  DAYS_90: 'Delete after 90 days',
  NEVER: 'Keep forever',
};

export function SettingsClient() {
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [plan, setPlan] = React.useState<PlanLimits | null>(null);
  const [usage, setUsage] = React.useState<UsageTotals | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    void api<{ settings: Settings; plan: PlanLimits; usage: UsageTotals }>('/api/settings')
      .then((data) => {
        setSettings(data.settings);
        setPlan(data.plan);
        setUsage(data.usage);
      })
      .catch(() => toast.error('Could not load your settings.'));
  }, []);

  async function save(patch: Partial<Settings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(true);
    try {
      const result = await api<{ retentionApplied: number }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (patch.sourceRetention && result.retentionApplied > 0) {
        toast.success(
          `Retention updated for ${result.retentionApplied} video${result.retentionApplied === 1 ? '' : 's'}.`,
        );
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !plan || !usage) {
    return (
      <div className="mt-6 flex items-center gap-2 text-sm text-ink-subtle">
        <Spinner /> Loading…
      </div>
    );
  }

  const minutesUsed = Math.min(100, (usage.uploadedMinutes / plan.monthlyUploadMinutes) * 100);
  const storageUsed = Math.min(100, (usage.storageBytes / plan.storageBytes) * 100);

  return (
    <div className="mt-6 max-w-2xl space-y-4">
      <Card className="p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink">Your plan</h2>
          <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
            {plan.label}
          </span>
        </div>

        <div className="mt-4 space-y-3">
          <UsageRow
            label="Upload minutes this month"
            value={`${Math.round(usage.uploadedMinutes)} / ${plan.monthlyUploadMinutes}`}
            percent={minutesUsed}
          />
          <UsageRow
            label="Storage"
            value={`${formatBytes(usage.storageBytes)} / ${formatBytes(plan.storageBytes)}`}
            percent={storageUsed}
          />
        </div>

        <p className="mt-3 text-xs text-ink-subtle">
          Rendered {Math.round(usage.renderedMinutes)} min · transcribed{' '}
          {Math.round(usage.transcribedMinutes)} min.
        </p>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-medium text-ink">Default editing</h2>

        <div className="mt-4">
          <p className="mb-2 text-sm text-ink">Remove silence longer than</p>
          <div className="flex flex-wrap gap-1.5">
            {SILENCE_THRESHOLD_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => void save({ silenceThresholdSeconds: choice })}
                className={cn(
                  'h-9 rounded-lg px-3 text-sm transition-colors',
                  settings.silenceThresholdSeconds === choice
                    ? 'bg-accent text-white'
                    : 'bg-surface-muted text-ink hover:bg-border',
                )}
              >
                {choice}s
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 space-y-1 border-t border-border pt-3">
          <Toggle
            checked={settings.detectRetakes}
            onChange={(value) => void save({ detectRetakes: value })}
            label="Find repeated takes"
            hint="Keeps the attempt you finished and removes the ones you abandoned."
          />
          <Toggle
            checked={settings.removeSilence}
            onChange={(value) => void save({ removeSilence: value })}
            label="Remove long pauses"
          />
          <Toggle
            checked={settings.removeFillerWords}
            onChange={(value) => void save({ removeFillerWords: value })}
            label="Remove filler words"
            hint="Off by default — cutting every “um” can make the delivery sound clipped."
          />
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-medium text-ink">Keeping your originals</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Your finished renders are always kept. This only controls the raw file you
          uploaded, which is what re-rendering needs.
        </p>

        <div className="mt-3 space-y-1.5">
          {RETENTION_POLICIES.map((policy) => (
            <label
              key={policy}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors',
                settings.sourceRetention === policy
                  ? 'border-accent bg-accent-soft/50'
                  : 'border-border hover:bg-surface-muted',
              )}
            >
              <input
                type="radio"
                name="retention"
                checked={settings.sourceRetention === policy}
                onChange={() => void save({ sourceRetention: policy })}
                disabled={!plan.features.customRetention && policy !== 'NEVER'}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span className="text-sm text-ink">{RETENTION_LABELS[policy]}</span>
            </label>
          ))}
        </div>

        {!plan.features.customRetention ? (
          <p className="mt-2 text-xs text-ink-subtle">
            Custom retention is available on the Creator and Pro plans.
          </p>
        ) : null}
      </Card>

      {saving ? (
        <p className="flex items-center gap-2 text-xs text-ink-subtle">
          <Spinner className="h-3 w-3" /> Saving…
        </p>
      ) : null}
    </div>
  );
}

function UsageRow({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-ink-muted">{label}</span>
        <span className="tabular-nums text-ink-subtle">{value}</span>
      </div>
      <Progress
        value={percent}
        className="mt-1.5"
        tone={percent > 90 ? 'danger' : percent > 70 ? 'accent' : 'accent'}
      />
    </div>
  );
}
