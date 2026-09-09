# 2. Database Schema

PostgreSQL (Neon) via Drizzle ORM. Source of truth: `packages/db/src/schema/*.ts`.
Migrations live in `packages/db/drizzle/`.

## Conventions

* Primary keys are `text` holding a prefixed ULID-ish id (`vid_…`, `job_…`) generated
  in application code so the client can reference a row before it is committed.
* All timestamps are `timestamptz`.
* Every user-owned table carries `user_id` with an index; **every query in the app is
  scoped by `user_id`** (see `apps/web/src/lib/authz.ts`).
* Money-free: usage is tracked in seconds and bytes, never in currency.
* Media times are `double precision` **seconds** — never frames, never milliseconds
  (one unit everywhere removes a whole class of off-by-one bugs).

## Enums

```
video_status      UPLOADING | UPLOADED | ANALYZING | TRANSCRIBING | DETECTING_TAKES
                  | READY_FOR_REVIEW | RENDERING | COMPLETE | FAILED
upload_status     PENDING | IN_PROGRESS | COMPLETED | ABORTED | EXPIRED
job_type          ANALYZE_VIDEO | TRANSCRIBE_AUDIO | DETECT_TAKES | RENDER_VIDEO
                  | IMPORT_SOURCE | GENERATE_PROXY | CLEANUP_SOURCE
job_status        QUEUED | RUNNING | SUCCEEDED | FAILED | DEAD | CANCELLED
source_kind       DIRECT_UPLOAD | GOOGLE_DRIVE | DROPBOX | ONEDRIVE | ICLOUD | URL
decision_kind     SILENCE | RETAKE | FILLER | MANUAL
decision_action   KEEP | REMOVE
export_status     QUEUED | RENDERING | COMPLETE | FAILED
export_preset     ORIGINAL_QUALITY | SOCIAL_MEDIA | SMALLER_FILE
export_strategy   PRESERVE_SOURCE | COMPATIBLE_MP4
plan_tier         FREE | CREATOR | PRO
usage_kind        UPLOADED_MINUTES | TRANSCRIBED_MINUTES | RENDERED_MINUTES | STORAGE_BYTES
retention_policy  DAYS_7 | DAYS_30 | DAYS_90 | NEVER
```

## Tables

### Auth (owned by Better Auth)
`user`, `session`, `account`, `verification` — standard Better Auth Drizzle schema.
`user` is extended with `plan_tier`, `default_retention`, `stripe_customer_id`.

### `user_settings`
Per-creator editing defaults so a new upload inherits the last-used configuration.

```
user_id PK FK->user
silence_threshold_seconds  double  default 1.0
pad_pre_ms                 int     default 160
pad_post_ms                int     default 200
remove_filler_words        bool    default false     -- OFF by default, per spec
detect_retakes             bool    default true
min_segment_seconds        double  default 0.35
default_export_preset      export_preset default 'ORIGINAL_QUALITY'
source_retention           retention_policy default 'NEVER'
```

### `video`
The master record. **`storage_key` points at the untouched original and is never
rewritten.**

```
id PK, user_id FK, title, original_filename, storage_key, storage_bucket,
mime_type, file_size bigint, checksum_sha256, checksum_verified_at,
status video_status, status_detail text, error_message text, progress int (0-100),
duration double, width int, height int, rotation int, display_aspect_ratio text,
frame_rate double, avg_frame_rate double, is_variable_frame_rate bool,
video_codec, video_profile, pixel_format, bit_depth int,
audio_codec, audio_channels int, audio_sample_rate int,
bitrate bigint, color_primaries, color_transfer, color_space, color_range,
is_hdr bool, hdr_format text,           -- 'HDR10' | 'HLG' | 'DOLBY_VISION' | null
master_display text, max_cll text,
probe_json jsonb,                        -- full ffprobe output, kept for support
thumbnail_key, proxy_key, waveform_key,
source_deleted_at, delete_source_after,  -- retention
created_at, updated_at
```

### `video_source`
Provenance of the bytes. One row per acquisition attempt; lets us re-import.

```
id PK, video_id FK, kind source_kind, external_id, external_url,
declared_size bigint, bytes_fetched bigint, import_error text,
metadata jsonb, created_at, completed_at
```

### `upload_session`
Server-side record of an R2 multipart upload — the thing that makes resume possible.

```
id PK, video_id FK, user_id FK, storage_key, r2_upload_id,
part_size int, total_parts int, file_size bigint, file_fingerprint text,
client_sha256 text, status upload_status,
parts jsonb,          -- [{ partNumber, etag, size, uploadedAt }]
bytes_uploaded bigint, last_activity_at, expires_at, created_at
```

`file_fingerprint = sha256(filename + ':' + size + ':' + lastModified)` — used to
match a re-selected file after a Safari refresh to an existing session.

### `processing_job`
Durable mirror of the BullMQ job so state survives Redis loss.

```
id PK, video_id FK, user_id FK, type job_type, status job_status,
queue_job_id, attempt int, max_attempts int,
progress int, progress_stage text, payload jsonb, result jsonb,
error_message text, error_stack text,
idempotency_key text UNIQUE,   -- (video_id, type, input-hash)
locked_by text, locked_at, heartbeat_at,
queued_at, started_at, finished_at, dead_lettered_at
```

### `transcript` / `transcript_segment` / `transcript_word`
```
transcript:  id, video_id, provider, model, language, duration, word_count,
             confidence, raw_json (jsonb), created_at
segment:     id, transcript_id, video_id, index, start_time, end_time, text,
             normalized_text, confidence, is_complete_sentence bool,
             filler_count int, internal_pause_count int, take_group_id
word:        id, transcript_id, segment_id, index, start_time, end_time,
             text, confidence, is_filler bool
```

### `detected_take`
A cluster of segments that are attempts at the same sentence.

```
id PK, video_id FK, group_index int, canonical_text text,
member_count int, chosen_segment_id text,
similarity double, confidence double, reason text, created_at
```
`detected_take_member`: `(take_id, segment_id, index, is_chosen, score, score_breakdown jsonb)`

### `edit_decision` — the EDL
```
id PK, video_id FK, index int,
start_time double, end_time double,
action decision_action, kind decision_kind,
reason text, confidence double,
source text,                 -- 'auto' | 'user'
take_id text NULL, segment_id text NULL,
superseded_by text NULL,     -- user override history, nothing is destroyed
active bool default true,
created_at
```
The active EDL is `WHERE video_id = ? AND active = true ORDER BY start_time`.
User edits insert new rows and flip `active`; the automatic proposal is always
recoverable ("Reset automatic edits").

### `edit_settings`
Snapshot of the settings that produced the current EDL (so re-running is reproducible):
same shape as `user_settings` plus `video_id`, `edl_version int`.

### `export`
```
id PK, video_id FK, user_id FK, preset export_preset, strategy export_strategy,
status export_status, progress int,
storage_key, file_size bigint, duration double,
width int, height int, frame_rate double, video_codec, audio_codec,
container text, estimated_size bigint,
edl_version int, ffmpeg_command text, render_log text,
warnings jsonb,       -- e.g. 'Dolby Vision RPU not preserved'
started_at, finished_at, error_message
```

### `share_link`
```
id PK, slug UNIQUE, video_id FK, export_id FK, user_id FK,
allow_download bool, expires_at NULL, view_count int, last_viewed_at,
revoked_at, created_at
```

### `subscription` / `usage_record`
```
subscription: id, user_id, tier plan_tier, status, current_period_start/end,
              provider, provider_customer_id, provider_subscription_id, cancel_at
usage_record: id, user_id, video_id NULL, kind usage_kind, quantity numeric,
              unit text, occurred_at, period_key text ('2026-09')
```
`usage_record` is append-only; quota checks aggregate over `period_key`.

## Entity relationships

```
user 1─* video 1─1 video_source
              1─* upload_session
              1─* processing_job
              1─1 transcript 1─* transcript_segment 1─* transcript_word
              1─* detected_take 1─* detected_take_member
              1─* edit_decision
              1─1 edit_settings
              1─* export 1─* share_link
user 1─1 subscription
user 1─* usage_record
```
