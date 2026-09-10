'use client';

import * as React from 'react';
import { STATUS_LABELS, type VideoStatus } from '@rawedit/core';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-border bg-surface', className)}
      {...props}
    />
  );
}

export function Progress({
  value,
  className,
  tone = 'accent',
}: {
  value: number;
  className?: string;
  tone?: 'accent' | 'success' | 'danger';
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const bar = { accent: 'bg-accent', success: 'bg-success', danger: 'bg-danger' }[tone];
  return (
    <div
      className={cn('h-2 w-full overflow-hidden rounded-full bg-surface-muted', className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300 ease-out', bar)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

const STATUS_TONE: Record<VideoStatus, string> = {
  UPLOADING: 'bg-accent-soft text-accent',
  UPLOADED: 'bg-surface-muted text-ink-muted',
  ANALYZING: 'bg-accent-soft text-accent',
  TRANSCRIBING: 'bg-accent-soft text-accent',
  DETECTING_TAKES: 'bg-accent-soft text-accent',
  READY_FOR_REVIEW: 'bg-cut-silence-soft text-cut-silence',
  RENDERING: 'bg-accent-soft text-accent',
  COMPLETE: 'bg-surface-muted text-success',
  FAILED: 'bg-cut-retake-soft text-cut-retake',
};

export function StatusBadge({ status, className }: { status: VideoStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        STATUS_TONE[status],
        className,
      )}
    >
      {status !== 'COMPLETE' && status !== 'READY_FOR_REVIEW' && status !== 'FAILED' ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
      ) : null}
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs text-ink-subtle">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-xl border border-border bg-surface px-3 text-ink',
        'placeholder:text-ink-subtle focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-xl p-2 text-left transition-colors hover:bg-surface-muted disabled:opacity-50"
    >
      <span
        className={cn(
          'mt-0.5 flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors',
          checked ? 'bg-accent' : 'bg-border',
        )}
      >
        <span
          className={cn(
            'h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {hint ? <span className="block text-xs text-ink-subtle">{hint}</span> : null}
      </span>
    </button>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-border px-6 py-12 text-center">
      <p className="text-base font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-ink-muted">{description}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
      aria-hidden
    />
  );
}
