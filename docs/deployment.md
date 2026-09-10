# Deployment

```
Vercel ──────► Next.js app          (signing, review UI, share pages)
Neon ────────► Postgres             (the source of truth for all state)
Cloudflare R2 ► private bucket      (originals, exports, preview derivatives)
Railway ─────► Redis + media worker (BullMQ, ffmpeg, transcription)
```

Nothing large ever passes through Vercel: uploads go browser → R2 directly, and
renders happen on Railway. The functions only sign, validate and record.

## 1. Cloudflare R2

Create a bucket (`rawedit-prod`) and an API token with **Object Read & Write** scoped
to it.

**Leave the bucket private.** Do not connect a public domain. Everything the browser
touches is a short-lived signed URL minted after an ownership check.

CORS is required, because the browser PUTs parts straight to R2:

```json
[
  {
    "AllowedOrigins": ["https://your-app.vercel.app", "https://rawedit.app"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length", "authorization", "x-amz-*"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

`ExposeHeaders: ["etag"]` is not optional — the client reads each part's ETag to
complete the upload, and without it the browser hides the header and every upload
fails at the last step.

A lifecycle rule to abort incomplete multipart uploads after 7 days is worth adding as
a backstop; the `CLEANUP_SOURCE` job already aborts them after 24 hours, but R2 bills
for orphaned parts and belt-and-braces is cheap.

## 2. Neon

Create a project and take **both** connection strings:

- the **pooled** one (host contains `-pooler`) for Vercel, and
- the **direct** one for the worker and for migrations.

A pooler in transaction mode cannot run prepared statements or migrations, which is
why `packages/db/src/client.ts` defaults `prepare` to `false` and the worker overrides
it to `true`.

```bash
DATABASE_URL="<direct connection string>" npm run db:migrate
```

## 3. Railway — Redis

Add a Redis service. Copy its URL; a managed instance gives you `rediss://`, and TLS
is enabled automatically from the scheme.

## 4. Railway — the media worker

New service from this repository:

| Setting | Value |
|---|---|
| Builder | Dockerfile |
| Dockerfile path | `apps/worker/Dockerfile` |
| Build context | repository root |
| Build arg | `INSTALL_FASTER_WHISPER=1` (only for self-hosted transcription) |

Variables:

```
DATABASE_URL=<neon DIRECT connection string>
REDIS_URL=<railway redis url>
R2_BUCKET=rawedit-prod
R2_ACCOUNT_ID=<cloudflare account id>
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
TRANSCRIPTION_PROVIDER=deepgram
DEEPGRAM_API_KEY=...
WORKER_CONCURRENCY=2
MAX_CONCURRENT_JOBS_PER_USER=1
SOURCE_URL_TTL_SECONDS=21600
LOG_LEVEL=info
```

**Sizing.** An ffmpeg render is CPU-bound and largely single-job-parallel, so
`WORKER_CONCURRENCY` should be roughly `vCPUs / 2`. Disk needs room for the largest
file you accept plus its render — a 4 GB source with a 3 GB export wants 8 GB of
scratch, and `WORKER_TMP_DIR` should point at a volume rather than the container
layer.

**Scaling.** Replicas can be increased freely. Every job is claimed with a worker lock
and a 10-second heartbeat, so two replicas cannot run the same job, and a replica that
dies has its jobs reclaimed by the sweeper after 90 seconds.
`MAX_CONCURRENT_JOBS_PER_USER` is a fleet-wide ceiling per account: a creator queuing
ten 4K renders gets one at a time while everyone else keeps moving. Raise it once you
have enough replicas that fairness stops being the binding constraint.

Railway sends `SIGTERM` on redeploy. The worker stops accepting new jobs and lets
in-flight ones finish, and `tini` reaps ffmpeg so a cancelled render cannot leave a
zombie behind.

## 5. Vercel

Import the repository. Vercel detects the monorepo; set the root directory to
`apps/web`.

```
DATABASE_URL=<neon POOLED connection string>
REDIS_URL=<railway redis url>
R2_BUCKET=rawedit-prod
R2_ACCOUNT_ID=<cloudflare account id>
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
BETTER_AUTH_SECRET=<openssl rand -base64 32>
NEXT_PUBLIC_APP_URL=https://your-domain
```

The app does **not** need a transcription key: only the worker transcribes.

**Function duration.** `/api/videos/[id]/events` is an SSE stream capped at 300
seconds. On Hobby the platform limit is shorter; `EventSource` reconnects on its own
and the client falls back to polling, so progress stays correct either way — the
database is the source of truth, not the stream.

## 6. First run

1. Sign up.
2. Upload a real recording from an iPhone.
3. Watch the worker log: probe → audio → silence → transcript → takes → EDL.
4. Review the proposed cuts, adjust, approve.
5. Download and share.

If nothing happens after the upload completes, check in this order: the worker's
`REDIS_URL` matches the app's; the worker can reach Neon on the *direct* string;
`processing_job` has a `QUEUED` row for the video.

## Operating notes

**A failed video is never lost.** Retries use `10s → 60s → 300s` backoff. Permanent
failures — no audio stream, a corrupt file, a checksum mismatch — dead-letter
immediately rather than burning three attempts. A `DEAD` job keeps its full error and
stack in `processing_job`, and `/api/videos/:id/retry` re-queues it with the video
record, its storage key and any previous analysis intact.

**Costs follow storage, not compute.** Originals dominate the bill. The default
retention is "keep forever", which is the safe default but the expensive one; offering
creators a 30-day rule on originals cuts storage sharply while leaving every rendered
export in place.

**Watch the queue depth, not the CPU.** A worker at 100% CPU is working correctly. A
growing `QUEUED` count in `processing_job` is the signal to add replicas.

## Self-hosting without Vercel or Railway

Nothing here is platform-specific. The app is a standard Next.js server
(`npm run build && npm start`), the worker is a plain Docker image, and both need only
Postgres, Redis and an S3-compatible endpoint — the same trio `docker-compose.yml`
starts locally with MinIO.
