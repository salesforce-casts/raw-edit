ALTER TYPE video_status ADD VALUE IF NOT EXISTS 'DETECTING_TAKES';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'RUNNING';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'SUCCEEDED';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'DEAD';
ALTER TYPE export_preset ADD VALUE IF NOT EXISTS 'SOCIAL';
ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'url';

UPDATE videos SET status = 'DETECTING_TAKES' WHERE status = 'DETECTING_EDITS';
UPDATE processing_jobs SET status = 'RUNNING' WHERE status = 'ACTIVE';
UPDATE processing_jobs SET status = 'SUCCEEDED' WHERE status = 'COMPLETED';
UPDATE processing_jobs SET status = 'DEAD' WHERE status = 'DEAD_LETTER';

ALTER TABLE videos ADD COLUMN IF NOT EXISTS client_sha256 text;

ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS input_version text;
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS error_class text;
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS processing_jobs_idempotency_idx ON processing_jobs (idempotency_key);
CREATE INDEX IF NOT EXISTS processing_jobs_heartbeat_idx ON processing_jobs (status, heartbeat_at);

CREATE TABLE IF NOT EXISTS edit_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL,
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  action edit_action NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS edit_overrides_video_idx ON edit_overrides (video_id, sequence_number);
