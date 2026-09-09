import { pgEnum } from 'drizzle-orm/pg-core';
import {
  EXPORT_PRESETS,
  EXPORT_STATUSES,
  EXPORT_STRATEGIES,
  JOB_STATUSES,
  JOB_TYPES,
  PLAN_TIERS,
  RETENTION_POLICIES,
  SOURCE_KINDS,
  UPLOAD_STATUSES,
  USAGE_KINDS,
  VIDEO_STATUSES,
} from '@rawedit/core';

/** Enum values come from @rawedit/core so the database and the app cannot drift. */
export const videoStatusEnum = pgEnum('video_status', VIDEO_STATUSES);
export const uploadStatusEnum = pgEnum('upload_status', UPLOAD_STATUSES);
export const jobTypeEnum = pgEnum('job_type', JOB_TYPES);
export const jobStatusEnum = pgEnum('job_status', JOB_STATUSES);
export const sourceKindEnum = pgEnum('source_kind', SOURCE_KINDS);
export const exportStatusEnum = pgEnum('export_status', EXPORT_STATUSES);
export const exportPresetEnum = pgEnum('export_preset', EXPORT_PRESETS);
export const exportStrategyEnum = pgEnum('export_strategy', EXPORT_STRATEGIES);
export const planTierEnum = pgEnum('plan_tier', PLAN_TIERS);
export const usageKindEnum = pgEnum('usage_kind', USAGE_KINDS);
export const retentionPolicyEnum = pgEnum('retention_policy', RETENTION_POLICIES);
export const decisionActionEnum = pgEnum('decision_action', ['keep', 'remove']);
export const decisionKindEnum = pgEnum('decision_kind', ['silence', 'retake', 'filler', 'manual']);
export const decisionSourceEnum = pgEnum('decision_source', ['auto', 'user']);
