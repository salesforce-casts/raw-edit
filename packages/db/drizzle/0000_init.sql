CREATE TYPE video_status AS ENUM (
  'CREATED', 'UPLOADING', 'UPLOADED', 'ANALYZING', 'TRANSCRIBING',
  'DETECTING_EDITS', 'READY_FOR_REVIEW', 'RENDERING', 'COMPLETE',
  'FAILED', 'DELETING', 'DELETED'
);
CREATE TYPE source_type AS ENUM ('upload', 'google_drive', 'dropbox', 'onedrive', 'icloud');
CREATE TYPE job_type AS ENUM (
  'ANALYZE_VIDEO', 'TRANSCRIBE_VIDEO', 'DETECT_AUTOMATIC_EDITS', 'RENDER_EXPORT', 'DELETE_VIDEO'
);
CREATE TYPE job_status AS ENUM ('QUEUED', 'ACTIVE', 'COMPLETED', 'FAILED', 'DEAD_LETTER');
CREATE TYPE upload_status AS ENUM ('INITIATED', 'UPLOADING', 'COMPLETING', 'COMPLETED', 'ABORTED', 'EXPIRED');
CREATE TYPE edit_action AS ENUM ('KEEP', 'REMOVE');
CREATE TYPE edit_source AS ENUM ('AUTO_SILENCE', 'AUTO_RETAKE', 'AUTO_FILLER', 'USER', 'SYSTEM');
CREATE TYPE export_preset AS ENUM ('HIGH_QUALITY', 'SMALLER_FILE', 'HEVC_HIGH_QUALITY');
CREATE TYPE export_strategy AS ENUM ('PRESERVE_HDR', 'COMPATIBLE_SDR');
CREATE TYPE export_status AS ENUM ('PENDING', 'RENDERING', 'COMPLETE', 'FAILED');
CREATE TYPE usage_type AS ENUM ('UPLOAD_SECONDS', 'TRANSCRIPTION_SECONDS', 'RENDER_SECONDS', 'STORAGE_BYTE_HOURS');
CREATE TYPE plan AS ENUM ('free', 'creator', 'pro');

CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_id_idx ON session (user_id);

CREATE TABLE account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_user_id_idx ON account (user_id);

CREATE TABLE verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_profiles (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  retention_days integer NOT NULL DEFAULT 0,
  silence_threshold_ms integer NOT NULL DEFAULT 1000,
  pre_roll_ms integer NOT NULL DEFAULT 150,
  post_roll_ms integer NOT NULL DEFAULT 200,
  remove_fillers boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  plan plan NOT NULL DEFAULT 'free',
  status text NOT NULL DEFAULT 'active',
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status video_status NOT NULL DEFAULT 'CREATED',
  source_type source_type NOT NULL DEFAULT 'upload',
  original_filename text NOT NULL,
  source_storage_key text,
  proxy_storage_key text,
  thumb_storage_key text,
  audio_storage_key text,
  mime_type text,
  size_bytes bigint,
  source_sha256 text,
  r2_etag text,
  duration_ms bigint,
  width integer,
  height integer,
  fps_num integer,
  fps_den integer,
  video_codec text,
  audio_codec text,
  pixel_format text,
  bit_rate bigint,
  color_space text,
  color_transfer text,
  color_primaries text,
  hdr_type text,
  rotation_degrees integer,
  language text,
  progress integer NOT NULL DEFAULT 0,
  progress_message text,
  error_code text,
  error_message text,
  silence_threshold_ms integer NOT NULL DEFAULT 1000,
  pre_roll_ms integer NOT NULL DEFAULT 150,
  post_roll_ms integer NOT NULL DEFAULT 200,
  remove_fillers boolean NOT NULL DEFAULT false,
  delete_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX videos_user_created_idx ON videos (user_id, created_at DESC);
CREATE INDEX videos_status_idx ON videos (status);
CREATE INDEX videos_deleted_at_idx ON videos (deleted_at);
CREATE INDEX videos_delete_after_idx ON videos (delete_after);

CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  provider_upload_id text,
  storage_key text NOT NULL,
  upload_type text NOT NULL,
  part_size_bytes bigint,
  total_parts integer,
  total_bytes bigint,
  status upload_status NOT NULL DEFAULT 'INITIATED',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE upload_parts (
  upload_session_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number integer NOT NULL,
  etag text,
  size_bytes bigint,
  completed_at timestamptz,
  PRIMARY KEY (upload_session_id, part_number)
);

CREATE TABLE processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  type job_type NOT NULL,
  status job_status NOT NULL DEFAULT 'QUEUED',
  bullmq_job_id text,
  progress integer NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  locked_by text,
  locked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processing_jobs_video_idx ON processing_jobs (video_id, type);
CREATE INDEX processing_jobs_status_idx ON processing_jobs (status, type);

CREATE TABLE transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  language text,
  full_text text NOT NULL,
  duration_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL,
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  text text NOT NULL,
  confidence real,
  words_json jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX transcript_segments_seq_idx ON transcript_segments (transcript_id, sequence_number);

CREATE TABLE detected_take_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  similarity_score real NOT NULL,
  confidence real NOT NULL,
  selected_segment_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE detected_take_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  take_group_id uuid NOT NULL REFERENCES detected_take_groups(id) ON DELETE CASCADE,
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  text text NOT NULL,
  completeness_score real NOT NULL,
  fluency_score real NOT NULL,
  semantic_score real NOT NULL,
  is_selected boolean NOT NULL DEFAULT false
);

CREATE TABLE edit_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  created_by text,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, version_number)
);

CREATE TABLE edit_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edit_version_id uuid NOT NULL REFERENCES edit_versions(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL,
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  action edit_action NOT NULL,
  source edit_source NOT NULL,
  reason text,
  confidence real,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX edit_segments_version_idx ON edit_segments (edit_version_id, sequence_number);

CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  edit_version_id uuid NOT NULL REFERENCES edit_versions(id) ON DELETE RESTRICT,
  preset export_preset NOT NULL,
  strategy export_strategy NOT NULL DEFAULT 'COMPATIBLE_SDR',
  status export_status NOT NULL DEFAULT 'PENDING',
  storage_key text,
  width integer,
  height integer,
  fps_num integer,
  fps_den integer,
  video_codec text,
  audio_codec text,
  size_bytes bigint,
  duration_ms bigint,
  progress integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX exports_video_idx ON exports (video_id);

CREATE TABLE share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id uuid NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  video_id uuid,
  type usage_type NOT NULL,
  quantity bigint NOT NULL,
  unit text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_user_type_idx ON usage_records (user_id, type, created_at);
