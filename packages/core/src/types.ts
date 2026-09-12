export const VIDEO_STATUSES = [
  "CREATED",
  "UPLOADING",
  "UPLOADED",
  "ANALYZING",
  "TRANSCRIBING",
  "DETECTING_TAKES",
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
  "DETECTING_TAKES",
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
  "url",
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
  "RUNNING",
  "ACTIVE",
  "SUCCEEDED",
  "COMPLETED",
  "FAILED",
  "DEAD",
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

export const EDIT_SOURCES = ["AUTO_SILENCE", "AUTO_RETAKE", "AUTO_FILLER", "AUTO_SCRIPT", "USER", "SYSTEM"] as const;
export type EditSource = (typeof EDIT_SOURCES)[number];

export const PACING_PRESETS = ["natural", "tight", "very_tight"] as const;
export type PacingPreset = (typeof PACING_PRESETS)[number];

export const SCRIPT_PASS_CATEGORIES = ["retake", "falseStart", "filler", "tangent"] as const;
export type ScriptPassCategory = (typeof SCRIPT_PASS_CATEGORIES)[number];

export const EXPORT_PRESETS = ["HIGH_QUALITY", "SOCIAL", "SMALLER_FILE", "HEVC_HIGH_QUALITY"] as const;
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
  "IMPORT_BLOCKED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const PERMANENT_ERROR_CODES: ErrorCode[] = [
  "INVALID_MEDIA",
  "UNSUPPORTED_CODEC",
  "SOURCE_MISSING",
  "SOURCE_HASH_MISMATCH",
  "UPLOAD_SIZE_MISMATCH",
  "IMPORT_BLOCKED",
];

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
  sourceProbe: 60 * 60,
} as const;

export const MULTIPART_MIN_PART_BYTES = 8 * 1024 * 1024;
export const MULTIPART_MAX_PART_BYTES = 512 * 1024 * 1024;
export const MULTIPART_TARGET_PARTS = 9000;
export const MULTIPART_S3_MAX_PARTS = 10_000;
export const MULTIPART_PART_SIZE_BYTES = 64 * 1024 * 1024;
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const PRESIGN_BATCH_SIZE = 10;
export const MOBILE_UPLOAD_CONCURRENCY = 3;
export const DESKTOP_UPLOAD_CONCURRENCY = 5;
export const PART_RETRIES = 3;
export const DEFAULT_MAX_VIDEO_BYTES = 20 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_VIDEO_DURATION_SECONDS = 60 * 60;
export const MAX_ACTIVE_RENDERS_PER_USER = 1;
export const MAX_CONCURRENT_JOBS_PER_USER = 1;
export const JOB_HEARTBEAT_MS = 10_000;
export const JOB_STALE_MS = 90_000;
export const JOB_RETRY_DELAYS_MS = [10_000, 60_000, 300_000] as const;
export const SELECT_FILTER_SEGMENT_LIMIT = 400;
export const RETAKE_CANDIDATE_WINDOW_MS = 45_000;
export const RETAKE_MIN_WORDS = 3;
export const RETAKE_CANDIDATE_THRESHOLD = 0.8;
export const RETAKE_PREFIX_FLOOR = 0.93;
export const RETAKE_AUTO_REMOVE_MIN_CONFIDENCE = 0.75;
export const RETAKE_AI_MARGIN = 0.6;
export const DEFAULT_SILENCE_THRESHOLD_DB = -35;
export const DEFAULT_MIN_SILENCE_MS = 400;
export const DEFAULT_PRE_ROLL_MS = 80;
export const DEFAULT_POST_ROLL_MS = 60;
export const HEAD_TAIL_KEEP_MS = 120;
export const INTERNAL_PAUSE_MS = 800;
export const ACOUSTIC_MIN_SILENCE_MS = 80;
export const KEYFRAME_SNAP_MS = 200;
export const SCRIPT_PASS_CHUNK_WORDS = 1500;
export const SCRIPT_PASS_CHUNK_OVERLAP_WORDS = 200;
export const SCRIPT_PASS_BATCH_REMOVAL_BUDGET = 0.6;
export const SCRIPT_PASS_SINGLE_REMOVAL_BUDGET = 0.3;
export const SCRIPT_PASS_CONFIDENCE_FLOOR = 0.75;
export const SCRIPT_PASS_PROMPT_VERSION = "script-pass.v3";
export const CANONICAL_SCRIPT_PROMPT_VERSION = "canonical-script.v3";
export const DEFAULT_PACING_PRESET: PacingPreset = "natural";
export const SILENCE_THRESHOLD_OPTIONS_MS = [500, 1000, 1500, 2000, 3000] as const;
export const SHARE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXY";
export const SHARE_SLUG_LENGTH = 12;

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

export type EditOverride = {
  startMs: number;
  endMs: number;
  action: EditAction;
  reason?: string;
};

export type ScriptPassDecision = {
  fromWord: number;
  toWord: number;
  category: ScriptPassCategory;
  reason: string;
  confidence: number;
};

export type CanonicalSourceSpan = {
  fromWordId: string;
  toWordId: string;
  reason: string;
  confidence: number;
};

export type CanonicalScriptPlan = {
  version: typeof CANONICAL_SCRIPT_PROMPT_VERSION;
  keepSpans: CanonicalSourceSpan[];
  restoreSpans: CanonicalSourceSpan[];
  cleanedScript?: string;
  alignmentCoverage?: number;
  summary?: string;
};

export type EditDecisionList = {
  videoId: string;
  version: number;
  segments: EditSegment[];
  promptVersion?: string;
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
  keeperScore: number;
};

export type TakeCandidateGroup = {
  id: string;
  similarityScore: number;
  confidence: number;
  candidates: TakeCandidate[];
};

export type TakeDecision = {
  keepCandidateId: string;
  keepCandidateIndex?: number;
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
  masteringDisplay?: string;
  maxCll?: string;
};

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
    public readonly permanent = PERMANENT_ERROR_CODES.includes(code),
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
