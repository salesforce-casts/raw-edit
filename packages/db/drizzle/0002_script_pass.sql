ALTER TYPE edit_source ADD VALUE IF NOT EXISTS 'AUTO_SCRIPT';

ALTER TABLE videos ADD COLUMN IF NOT EXISTS pacing_preset text NOT NULL DEFAULT 'natural';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS keyframe_ms jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS filmstrip_storage_key text;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS script_pass_warning text;

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS pacing_preset text NOT NULL DEFAULT 'natural';

ALTER TABLE edit_versions ADD COLUMN IF NOT EXISTS prompt_version text;
ALTER TABLE edit_versions ADD COLUMN IF NOT EXISTS script_pass_model text;
ALTER TABLE edit_versions ADD COLUMN IF NOT EXISTS script_pass_cache_key text;
ALTER TABLE edit_versions ADD COLUMN IF NOT EXISTS script_pass_decisions jsonb;

ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS stage_durations jsonb;
