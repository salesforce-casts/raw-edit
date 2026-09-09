CREATE TYPE "public"."decision_action" AS ENUM('keep', 'remove');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('silence', 'retake', 'filler', 'manual');--> statement-breakpoint
CREATE TYPE "public"."decision_source" AS ENUM('auto', 'user');--> statement-breakpoint
CREATE TYPE "public"."export_preset" AS ENUM('ORIGINAL_QUALITY', 'SOCIAL_MEDIA', 'SMALLER_FILE');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('QUEUED', 'RENDERING', 'COMPLETE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."export_strategy" AS ENUM('PRESERVE_SOURCE', 'COMPATIBLE_MP4');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('ANALYZE_VIDEO', 'TRANSCRIBE_AUDIO', 'DETECT_TAKES', 'RENDER_VIDEO', 'IMPORT_SOURCE', 'GENERATE_PROXY', 'CLEANUP_SOURCE');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('FREE', 'CREATOR', 'PRO');--> statement-breakpoint
CREATE TYPE "public"."retention_policy" AS ENUM('DAYS_7', 'DAYS_30', 'DAYS_90', 'NEVER');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('DIRECT_UPLOAD', 'GOOGLE_DRIVE', 'DROPBOX', 'ONEDRIVE', 'ICLOUD', 'URL');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'ABORTED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('UPLOADED_MINUTES', 'TRANSCRIBED_MINUTES', 'RENDERED_MINUTES', 'STORAGE_BYTES');--> statement-breakpoint
CREATE TYPE "public"."video_status" AS ENUM('UPLOADING', 'UPLOADED', 'ANALYZING', 'TRANSCRIBING', 'DETECTING_TAKES', 'READY_FOR_REVIEW', 'RENDERING', 'COMPLETE', 'FAILED');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_tier" "plan_tier" DEFAULT 'FREE' NOT NULL,
	"default_retention" "retention_policy" DEFAULT 'NEVER' NOT NULL,
	"payment_customer_id" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tier" "plan_tier" DEFAULT 'FREE' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"provider" text,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_record" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"video_id" text,
	"kind" "usage_kind" NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit" text NOT NULL,
	"period_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"silence_threshold_seconds" double precision DEFAULT 1 NOT NULL,
	"pad_pre_ms" integer DEFAULT 160 NOT NULL,
	"pad_post_ms" integer DEFAULT 200 NOT NULL,
	"remove_filler_words" boolean DEFAULT false NOT NULL,
	"detect_retakes" boolean DEFAULT true NOT NULL,
	"remove_silence" boolean DEFAULT true NOT NULL,
	"min_segment_seconds" double precision DEFAULT 0.35 NOT NULL,
	"default_export_preset" "export_preset" DEFAULT 'ORIGINAL_QUALITY' NOT NULL,
	"source_retention" "retention_policy" DEFAULT 'NEVER' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_decision" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"index" integer DEFAULT 0 NOT NULL,
	"start_time" double precision NOT NULL,
	"end_time" double precision NOT NULL,
	"action" "decision_action" NOT NULL,
	"kind" "decision_kind" NOT NULL,
	"reason" text NOT NULL,
	"confidence" double precision NOT NULL,
	"source" "decision_source" DEFAULT 'auto' NOT NULL,
	"take_id" text,
	"segment_index" integer,
	"superseded_by" text,
	"active" boolean DEFAULT true NOT NULL,
	"edl_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_settings" (
	"video_id" text PRIMARY KEY NOT NULL,
	"edl_version" integer DEFAULT 1 NOT NULL,
	"silence_threshold_seconds" double precision DEFAULT 1 NOT NULL,
	"pad_pre_ms" integer DEFAULT 160 NOT NULL,
	"pad_post_ms" integer DEFAULT 200 NOT NULL,
	"remove_filler_words" boolean DEFAULT false NOT NULL,
	"detect_retakes" boolean DEFAULT true NOT NULL,
	"remove_silence" boolean DEFAULT true NOT NULL,
	"min_segment_seconds" double precision DEFAULT 0.35 NOT NULL,
	"merge_gap_ms" integer DEFAULT 120 NOT NULL,
	"retake_similarity_threshold" double precision DEFAULT 0.72 NOT NULL,
	"retake_min_opening_tokens" integer DEFAULT 3 NOT NULL,
	"retake_lookahead_segments" integer DEFAULT 6 NOT NULL,
	"retake_lookahead_seconds" double precision DEFAULT 60 NOT NULL,
	"overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_link" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"video_id" text NOT NULL,
	"export_id" text NOT NULL,
	"user_id" text NOT NULL,
	"allow_download" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"user_id" text NOT NULL,
	"preset" "export_preset" DEFAULT 'ORIGINAL_QUALITY' NOT NULL,
	"strategy" "export_strategy" DEFAULT 'PRESERVE_SOURCE' NOT NULL,
	"status" "export_status" DEFAULT 'QUEUED' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"storage_key" text,
	"file_size" bigint,
	"duration" double precision,
	"width" integer,
	"height" integer,
	"frame_rate" double precision,
	"video_codec" text,
	"audio_codec" text,
	"container" text DEFAULT 'mp4' NOT NULL,
	"estimated_size" bigint,
	"edl_version" integer DEFAULT 1 NOT NULL,
	"ffmpeg_command" text,
	"render_log" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_session" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"user_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"r2_upload_id" text NOT NULL,
	"part_size" integer NOT NULL,
	"total_parts" integer NOT NULL,
	"file_size" bigint NOT NULL,
	"file_fingerprint" text NOT NULL,
	"client_sha256" text,
	"status" "upload_status" DEFAULT 'PENDING' NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bytes_uploaded" bigint DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"original_filename" text NOT NULL,
	"storage_key" text NOT NULL,
	"storage_bucket" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" bigint NOT NULL,
	"checksum_sha256" text,
	"checksum_verified_at" timestamp with time zone,
	"status" "video_status" DEFAULT 'UPLOADING' NOT NULL,
	"status_detail" text,
	"error_message" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"duration" double precision,
	"width" integer,
	"height" integer,
	"rotation" integer DEFAULT 0 NOT NULL,
	"display_aspect_ratio" text,
	"frame_rate" double precision,
	"avg_frame_rate" double precision,
	"is_variable_frame_rate" boolean DEFAULT false NOT NULL,
	"video_codec" text,
	"video_profile" text,
	"pixel_format" text,
	"bit_depth" integer,
	"audio_codec" text,
	"audio_channels" integer,
	"audio_sample_rate" integer,
	"bitrate" bigint,
	"color_primaries" text,
	"color_transfer" text,
	"color_space" text,
	"color_range" text,
	"is_hdr" boolean DEFAULT false NOT NULL,
	"hdr_format" text,
	"master_display" text,
	"max_cll" text,
	"probe_json" jsonb,
	"thumbnail_key" text,
	"proxy_key" text,
	"waveform_key" text,
	"source_retention" "retention_policy" DEFAULT 'NEVER' NOT NULL,
	"delete_source_after" timestamp with time zone,
	"source_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_source" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"external_id" text,
	"external_url" text,
	"declared_size" bigint,
	"bytes_fetched" bigint DEFAULT 0 NOT NULL,
	"import_error" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "detected_take" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"group_index" integer NOT NULL,
	"canonical_text" text NOT NULL,
	"member_count" integer NOT NULL,
	"chosen_segment_id" text,
	"chosen_segment_index" integer NOT NULL,
	"similarity" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detected_take_member" (
	"id" text PRIMARY KEY NOT NULL,
	"take_id" text NOT NULL,
	"video_id" text NOT NULL,
	"segment_index" integer NOT NULL,
	"index" integer NOT NULL,
	"start_time" double precision NOT NULL,
	"end_time" double precision NOT NULL,
	"text" text NOT NULL,
	"is_chosen" boolean DEFAULT false NOT NULL,
	"score" double precision NOT NULL,
	"score_breakdown" jsonb
);
--> statement-breakpoint
CREATE TABLE "processing_job" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"queue_job_id" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"progress_stage" text,
	"payload" jsonb,
	"result" jsonb,
	"error_message" text,
	"error_stack" text,
	"idempotency_key" text NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transcript" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"language" text,
	"duration" double precision,
	"word_count" integer DEFAULT 0 NOT NULL,
	"confidence" double precision,
	"raw_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segment" (
	"id" text PRIMARY KEY NOT NULL,
	"transcript_id" text NOT NULL,
	"video_id" text NOT NULL,
	"index" integer NOT NULL,
	"start_time" double precision NOT NULL,
	"end_time" double precision NOT NULL,
	"text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"confidence" double precision,
	"is_complete_sentence" boolean DEFAULT false NOT NULL,
	"filler_count" integer DEFAULT 0 NOT NULL,
	"internal_pause_count" integer DEFAULT 0 NOT NULL,
	"take_group_id" text
);
--> statement-breakpoint
CREATE TABLE "transcript_word" (
	"id" text PRIMARY KEY NOT NULL,
	"transcript_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"index" integer NOT NULL,
	"start_time" double precision NOT NULL,
	"end_time" double precision NOT NULL,
	"text" text NOT NULL,
	"confidence" double precision,
	"is_filler" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_decision" ADD CONSTRAINT "edit_decision_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_settings" ADD CONSTRAINT "edit_settings_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_export_id_export_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."export"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_session" ADD CONSTRAINT "upload_session_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_session" ADD CONSTRAINT "upload_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video" ADD CONSTRAINT "video_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_source" ADD CONSTRAINT "video_source_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_take" ADD CONSTRAINT "detected_take_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_take_member" ADD CONSTRAINT "detected_take_member_take_id_detected_take_id_fk" FOREIGN KEY ("take_id") REFERENCES "public"."detected_take"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_take_member" ADD CONSTRAINT "detected_take_member_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript" ADD CONSTRAINT "transcript_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segment" ADD CONSTRAINT "transcript_segment_transcript_id_transcript_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcript"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segment" ADD CONSTRAINT "transcript_segment_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_word" ADD CONSTRAINT "transcript_word_transcript_id_transcript_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcript"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_word" ADD CONSTRAINT "transcript_word_segment_id_transcript_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."transcript_segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "subscription_user_idx" ON "subscription" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_record_user_period_idx" ON "usage_record" USING btree ("user_id","period_key","kind");--> statement-breakpoint
CREATE INDEX "usage_record_video_idx" ON "usage_record" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "edit_decision_video_active_idx" ON "edit_decision" USING btree ("video_id","active","start_time");--> statement-breakpoint
CREATE INDEX "edit_decision_take_idx" ON "edit_decision" USING btree ("take_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_slug_idx" ON "share_link" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "share_link_video_idx" ON "share_link" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "export_video_idx" ON "export" USING btree ("video_id","created_at");--> statement-breakpoint
CREATE INDEX "export_user_idx" ON "export" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "upload_session_user_idx" ON "upload_session" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "upload_session_expiry_idx" ON "upload_session" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_session_video_idx" ON "upload_session" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "upload_session_fingerprint_idx" ON "upload_session" USING btree ("user_id","file_fingerprint");--> statement-breakpoint
CREATE INDEX "video_user_created_idx" ON "video" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "video_status_idx" ON "video" USING btree ("status");--> statement-breakpoint
CREATE INDEX "video_retention_idx" ON "video" USING btree ("delete_source_after");--> statement-breakpoint
CREATE INDEX "video_source_video_idx" ON "video_source" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "detected_take_video_idx" ON "detected_take" USING btree ("video_id","group_index");--> statement-breakpoint
CREATE INDEX "detected_take_member_take_idx" ON "detected_take_member" USING btree ("take_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_job_idempotency_idx" ON "processing_job" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "processing_job_video_idx" ON "processing_job" USING btree ("video_id","type");--> statement-breakpoint
CREATE INDEX "processing_job_status_idx" ON "processing_job" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "processing_job_user_active_idx" ON "processing_job" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_video_idx" ON "transcript" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "transcript_segment_video_idx" ON "transcript_segment" USING btree ("video_id","index");--> statement-breakpoint
CREATE INDEX "transcript_segment_time_idx" ON "transcript_segment" USING btree ("video_id","start_time");--> statement-breakpoint
CREATE INDEX "transcript_word_segment_idx" ON "transcript_word" USING btree ("segment_id","index");