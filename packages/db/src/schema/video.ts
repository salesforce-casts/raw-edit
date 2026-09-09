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
import { retentionPolicyEnum, sourceKindEnum, uploadStatusEnum, videoStatusEnum } from './enums.js';
import type { UploadPartRef } from '@rawedit/core';

/**
 * The master record.
 *
 * `storageKey` points at the original file exactly as it was uploaded. Nothing in the
 * system ever writes to that object; every derivative gets its own key.
 */
export const video = pgTable(
  'video',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    title: text('title'),
    originalFilename: text('original_filename').notNull(),
    storageKey: text('storage_key').notNull(),
    storageBucket: text('storage_bucket').notNull(),
    mimeType: text('mime_type').notNull(),
    fileSize: bigint('file_size', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256'),
    checksumVerifiedAt: timestamp('checksum_verified_at', { withTimezone: true }),

    status: videoStatusEnum('status').notNull().default('UPLOADING'),
    statusDetail: text('status_detail'),
    errorMessage: text('error_message'),
    progress: integer('progress').notNull().default(0),

    // Technical metadata, populated by ffprobe after the upload completes.
    duration: doublePrecision('duration'),
    width: integer('width'),
    height: integer('height'),
    rotation: integer('rotation').notNull().default(0),
    displayAspectRatio: text('display_aspect_ratio'),
    frameRate: doublePrecision('frame_rate'),
    avgFrameRate: doublePrecision('avg_frame_rate'),
    isVariableFrameRate: boolean('is_variable_frame_rate').notNull().default(false),
    videoCodec: text('video_codec'),
    videoProfile: text('video_profile'),
    pixelFormat: text('pixel_format'),
    bitDepth: integer('bit_depth'),
    audioCodec: text('audio_codec'),
    audioChannels: integer('audio_channels'),
    audioSampleRate: integer('audio_sample_rate'),
    bitrate: bigint('bitrate', { mode: 'number' }),

    colorPrimaries: text('color_primaries'),
    colorTransfer: text('color_transfer'),
    colorSpace: text('color_space'),
    colorRange: text('color_range'),
    isHdr: boolean('is_hdr').notNull().default(false),
    hdrFormat: text('hdr_format'),
    masterDisplay: text('master_display'),
    maxCll: text('max_cll'),

    /** Full ffprobe JSON, kept verbatim for support and re-analysis. */
    probeJson: jsonb('probe_json'),

    // Preview-only derivatives. Never a render source.
    thumbnailKey: text('thumbnail_key'),
    proxyKey: text('proxy_key'),
    waveformKey: text('waveform_key'),

    // Retention. The original is only ever deleted when a rule explicitly allows it.
    sourceRetention: retentionPolicyEnum('source_retention').notNull().default('NEVER'),
    deleteSourceAfter: timestamp('delete_source_after', { withTimezone: true }),
    sourceDeletedAt: timestamp('source_deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('video_user_created_idx').on(table.userId, table.createdAt),
    index('video_status_idx').on(table.status),
    index('video_retention_idx').on(table.deleteSourceAfter),
  ],
);

/** Where the bytes came from. One row per acquisition attempt. */
export const videoSource = pgTable(
  'video_source',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    kind: sourceKindEnum('kind').notNull(),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    declaredSize: bigint('declared_size', { mode: 'number' }),
    bytesFetched: bigint('bytes_fetched', { mode: 'number' }).notNull().default(0),
    importError: text('import_error'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('video_source_video_idx').on(table.videoId)],
);

/**
 * Server-side record of an R2 multipart upload. This is what makes resume possible
 * after Safari is backgrounded, loses the network, or refreshes the page.
 */
export const uploadSession = pgTable(
  'upload_session',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    storageKey: text('storage_key').notNull(),
    r2UploadId: text('r2_upload_id').notNull(),
    partSize: integer('part_size').notNull(),
    totalParts: integer('total_parts').notNull(),
    fileSize: bigint('file_size', { mode: 'number' }).notNull(),
    /** sha256(name:size:lastModified) — matches a re-picked file to this session. */
    fileFingerprint: text('file_fingerprint').notNull(),
    clientSha256: text('client_sha256'),

    status: uploadStatusEnum('status').notNull().default('PENDING'),
    /** Opportunistic mirror of client reports; R2's ListParts is the authority. */
    parts: jsonb('parts').$type<UploadPartRef[]>().notNull().default([]),
    bytesUploaded: bigint('bytes_uploaded', { mode: 'number' }).notNull().default(0),

    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('upload_session_user_idx').on(table.userId, table.status),
    index('upload_session_expiry_idx').on(table.expiresAt),
    uniqueIndex('upload_session_video_idx').on(table.videoId),
    index('upload_session_fingerprint_idx').on(table.userId, table.fileFingerprint),
  ],
);
