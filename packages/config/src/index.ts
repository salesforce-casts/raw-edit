import {
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_MAX_VIDEO_DURATION_SECONDS,
  MAX_CONCURRENT_JOBS_PER_USER,
  MULTIPART_PART_SIZE_BYTES,
} from "@raw-edit/core";

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  return {
    nodeEnv: optional("NODE_ENV", "development"),
    serviceName: optional("SERVICE_NAME", "web"),
    appUrl: optional("NEXT_PUBLIC_APP_URL", optional("BETTER_AUTH_URL", "http://localhost:3000")),
    databaseUrl: optional("DATABASE_URL"),
    databaseMigrateUrl: optional("DATABASE_MIGRATE_URL"),
    betterAuthSecret: optional("BETTER_AUTH_SECRET"),
    betterAuthUrl: optional("BETTER_AUTH_URL", optional("NEXT_PUBLIC_APP_URL", "http://localhost:3000")),
    googleClientId: optional("GOOGLE_CLIENT_ID"),
    googleClientSecret: optional("GOOGLE_CLIENT_SECRET"),
    r2: {
      accountId: optional("R2_ACCOUNT_ID"),
      accessKeyId: optional("R2_ACCESS_KEY_ID"),
      secretAccessKey: optional("R2_SECRET_ACCESS_KEY"),
      bucket: optional("R2_BUCKET", "rawedit-dev"),
      endpoint: optional("R2_ENDPOINT"),
      region: optional("R2_REGION", "auto"),
      forcePathStyle: optional("R2_FORCE_PATH_STYLE", "false") === "true",
    },
    redis: {
      url: optional("REDIS_URL"),
      host: optional("UPSTASH_REDIS_HOST", "127.0.0.1"),
      port: integer("UPSTASH_REDIS_PORT", 6379),
      password: optional("UPSTASH_REDIS_PASSWORD"),
      tls: optional("UPSTASH_REDIS_TLS", optional("REDIS_TLS", "false")) === "true",
    },
    transcriptionProvider: optional("TRANSCRIPTION_PROVIDER", "openai"),
    transcriptionApiKey: optional("TRANSCRIPTION_API_KEY", optional("OPENAI_API_KEY")),
    fasterWhisperUrl: optional("FASTER_WHISPER_URL"),
    aiProvider: optional("AI_PROVIDER", "heuristic"),
    aiApiKey: optional("AI_API_KEY", optional("OPENAI_API_KEY")),
    ffmpegPath: optional("FFMPEG_PATH", "ffmpeg"),
    ffprobePath: optional("FFPROBE_PATH", "ffprobe"),
    workerConcurrency: integer("WORKER_CONCURRENCY", 1),
    renderConcurrency: integer("RENDER_CONCURRENCY", 1),
    maxVideoBytes: integer("MAX_VIDEO_BYTES", DEFAULT_MAX_VIDEO_BYTES),
    maxVideoDurationSeconds: integer("MAX_VIDEO_DURATION_SECONDS", DEFAULT_MAX_VIDEO_DURATION_SECONDS),
    multipartPartSizeBytes: integer("MULTIPART_PART_SIZE_BYTES", MULTIPART_PART_SIZE_BYTES),
    maxConcurrentJobsPerUser: integer("MAX_CONCURRENT_JOBS_PER_USER", MAX_CONCURRENT_JOBS_PER_USER),
    sourceUrlTtlSeconds: integer("SOURCE_URL_TTL_SECONDS", 60 * 60),
    scratchDir: optional("WORKER_SCRATCH_DIR", optional("WORKER_TMP_DIR", "/tmp/rawedit")),
    scratchSafetyBytes: integer("WORKER_SCRATCH_SAFETY_BYTES", 8 * 1024 * 1024 * 1024),
    sentryDsn: optional("SENTRY_DSN"),
    posthogKey: optional("POSTHOG_KEY"),
    posthogHost: optional("POSTHOG_HOST", "https://us.i.posthog.com"),
    resendApiKey: optional("RESEND_API_KEY"),
    logLevel: optional("LOG_LEVEL", "info"),
  };
}

export function requireValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
