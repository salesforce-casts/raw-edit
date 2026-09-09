import {
  boolean,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { video } from './video.js';
import { exportPresetEnum, planTierEnum, retentionPolicyEnum, usageKindEnum } from './enums.js';

/** Editing defaults so a new upload inherits the creator's last-used configuration. */
export const userSettings = pgTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  silenceThresholdSeconds: doublePrecision('silence_threshold_seconds').notNull().default(1),
  padPreMs: integer('pad_pre_ms').notNull().default(160),
  padPostMs: integer('pad_post_ms').notNull().default(200),
  /** Off by default: removing fillers cleanly can create unnatural cuts. */
  removeFillerWords: boolean('remove_filler_words').notNull().default(false),
  detectRetakes: boolean('detect_retakes').notNull().default(true),
  removeSilence: boolean('remove_silence').notNull().default(true),
  minSegmentSeconds: doublePrecision('min_segment_seconds').notNull().default(0.35),
  defaultExportPreset: exportPresetEnum('default_export_preset').notNull().default('ORIGINAL_QUALITY'),
  sourceRetention: retentionPolicyEnum('source_retention').notNull().default('NEVER'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscription = pgTable(
  'subscription',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    tier: planTierEnum('tier').notNull().default('FREE'),
    status: text('status').notNull().default('active'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    provider: text('provider'),
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('subscription_user_idx').on(table.userId)],
);

/**
 * Append-only usage ledger. Quota checks aggregate over `periodKey` (YYYY-MM), which
 * keeps the check a single indexed scan rather than a running counter that can drift.
 */
export const usageRecord = pgTable(
  'usage_record',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    videoId: text('video_id').references(() => video.id, { onDelete: 'set null' }),
    kind: usageKindEnum('kind').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    unit: text('unit').notNull(),
    periodKey: text('period_key').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('usage_record_user_period_idx').on(table.userId, table.periodKey, table.kind),
    index('usage_record_video_idx').on(table.videoId),
  ],
);
