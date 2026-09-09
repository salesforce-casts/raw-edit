import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { video } from './video.js';
import {
  decisionActionEnum,
  decisionKindEnum,
  decisionSourceEnum,
  exportPresetEnum,
  exportStatusEnum,
  exportStrategyEnum,
} from './enums.js';

/**
 * The EDL. Rows are append-only in spirit: a user override inserts a new row and
 * flips `active` on the old one, so the automatic proposal is always recoverable and
 * "Reset automatic edits" never needs to re-run transcription.
 */
export const editDecision = pgTable(
  'edit_decision',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    index: integer('index').notNull().default(0),

    startTime: doublePrecision('start_time').notNull(),
    endTime: doublePrecision('end_time').notNull(),
    action: decisionActionEnum('action').notNull(),
    kind: decisionKindEnum('kind').notNull(),
    reason: text('reason').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    source: decisionSourceEnum('source').notNull().default('auto'),

    takeId: text('take_id'),
    segmentIndex: integer('segment_index'),

    /** Set when a later row replaces this one; the history is never destroyed. */
    supersededBy: text('superseded_by'),
    active: boolean('active').notNull().default(true),
    /** Bumped whenever the active set changes; renders are keyed to a version. */
    edlVersion: integer('edl_version').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('edit_decision_video_active_idx').on(table.videoId, table.active, table.startTime),
    index('edit_decision_take_idx').on(table.takeId),
  ],
);

/** The settings that produced the current EDL, so the proposal is reproducible. */
export const editSettings = pgTable(
  'edit_settings',
  {
    videoId: text('video_id')
      .primaryKey()
      .references(() => video.id, { onDelete: 'cascade' }),
    edlVersion: integer('edl_version').notNull().default(1),
    silenceThresholdSeconds: doublePrecision('silence_threshold_seconds').notNull().default(1),
    padPreMs: integer('pad_pre_ms').notNull().default(160),
    padPostMs: integer('pad_post_ms').notNull().default(200),
    removeFillerWords: boolean('remove_filler_words').notNull().default(false),
    detectRetakes: boolean('detect_retakes').notNull().default(true),
    removeSilence: boolean('remove_silence').notNull().default(true),
    minSegmentSeconds: doublePrecision('min_segment_seconds').notNull().default(0.35),
    mergeGapMs: integer('merge_gap_ms').notNull().default(120),
    retakeSimilarityThreshold: doublePrecision('retake_similarity_threshold').notNull().default(0.72),
    retakeMinOpeningTokens: integer('retake_min_opening_tokens').notNull().default(3),
    retakeLookaheadSegments: integer('retake_lookahead_segments').notNull().default(6),
    retakeLookaheadSeconds: doublePrecision('retake_lookahead_seconds').notNull().default(60),
    /** User overrides replayed over the automatic proposal (undo/redo history). */
    overrides: jsonb('overrides').notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const videoExport = pgTable(
  'export',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    preset: exportPresetEnum('preset').notNull().default('ORIGINAL_QUALITY'),
    strategy: exportStrategyEnum('strategy').notNull().default('PRESERVE_SOURCE'),
    status: exportStatusEnum('status').notNull().default('QUEUED'),
    progress: integer('progress').notNull().default(0),

    storageKey: text('storage_key'),
    fileSize: bigint('file_size', { mode: 'number' }),
    duration: doublePrecision('duration'),
    width: integer('width'),
    height: integer('height'),
    frameRate: doublePrecision('frame_rate'),
    videoCodec: text('video_codec'),
    audioCodec: text('audio_codec'),
    container: text('container').notNull().default('mp4'),
    estimatedSize: bigint('estimated_size', { mode: 'number' }),

    edlVersion: integer('edl_version').notNull().default(1),
    /** The exact ffmpeg invocation, kept for support and reproducibility. */
    ffmpegCommand: text('ffmpeg_command'),
    renderLog: text('render_log'),
    /** e.g. Dolby Vision RPU dropped, VFR normalised — surfaced in the UI. */
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('export_video_idx').on(table.videoId, table.createdAt),
    index('export_user_idx').on(table.userId, table.status),
  ],
);

export const shareLink = pgTable(
  'share_link',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    exportId: text('export_id')
      .notNull()
      .references(() => videoExport.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    allowDownload: boolean('allow_download').notNull().default(true),
    /** Null means the link never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('share_link_slug_idx').on(table.slug),
    index('share_link_video_idx').on(table.videoId),
  ],
);
