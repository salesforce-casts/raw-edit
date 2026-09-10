import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Word } from "@raw-edit/contracts";

export const videoStatusEnum = pgEnum("video_status", [
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
]);

export const sourceTypeEnum = pgEnum("source_type", [
  "upload",
  "google_drive",
  "dropbox",
  "onedrive",
  "icloud",
  "url",
]);

export const jobTypeEnum = pgEnum("job_type", [
  "ANALYZE_VIDEO",
  "TRANSCRIBE_VIDEO",
  "DETECT_AUTOMATIC_EDITS",
  "RENDER_EXPORT",
  "DELETE_VIDEO",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "QUEUED",
  "RUNNING",
  "ACTIVE",
  "SUCCEEDED",
  "COMPLETED",
  "FAILED",
  "DEAD",
  "DEAD_LETTER",
]);

export const uploadStatusEnum = pgEnum("upload_status", [
  "INITIATED",
  "UPLOADING",
  "COMPLETING",
  "COMPLETED",
  "ABORTED",
  "EXPIRED",
]);

export const editActionEnum = pgEnum("edit_action", ["KEEP", "REMOVE"]);
export const editSourceEnum = pgEnum("edit_source", [
  "AUTO_SILENCE",
  "AUTO_RETAKE",
  "AUTO_FILLER",
  "USER",
  "SYSTEM",
]);
export const exportPresetEnum = pgEnum("export_preset", [
  "HIGH_QUALITY",
  "SOCIAL",
  "SMALLER_FILE",
  "HEVC_HIGH_QUALITY",
]);
export const exportStrategyEnum = pgEnum("export_strategy", ["PRESERVE_HDR", "COMPATIBLE_SDR"]);
export const exportStatusEnum = pgEnum("export_status", ["PENDING", "RENDERING", "COMPLETE", "FAILED"]);
export const usageTypeEnum = pgEnum("usage_type", [
  "UPLOAD_SECONDS",
  "TRANSCRIPTION_SECONDS",
  "RENDER_SECONDS",
  "STORAGE_BYTE_HOURS",
]);
export const planEnum = pgEnum("plan", ["free", "creator", "pro"]);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  retentionDays: integer("retention_days").notNull().default(0),
  silenceThresholdMs: integer("silence_threshold_ms").notNull().default(1000),
  preRollMs: integer("pre_roll_ms").notNull().default(150),
  postRollMs: integer("post_roll_ms").notNull().default(200),
  removeFillers: boolean("remove_fillers").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  plan: planEnum("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const videos = pgTable(
  "videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: videoStatusEnum("status").notNull().default("CREATED"),
    sourceType: sourceTypeEnum("source_type").notNull().default("upload"),
    originalFilename: text("original_filename").notNull(),
    sourceStorageKey: text("source_storage_key"),
    proxyStorageKey: text("proxy_storage_key"),
    thumbStorageKey: text("thumb_storage_key"),
    audioStorageKey: text("audio_storage_key"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sourceSha256: text("source_sha256"),
    clientSha256: text("client_sha256"),
    r2Etag: text("r2_etag"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    width: integer("width"),
    height: integer("height"),
    fpsNum: integer("fps_num"),
    fpsDen: integer("fps_den"),
    videoCodec: text("video_codec"),
    audioCodec: text("audio_codec"),
    pixelFormat: text("pixel_format"),
    bitRate: bigint("bit_rate", { mode: "number" }),
    colorSpace: text("color_space"),
    colorTransfer: text("color_transfer"),
    colorPrimaries: text("color_primaries"),
    hdrType: text("hdr_type"),
    rotationDegrees: integer("rotation_degrees"),
    language: text("language"),
    progress: integer("progress").notNull().default(0),
    progressMessage: text("progress_message"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    silenceThresholdMs: integer("silence_threshold_ms").notNull().default(1000),
    preRollMs: integer("pre_roll_ms").notNull().default(150),
    postRollMs: integer("post_roll_ms").notNull().default(200),
    removeFillers: boolean("remove_fillers").notNull().default(false),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("videos_user_created_idx").on(table.userId, table.createdAt),
    index("videos_status_idx").on(table.status),
    index("videos_deleted_at_idx").on(table.deletedAt),
    index("videos_delete_after_idx").on(table.deleteAfter),
  ],
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    providerUploadId: text("provider_upload_id"),
    storageKey: text("storage_key").notNull(),
    uploadType: text("upload_type").notNull(),
    partSizeBytes: bigint("part_size_bytes", { mode: "number" }),
    totalParts: integer("total_parts"),
    totalBytes: bigint("total_bytes", { mode: "number" }),
    status: uploadStatusEnum("status").notNull().default("INITIATED"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("upload_sessions_video_id_idx").on(table.videoId)],
);

export const uploadParts = pgTable(
  "upload_parts",
  {
    uploadSessionId: uuid("upload_session_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    etag: text("etag"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.uploadSessionId, table.partNumber] })],
);

export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    type: jobTypeEnum("type").notNull(),
    status: jobStatusEnum("status").notNull().default("QUEUED"),
    bullmqJobId: text("bullmq_job_id"),
    idempotencyKey: text("idempotency_key"),
    inputVersion: text("input_version"),
    progress: integer("progress").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorClass: text("error_class"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("processing_jobs_idempotency_idx").on(table.idempotencyKey),
    index("processing_jobs_video_idx").on(table.videoId, table.type),
    index("processing_jobs_status_idx").on(table.status, table.type),
    index("processing_jobs_heartbeat_idx").on(table.status, table.heartbeatAt),
  ],
);

export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    language: text("language"),
    fullText: text("full_text").notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("transcripts_video_id_idx").on(table.videoId)],
);

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
    text: text("text").notNull(),
    confidence: real("confidence"),
    wordsJson: jsonb("words_json").$type<Word[]>().notNull().default([]),
  },
  (table) => [index("transcript_segments_seq_idx").on(table.transcriptId, table.sequenceNumber)],
);

export const detectedTakeGroups = pgTable("detected_take_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  videoId: uuid("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  similarityScore: real("similarity_score").notNull(),
  confidence: real("confidence").notNull(),
  selectedSegmentId: uuid("selected_segment_id"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const detectedTakeSegments = pgTable("detected_take_segments", {
  id: uuid("id").primaryKey().defaultRandom(),
  takeGroupId: uuid("take_group_id")
    .notNull()
    .references(() => detectedTakeGroups.id, { onDelete: "cascade" }),
  startMs: bigint("start_ms", { mode: "number" }).notNull(),
  endMs: bigint("end_ms", { mode: "number" }).notNull(),
  text: text("text").notNull(),
  completenessScore: real("completeness_score").notNull(),
  fluencyScore: real("fluency_score").notNull(),
  semanticScore: real("semantic_score").notNull(),
  isSelected: boolean("is_selected").notNull().default(false),
});

export const editVersions = pgTable(
  "edit_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    createdBy: text("created_by"),
    isCurrent: boolean("is_current").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("edit_versions_video_version_idx").on(table.videoId, table.versionNumber)],
);

export const editSegments = pgTable(
  "edit_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    editVersionId: uuid("edit_version_id")
      .notNull()
      .references(() => editVersions.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
    action: editActionEnum("action").notNull(),
    source: editSourceEnum("source").notNull(),
    reason: text("reason"),
    confidence: real("confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("edit_segments_version_idx").on(table.editVersionId, table.sequenceNumber)],
);

export const editOverrides = pgTable(
  "edit_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
    action: editActionEnum("action").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("edit_overrides_video_idx").on(table.videoId, table.sequenceNumber)],
);

export const exports = pgTable(
  "exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    editVersionId: uuid("edit_version_id")
      .notNull()
      .references(() => editVersions.id, { onDelete: "restrict" }),
    preset: exportPresetEnum("preset").notNull(),
    strategy: exportStrategyEnum("strategy").notNull().default("COMPATIBLE_SDR"),
    status: exportStatusEnum("status").notNull().default("PENDING"),
    storageKey: text("storage_key"),
    width: integer("width"),
    height: integer("height"),
    fpsNum: integer("fps_num"),
    fpsDen: integer("fps_den"),
    videoCodec: text("video_codec"),
    audioCodec: text("audio_codec"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    progress: integer("progress").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("exports_video_idx").on(table.videoId)],
);

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exportId: uuid("export_id")
      .notNull()
      .references(() => exports.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("share_links_token_hash_idx").on(table.tokenHash)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    videoId: uuid("video_id"),
    type: usageTypeEnum("type").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    unit: text("unit").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("usage_records_user_type_idx").on(table.userId, table.type, table.createdAt)],
);

export const videosRelations = relations(videos, ({ one, many }) => ({
  user: one(user, { fields: [videos.userId], references: [user.id] }),
  uploadSession: one(uploadSessions, { fields: [videos.id], references: [uploadSessions.videoId] }),
  jobs: many(processingJobs),
  transcript: one(transcripts, { fields: [videos.id], references: [transcripts.videoId] }),
  editVersions: many(editVersions),
  exports: many(exports),
}));

export const editVersionsRelations = relations(editVersions, ({ one, many }) => ({
  video: one(videos, { fields: [editVersions.videoId], references: [videos.id] }),
  segments: many(editSegments),
}));

export const editSegmentsRelations = relations(editSegments, ({ one }) => ({
  version: one(editVersions, { fields: [editSegments.editVersionId], references: [editVersions.id] }),
}));
