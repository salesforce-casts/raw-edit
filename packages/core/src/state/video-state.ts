import type { JobStatus, VideoStatus } from '../types/status.js';

/**
 * The single declaration of legal video transitions. Every writer calls
 * `assertVideoTransition` before an UPDATE, which is what stops a late worker from
 * dragging a COMPLETE video back into RENDERING.
 */
export const VIDEO_TRANSITIONS: Record<VideoStatus, readonly VideoStatus[]> = {
  UPLOADING: ['UPLOADED', 'FAILED'],
  UPLOADED: ['ANALYZING', 'FAILED'],
  ANALYZING: ['TRANSCRIBING', 'FAILED'],
  TRANSCRIBING: ['DETECTING_TAKES', 'FAILED'],
  DETECTING_TAKES: ['READY_FOR_REVIEW', 'FAILED'],
  READY_FOR_REVIEW: ['RENDERING', 'ANALYZING', 'FAILED'],
  RENDERING: ['COMPLETE', 'READY_FOR_REVIEW', 'FAILED'],
  COMPLETE: ['RENDERING', 'READY_FOR_REVIEW', 'FAILED'],
  FAILED: ['UPLOADED', 'READY_FOR_REVIEW', 'ANALYZING', 'RENDERING'],
};

export class IllegalStateTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    entity = 'video',
  ) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`);
    this.name = 'IllegalStateTransitionError';
  }
}

export function canTransitionVideo(from: VideoStatus, to: VideoStatus): boolean {
  if (from === to) return true;
  return VIDEO_TRANSITIONS[from].includes(to);
}

export function assertVideoTransition(from: VideoStatus, to: VideoStatus): void {
  if (!canTransitionVideo(from, to)) {
    throw new IllegalStateTransitionError(from, to, 'video');
  }
}

export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'DEAD'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  // A retry delivery claims a FAILED row directly: the queue holds the backoff, so
  // the row goes FAILED -> RUNNING without passing through QUEUED again. The same
  // applies to a job the sweeper reclaimed from a worker that stopped responding.
  FAILED: ['QUEUED', 'RUNNING', 'DEAD'],
  SUCCEEDED: [],
  // A dead-lettered job must be re-queued deliberately rather than picked straight
  // back up, so that a permanent failure cannot quietly loop.
  DEAD: ['QUEUED'],
  CANCELLED: ['QUEUED'],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true;
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new IllegalStateTransitionError(from, to, 'job');
  }
}

/** Weighted sub-stages so the ANALYZE job reports one honest 0-100 number. */
export const ANALYZE_STAGE_WEIGHTS = [
  { key: 'probe', label: 'Reading video metadata', weight: 0.1 },
  { key: 'audio', label: 'Extracting audio', weight: 0.2 },
  { key: 'silence', label: 'Detecting silence', weight: 0.1 },
  { key: 'preview', label: 'Building preview', weight: 0.15 },
  { key: 'transcribe', label: 'Transcribing audio', weight: 0.3 },
  { key: 'takes', label: 'Finding retakes', weight: 0.15 },
] as const;

export type AnalyzeStageKey = (typeof ANALYZE_STAGE_WEIGHTS)[number]['key'];

/**
 * Maps (stage, fraction-within-stage) to overall job progress.
 * Progress is always derived from real measurements, never a timer.
 */
export function analyzeProgress(stage: AnalyzeStageKey, fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  let before = 0;
  for (const entry of ANALYZE_STAGE_WEIGHTS) {
    if (entry.key === stage) {
      return Math.round((before + entry.weight * clamped) * 100);
    }
    before += entry.weight;
  }
  return Math.round(before * 100);
}

export function analyzeStageLabel(stage: AnalyzeStageKey): string {
  return ANALYZE_STAGE_WEIGHTS.find((s) => s.key === stage)?.label ?? stage;
}

/** Video status implied by an analysis sub-stage, so the UI reads sensibly. */
export function analyzeStageStatus(stage: AnalyzeStageKey): VideoStatus {
  switch (stage) {
    case 'probe':
    case 'audio':
    case 'silence':
    case 'preview':
      return 'ANALYZING';
    case 'transcribe':
      return 'TRANSCRIBING';
    case 'takes':
      return 'DETECTING_TAKES';
    default:
      return 'ANALYZING';
  }
}
