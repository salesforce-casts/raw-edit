-- Rolls back 0002_script_pass.sql.
-- Postgres cannot DROP an enum value, so AUTO_SCRIPT rows are remapped and the
-- type is recreated without that label.

UPDATE edit_segments SET source = 'AUTO_RETAKE' WHERE source = 'AUTO_SCRIPT';

ALTER TABLE edit_segments ALTER COLUMN source TYPE text USING source::text;
DROP TYPE IF EXISTS edit_source;
CREATE TYPE edit_source AS ENUM ('AUTO_SILENCE', 'AUTO_RETAKE', 'AUTO_FILLER', 'USER', 'SYSTEM');
ALTER TABLE edit_segments ALTER COLUMN source TYPE edit_source USING source::edit_source;

ALTER TABLE videos DROP COLUMN IF EXISTS pacing_preset;
ALTER TABLE videos DROP COLUMN IF EXISTS keyframe_ms;
ALTER TABLE videos DROP COLUMN IF EXISTS filmstrip_storage_key;
ALTER TABLE videos DROP COLUMN IF EXISTS script_pass_warning;

ALTER TABLE user_profiles DROP COLUMN IF EXISTS pacing_preset;

ALTER TABLE edit_versions DROP COLUMN IF EXISTS prompt_version;
ALTER TABLE edit_versions DROP COLUMN IF EXISTS script_pass_model;
ALTER TABLE edit_versions DROP COLUMN IF EXISTS script_pass_cache_key;
ALTER TABLE edit_versions DROP COLUMN IF EXISTS script_pass_decisions;

ALTER TABLE processing_jobs DROP COLUMN IF EXISTS stage_durations;
