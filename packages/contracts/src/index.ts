export const VIDEO_STATUSES = [
  "CREATED",
  "UPLOADING",
  "UPLOADED",
  "ANALYZING",
  "TRANSCRIBING",
  "DETECTING_EDITS",
  "READY_FOR_REVIEW",
  "RENDERING",
  "COMPLETE",
  "FAILED",
  "DELETING",
  "DELETED",
] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const PROCESSING_STATES: VideoStatus[] = [
  "UPLOADING",
  "UPLOADED",
  "ANALYZING",
  "TRANSCRIBING",
  "DETECTING_EDITS",
  "RENDERING",
  "DELETING",
];

export const SOURCE_TYPES = [
  "upload",
  "google_drive",
  "dropbox",
  "onedrive",
  "icloud",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const JOB_TYPES = [
  "ANALYZE_VIDEO",
  "TRANSCRIBE_VIDEO",
  "DETECT_AUTOMATIC_EDITS",
  "RENDER_EXPORT",
  "DELETE_VIDEO",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "QUEUED",
  "ACTIVE",
  "COMPLETED",
  "FAILED",
  "DEAD_LETTER",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const UPLOAD_STATUSES = [
  "INITIATED",
  "UPLOADING",
  "COMPLETING",
  "COMPLETED",
  "ABORTED",
  "EXPIRED",
] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const UPLOAD_TYPES = ["put", "multipart"] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

export const EDIT_ACTIONS = ["KEEP", "REMOVE"] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];

export const EDIT_SOURCES = ["AUTO_SILENCE", "AUTO_RETAKE", "AUTO_FILLER", "USER", "SYSTEM"] as const;
export type EditSource = (typeof EDIT_SOURCES)[number];

export const EXPORT_PRESETS = ["HIGH_QUALITY", "SMALLER_FILE", "HEVC_HIGH_QUALITY"] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

export const EXPORT_STRATEGIES = ["PRESERVE_HDR", "COMPATIBLE_SDR"] as const;
export type ExportStrategy = (typeof EXPORT_STRATEGIES)[number];

export const EXPORT_STATUSES = ["PENDING", "RENDERING", "COMPLETE", "FAILED"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const HDR_TYPES = ["SDR", "HDR10_PQ", "HLG", "DOLBY_VISION_OR_UNKNOWN_HDR"] as const;
export type HdrType = (typeof HDR_TYPES)[number];

export const USAGE_TYPES = [
  "UPLOAD_SECONDS",
  "TRANSCRIPTION_SECONDS",
  "RENDER_SECONDS",
  "STORAGE_BYTE_HOURS",
] as const;
export type UsageType = (typeof USAGE_TYPES)[number];

export const PLANS = ["free", "creator", "pro"] as const;
export type PlanId = (typeof PLANS)[number];

export const ERROR_CODES = [
  "UPLOAD_EXPIRED",
  "UPLOAD_PART_FAILED",
  "UPLOAD_SIZE_MISMATCH",
  "INVALID_MEDIA",
  "FFPROBE_FAILED",
  "UNSUPPORTED_CODEC",
  "TRANSCRIPTION_FAILED",
  "AI_ANALYSIS_FAILED",
  "RENDER_FAILED",
  "R2_DOWNLOAD_FAILED",
  "R2_UPLOAD_FAILED",
  "SOURCE_MISSING",
  "SOURCE_HASH_MISMATCH",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "FORBIDDEN",
  "PLAN_LIMIT",
  "SCRATCH_SPACE_EXCEEDED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const QUEUE_NAMES = {
  analysis: "video-analysis",
  transcription: "transcription",
  editDetection: "edit-detection",
  render: "video-render",
  maintenance: "video-maintenance",
} as const;

export const SIGNED_URL_TTL_SECONDS = {
  uploadPart: 15 * 60,
  proxyPlayback: 10 * 60,
  originalDownload: 5 * 60,
  exportDownload: 15 * 60,
} as const;

export const MULTIPART_PART_SIZE_BYTES = 64 * 1024 * 1024;
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const PRESIGN_BATCH_SIZE = 10;
export const MOBILE_UPLOAD_CONCURRENCY = 3;
export const DESKTOP_UPLOAD_CONCURRENCY = 5;
export const PART_RETRIES = 3;
export const DEFAULT_MAX_VIDEO_BYTES = 20 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_VIDEO_DURATION_SECONDS = 60 * 60;
export const MAX_ACTIVE_RENDERS_PER_USER = 2;
export const RETAKE_CANDIDATE_WINDOW_MS = 45_000;
export const RETAKE_MIN_WORDS = 3;
export const RETAKE_CANDIDATE_THRESHOLD = 0.8;
export const RETAKE_AUTO_REMOVE_MIN_CONFIDENCE = 0.75;
export const DEFAULT_SILENCE_THRESHOLD_DB = -35;
export const DEFAULT_MIN_SILENCE_MS = 1000;
export const DEFAULT_PRE_ROLL_MS = 150;
export const DEFAULT_POST_ROLL_MS = 200;
export const SILENCE_THRESHOLD_OPTIONS_MS = [500, 1000, 1500, 2000, 3000] as const;

export type Word = {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
};

export type TranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
  words: Word[];
  confidence?: number;
};

export type TranscriptionInput = {
  audioPath: string;
  language?: string;
  videoId: string;
  jobId: string;
};

export type TranscriptionResult = {
  provider: string;
  model: string;
  language?: string;
  fullText: string;
  durationMs: number;
  segments: TranscriptSegment[];
};

export type EditSegment = {
  startMs: number;
  endMs: number;
  action: EditAction;
  source?: EditSource;
  reason?: string;
  confidence?: number;
};

export type EditDecisionList = {
  videoId: string;
  version: number;
  segments: EditSegment[];
};

export type TakeCandidate = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  wordConfidenceAvg?: number;
  completenessScore: number;
  fluencyScore: number;
  semanticScore: number;
};

export type TakeCandidateGroup = {
  id: string;
  similarityScore: number;
  confidence: number;
  candidates: TakeCandidate[];
};

export type TakeDecision = {
  keepCandidateId: string;
  removeCandidateIds: string[];
  confidence: number;
  reason: string;
};

export type FfprobeMetadata = {
  durationMs: number;
  width?: number;
  height?: number;
  fpsNum?: number;
  fpsDen?: number;
  videoCodec?: string;
  audioCodec?: string;
  pixelFormat?: string;
  bitRate?: number;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  hdrType: HdrType;
  rotationDegrees?: number;
};

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const PLAN_LIMITS: Record<
  PlanId,
  { maxUploadBytes: number; maxDurationSeconds: number; monthlyUploadSeconds: number }
> = {
  free: {
    maxUploadBytes: 2 * 1024 * 1024 * 1024,
    maxDurationSeconds: 15 * 60,
    monthlyUploadSeconds: 30 * 60,
  },
  creator: {
    maxUploadBytes: 10 * 1024 * 1024 * 1024,
    maxDurationSeconds: 45 * 60,
    monthlyUploadSeconds: 180 * 60,
  },
  pro: {
    maxUploadBytes: DEFAULT_MAX_VIDEO_BYTES,
    maxDurationSeconds: DEFAULT_MAX_VIDEO_DURATION_SECONDS,
    monthlyUploadSeconds: 600 * 60,
  },
};
