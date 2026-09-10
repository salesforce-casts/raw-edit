# RawEdit

Turn a messy phone recording into a clean edit.

A creator records a Reel, fluffs the opening line three times, and uploads the raw
file straight from Safari. RawEdit finds the takes they abandoned and the dead air
between them, shows exactly what it plans to cut and why, and renders the result from
the original file at the quality it was shot.

```
iPhone / Browser
      │  resumable multipart upload, direct to R2
      ▼
Cloudflare R2   originals/…                     ← never transcoded, never rewritten
      │
      ▼
Railway worker  ffprobe → audio → silence → transcript → retakes → EDL
      │
      ▼
Review screen   transcript, timeline, preview, adjust
      │
      ▼
Single ffmpeg pass from the ORIGINAL → finished MP4 → share link
```

## What makes it work

**Retake detection is deterministic.** Two utterances are compared on their shared
opening (a creator who fluffs a line restarts it from the top), on token-bigram
similarity and on containment, with fuzzy matching that tolerates ASR noise. Matching
pairs are unioned into groups, and the keeper is chosen by a weighted score:
completeness, content, filler count, stumbles, and — all else equal — the later take.
Every removal carries a `startTime`, `endTime`, `reason` and `confidence`.

**The AI never touches the timeline.** An optional `EditAdvisor` arbitrates groups
where the top two candidates score within 0.6 of each other. It is shown candidate
*text* and returns a candidate *index*, validated against the list. A malformed or
out-of-range answer is discarded and the deterministic pick stands. It cannot create,
move or delete a cut. Off by default.

**The original is immutable.** `video.storageKey` points at the uploaded bytes and
nothing ever writes to that object. Proxies exist only so the review player is
scrubbable on cellular; the render always reads the master. A source is deleted only
when the creator's own retention rule set a deadline that has passed.

**Quality is preserved by default.** 4K stays 4K, HDR stays HDR, rotation metadata is
carried rather than baked in, and colour tags are written explicitly on every path —
dropping them is what produces washed-out exports. There is exactly one encode
between the uploaded file and the delivered one.

## Getting started

Requires Node 20.11+, and ffmpeg for the worker.

```bash
git clone <this repo> && cd raw-edit
npm install
cp .env.example .env

./scripts/dev-services.sh start     # Postgres, Redis, MinIO + migrations
npm run db:seed                     # optional demo video

npm run dev                         # web app on http://localhost:3000
npm run dev:worker                  # media worker, separate terminal
```

`dev-services.sh` uses `docker compose` when a Docker daemon is available and falls
back to native binaries when it is not. To run the services yourself:

```bash
docker compose up -d
npm run db:migrate
```

The seed creates `demo@rawedit.local` / `rawedit-demo-1234` with a video already at
`READY_FOR_REVIEW`, so the review screen can be worked on without uploading anything.

### Installing ffmpeg

The worker shells out to `ffmpeg` and `ffprobe`; both must be on `PATH`, or set
`FFMPEG_PATH` and `FFPROBE_PATH`.

| Platform | Command |
|---|---|
| macOS | `brew install ffmpeg` |
| Debian / Ubuntu | `sudo apt-get install -y ffmpeg` |
| Fedora | `sudo dnf install -y ffmpeg-free` |
| Windows | `winget install Gyan.FFmpeg` |
| Docker | already in `apps/worker/Dockerfile` |

A build with `libx264` and `libx265` is needed for the export presets. `ffmpeg
-encoders | grep -E 'libx26[45]'` should list both.

### Choosing a transcription provider

Word-level timings are mandatory — without them there is nowhere to place a cut — so
a provider that cannot supply them is rejected at construction time.

| `TRANSCRIPTION_PROVIDER` | Needs | Good for |
|---|---|---|
| `deepgram` | `DEEPGRAM_API_KEY` | Fastest to set up, handles long recordings |
| `openai-whisper` | `OPENAI_API_KEY` | Already have a key; 25MB (~13 min) cap |
| `faster-whisper` | Python in the worker image | No per-minute cost, audio never leaves your infra |

Local development defaults to `faster-whisper`. Build the worker image with
`--build-arg INSTALL_FASTER_WHISPER=1` to include it.

## Tests

```bash
npm test                                    # everything
source .env.test && npm test                # includes the tests that need services
npm test -w @rawedit/core                   # the analysis engine, no services needed
```

| Suite | What it covers |
|---|---|
| `packages/core` | Retake detection, silence, EDL, render planning, ffmpeg arguments, presets, HDR, streaming SHA-256, state machines. 126 tests, no I/O. |
| `packages/imports` | Link parsing for each provider, and the SSRF guard on direct URLs. |
| `packages/media` | Real ffmpeg: probe, extract, silence-detect, and actual renders whose output is probed back. |
| `apps/worker` | Job claiming, locking, retries, dead-lettering, and the full pipeline against real Postgres, Redis and S3. |

The end-to-end test uses no mocks. It synthesises the brief's own retake example with
espeak-ng, transcribes it with faster-whisper, and asserts that the two aborted takes
are removed, the complete one is kept, the render is exactly 8 seconds shorter, and
the original is still byte-for-byte identical afterwards. It is skipped with a clear
message when the services are not configured.

## Layout

```
packages/core            Pure domain logic, zero I/O. Every provider interface lives here.
packages/db              Drizzle schema, migrations, user-scoped queries, seed.
packages/storage         StorageProvider   → R2 / S3 / MinIO
packages/queue           QueueProvider     → BullMQ + Redis
packages/transcription   TranscriptionProvider → Deepgram / Whisper / faster-whisper
packages/media           VideoProcessor    → the only code that runs ffmpeg
packages/imports         CloudImportProvider → Drive / Dropbox / OneDrive / iCloud / URL
apps/web                 Next.js on Vercel
apps/worker              Dockerised worker on Railway
```

Every external dependency sits behind an interface defined in `@rawedit/core`.
`apps/web/src/lib/container.ts` and `apps/worker/src/lib/context.ts` are the only
places a concrete provider is constructed, so swapping Deepgram for a self-hosted
faster-whisper, or R2 for S3, is a one-line change plus environment variables. No
component imports a provider SDK.

## Documentation

The design was written before the implementation and is kept current:

- [Folder structure](docs/01-folder-structure.md)
- [Database schema](docs/02-database-schema.md)
- [Processing pipeline](docs/03-processing-pipeline.md)
- [Job & video state machine](docs/04-job-state-machine.md)
- [R2 multipart upload design](docs/05-r2-multipart-upload.md)
- [FFmpeg render strategy](docs/06-ffmpeg-render-strategy.md) — including the
  measurements behind choosing `atrim`/`concat` over `aselect`
- [Retake detection](docs/07-retake-detection.md)
- [Deployment](docs/deployment.md)

## Deployment

Web app on Vercel, Postgres on Neon, storage on Cloudflare R2, Redis and the worker on
Railway. The worker scales horizontally: job locking and the per-user concurrency cap
mean extra replicas render more videos at once without two of them fighting over the
same job. See [docs/deployment.md](docs/deployment.md).

## Not in this version

Captions, B-roll, music, transitions, AI avatars, image generation, social scheduling,
team collaboration, and a full Premiere-style timeline. The timeline here is
deliberately small: one video track, a waveform, the proposed cuts, a playhead and
draggable handles.
