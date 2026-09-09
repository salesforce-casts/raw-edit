# 1. Folder Structure

RawEdit is an npm-workspaces monorepo. The guiding rule is that **every external
dependency sits behind an interface defined in `@rawedit/core`**, and no UI code
ever imports a provider SDK.

```
raw-edit/
├── package.json                     # npm workspaces root + task scripts
├── tsconfig.base.json               # strict TypeScript settings shared by all packages
├── docker-compose.yml               # Postgres + Redis + MinIO (local R2 stand-in) + worker
├── .env.example                     # every variable the system reads, documented
├── README.md
├── docs/                            # the design documents in this folder
│
├── packages/
│   ├── core/                        # @rawedit/core   — pure domain logic, ZERO I/O
│   │   ├── src/
│   │   │   ├── types/               # Video state, transcript, EDL, media metadata
│   │   │   ├── state/               # video + job state machines
│   │   │   ├── text/                # normalisation, tokenisation, similarity
│   │   │   ├── analysis/            # segmentation, silence, retakes, fillers, EDL
│   │   │   ├── render/              # EDL -> render plan -> ffmpeg arguments
│   │   │   ├── hash/                # streaming SHA-256 (browser + node)
│   │   │   ├── ports/               # StorageProvider, TranscriptionProvider, ...
│   │   │   └── index.ts
│   │   └── test/                    # vitest suites for all of the above
│   │
│   ├── db/                          # @rawedit/db     — Drizzle schema + migrations
│   │   ├── src/schema/*.ts
│   │   ├── drizzle/                 # generated SQL migrations
│   │   └── src/seed.ts
│   │
│   ├── storage/                     # @rawedit/storage — StorageProvider implementations
│   │   └── src/{s3-storage.ts,index.ts}          # R2 / any S3-compatible endpoint
│   │
│   ├── queue/                       # @rawedit/queue   — QueueProvider implementations
│   │   └── src/{bullmq-queue.ts,progress-bus.ts}
│   │
│   ├── transcription/               # @rawedit/transcription — TranscriptionProvider impls
│   │   └── src/{deepgram.ts,openai-whisper.ts,faster-whisper.ts,factory.ts}
│   │
│   ├── media/                       # @rawedit/media   — VideoProcessor implementation
│   │   └── src/{ffprobe.ts,ffmpeg.ts,silence.ts,waveform.ts,thumbnail.ts}
│   │
│   └── imports/                     # @rawedit/imports — cloud import adapters
│       └── src/{google-drive.ts,dropbox.ts,onedrive.ts,icloud.ts,direct-url.ts}
│
└── apps/
    ├── web/                         # Next.js 16 App Router on Vercel
    │   ├── src/app/
    │   │   ├── (marketing)/         # landing
    │   │   ├── (app)/dashboard/     # library
    │   │   ├── (app)/videos/[id]/   # review screen
    │   │   ├── v/[slug]/            # public share page
    │   │   └── api/                 # uploads, videos, edl, exports, events, imports
    │   ├── src/components/          # ui/ (shadcn), upload/, review/, timeline/
    │   ├── src/lib/                 # auth, db client, container (provider wiring)
    │   └── src/hooks/
    │
    └── worker/                      # Dockerised BullMQ worker on Railway
        ├── src/{index.ts,handlers/analyze.ts,handlers/render.ts}
        └── Dockerfile               # node + ffmpeg + (optional) faster-whisper
```

## Boundary rules

| Layer | May import | Must never import |
|---|---|---|
| `core` | nothing but TypeScript stdlib | any SDK, `node:fs`, React |
| `db` | `drizzle-orm`, `core` types | provider SDKs |
| `storage` / `queue` / `transcription` / `media` / `imports` | their SDK + `core` ports | `db`, React |
| `apps/web` | everything through `src/lib/container.ts` | provider SDKs inside components |
| `apps/worker` | everything | React |

`apps/web/src/lib/container.ts` is the **single** place where concrete providers are
constructed from environment variables. Swapping Deepgram for a self-hosted
faster-whisper, or R2 for S3, is a one-line change there plus environment variables.
