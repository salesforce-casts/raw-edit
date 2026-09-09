import {
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
import { jobStatusEnum, jobTypeEnum } from './enums.js';
import type { TakeScoreBreakdown } from '@rawedit/core';

/**
 * Durable mirror of every queued job. BullMQ owns execution; this table owns truth,
 * so state survives a Redis flush and the browser never needs to stay open.
 */
export const processingJob = pgTable(
  'processing_job',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    type: jobTypeEnum('type').notNull(),
    status: jobStatusEnum('status').notNull().default('QUEUED'),
    queueJobId: text('queue_job_id'),

    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),

    progress: integer('progress').notNull().default(0),
    progressStage: text('progress_stage'),

    payload: jsonb('payload'),
    result: jsonb('result'),
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),

    /** sha256(videoId | type | input version) — a replayed enqueue is a no-op. */
    idempotencyKey: text('idempotency_key').notNull(),

    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    /** A RUNNING job whose heartbeat goes stale is reclaimable by the sweeper. */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),

    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('processing_job_idempotency_idx').on(table.idempotencyKey),
    index('processing_job_video_idx').on(table.videoId, table.type),
    index('processing_job_status_idx').on(table.status, table.heartbeatAt),
    index('processing_job_user_active_idx').on(table.userId, table.status),
  ],
);

export const transcript = pgTable(
  'transcript',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model'),
    language: text('language'),
    duration: doublePrecision('duration'),
    wordCount: integer('word_count').notNull().default(0),
    confidence: doublePrecision('confidence'),
    /** Provider payload, so segmentation can be redone without paying again. */
    rawJson: jsonb('raw_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('transcript_video_idx').on(table.videoId)],
);

export const transcriptSegment = pgTable(
  'transcript_segment',
  {
    id: text('id').primaryKey(),
    transcriptId: text('transcript_id')
      .notNull()
      .references(() => transcript.id, { onDelete: 'cascade' }),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    startTime: doublePrecision('start_time').notNull(),
    endTime: doublePrecision('end_time').notNull(),
    text: text('text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    confidence: doublePrecision('confidence'),
    isCompleteSentence: boolean('is_complete_sentence').notNull().default(false),
    fillerCount: integer('filler_count').notNull().default(0),
    internalPauseCount: integer('internal_pause_count').notNull().default(0),
    takeGroupId: text('take_group_id'),
  },
  (table) => [
    index('transcript_segment_video_idx').on(table.videoId, table.index),
    index('transcript_segment_time_idx').on(table.videoId, table.startTime),
  ],
);

export const transcriptWord = pgTable(
  'transcript_word',
  {
    id: text('id').primaryKey(),
    transcriptId: text('transcript_id')
      .notNull()
      .references(() => transcript.id, { onDelete: 'cascade' }),
    segmentId: text('segment_id')
      .notNull()
      .references(() => transcriptSegment.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    startTime: doublePrecision('start_time').notNull(),
    endTime: doublePrecision('end_time').notNull(),
    text: text('text').notNull(),
    confidence: doublePrecision('confidence'),
    isFiller: boolean('is_filler').notNull().default(false),
  },
  (table) => [index('transcript_word_segment_idx').on(table.segmentId, table.index)],
);

/** A cluster of utterances that are attempts at the same sentence. */
export const detectedTake = pgTable(
  'detected_take',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    groupIndex: integer('group_index').notNull(),
    canonicalText: text('canonical_text').notNull(),
    memberCount: integer('member_count').notNull(),
    chosenSegmentId: text('chosen_segment_id'),
    chosenSegmentIndex: integer('chosen_segment_index').notNull(),
    similarity: doublePrecision('similarity').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('detected_take_video_idx').on(table.videoId, table.groupIndex)],
);

export const detectedTakeMember = pgTable(
  'detected_take_member',
  {
    id: text('id').primaryKey(),
    takeId: text('take_id')
      .notNull()
      .references(() => detectedTake.id, { onDelete: 'cascade' }),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    segmentIndex: integer('segment_index').notNull(),
    index: integer('index').notNull(),
    startTime: doublePrecision('start_time').notNull(),
    endTime: doublePrecision('end_time').notNull(),
    text: text('text').notNull(),
    isChosen: boolean('is_chosen').notNull().default(false),
    score: doublePrecision('score').notNull(),
    /** Why this member won or lost — shown in the review UI. */
    scoreBreakdown: jsonb('score_breakdown').$type<TakeScoreBreakdown>(),
  },
  (table) => [index('detected_take_member_take_idx').on(table.takeId, table.index)],
);
