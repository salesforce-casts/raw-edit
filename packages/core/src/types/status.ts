export const VIDEO_STATUSES = [
  'UPLOADING',
  'UPLOADED',
  'ANALYZING',
  'TRANSCRIBING',
  'DETECTING_TAKES',
  'READY_FOR_REVIEW',
  'RENDERING',
  'COMPLETE',
  'FAILED',
] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const JOB_TYPES = [
  'ANALYZE_VIDEO',
  'TRANSCRIBE_AUDIO',
  'DETECT_TAKES',
  'RENDER_VIDEO',
  'IMPORT_SOURCE',
  'GENERATE_PROXY',
  'CLEANUP_SOURCE',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const UPLOAD_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'ABORTED', 'EXPIRED'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const SOURCE_KINDS = [
  'DIRECT_UPLOAD',
  'GOOGLE_DRIVE',
  'DROPBOX',
  'ONEDRIVE',
  'ICLOUD',
  'URL',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const EXPORT_STATUSES = ['QUEUED', 'RENDERING', 'COMPLETE', 'FAILED'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const EXPORT_PRESETS = ['ORIGINAL_QUALITY', 'SOCIAL_MEDIA', 'SMALLER_FILE'] as const;
export type ExportPresetId = (typeof EXPORT_PRESETS)[number];

export const EXPORT_STRATEGIES = ['PRESERVE_SOURCE', 'COMPATIBLE_MP4'] as const;
export type ExportStrategy = (typeof EXPORT_STRATEGIES)[number];

export const PLAN_TIERS = ['FREE', 'CREATOR', 'PRO'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const USAGE_KINDS = [
  'UPLOADED_MINUTES',
  'TRANSCRIBED_MINUTES',
  'RENDERED_MINUTES',
  'STORAGE_BYTES',
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const RETENTION_POLICIES = ['DAYS_7', 'DAYS_30', 'DAYS_90', 'NEVER'] as const;
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number];

export const RETENTION_DAYS: Record<RetentionPolicy, number | null> = {
  DAYS_7: 7,
  DAYS_30: 30,
  DAYS_90: 90,
  NEVER: null,
};

/** Statuses where the pipeline is actively working and the UI should stream updates. */
export const ACTIVE_STATUSES: readonly VideoStatus[] = [
  'UPLOADING',
  'UPLOADED',
  'ANALYZING',
  'TRANSCRIBING',
  'DETECTING_TAKES',
  'RENDERING',
];

export function isActiveStatus(status: VideoStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export const STATUS_LABELS: Record<VideoStatus, string> = {
  UPLOADING: 'Uploading',
  UPLOADED: 'Queued',
  ANALYZING: 'Analyzing video',
  TRANSCRIBING: 'Transcribing audio',
  DETECTING_TAKES: 'Finding retakes',
  READY_FOR_REVIEW: 'Ready for review',
  RENDERING: 'Rendering',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
};
