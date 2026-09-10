# Raw Edit

Mobile-first SaaS for turning an untouched iPhone recording into a clean raw edit.

The original file is stored once in a private R2 bucket and is never transcoded in place. Analysis, review, and a single high-quality FFmpeg encode all read that master.

## Architecture

```
iPhone / Safari
  → Better Auth
  → Next.js on Vercel (control plane)
  → multipart upload directly to Cloudflare R2
  → Neon PostgreSQL
  → BullMQ on Upstash Redis
  → Railway FFmpeg worker
  → private export + signed share/download
```

Monorepo:

- `apps/web` — Next.js App Router
- `apps/worker` — Railway media worker
- `packages/core` — ports, retake/silence/EDL/render engine, streaming SHA-256 (zero I/O)
- `packages/db` — Drizzle schema (single source of truth)
- `packages/storage` — R2 / S3 provider
- `packages/queue` — BullMQ provider + progress fan-out
- `packages/transcription` — SpeechToTextProvider
- `packages/media` — ffmpeg / ffprobe VideoProcessor
- `packages/imports` — URL importer with SSRF checks
- `packages/ai` — TakeJudge + payment interface
- `packages/config` — shared env

## Local development

Install FFmpeg and ffprobe on the host.

```bash
corepack enable
pnpm install
cp .env.example .env.local
docker compose up -d
pnpm db:migrate
pnpm --filter @raw-edit/web dev
pnpm --filter @raw-edit/worker start
```

Local object storage is MinIO using the same S3 multipart APIs as Cloudflare R2. Point production at R2 by setting `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET=rawedit-prod`.

Without a transcription API key the worker still completes analysis, writes a full-timeline KEEP EDL, and allows manual review + render. That is the Phase 1 vertical slice.

## Production

| Piece | Host |
| --- | --- |
| Web | Vercel (`apps/web`) |
| Postgres | Neon pooled `DATABASE_URL` |
| Redis | Upstash TLS (`UPSTASH_REDIS_*`) |
| Objects | Cloudflare R2 private buckets `rawedit-dev` / `rawedit-prod` |
| Worker | Railway `media-worker`, `RENDER_CONCURRENCY=1` |

Do not upload multi-GB files through Vercel. Do not run FFmpeg in Next.js routes. Do not render from the 720p proxy.

## Tests

```bash
pnpm --filter @raw-edit/core test
```
