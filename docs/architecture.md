# Raw Edit V1 architecture

This file is the implementation contract from the RawEdit system design.

## Spine

Browser → R2 (direct multipart) → worker analysis → deterministic EDL → human review → one encode from the original master.

Next.js on Vercel is the control plane only. FFmpeg runs only on the Railway worker. The original object is never mutated. AI may pick among timestamped take candidates; it never invents timestamps and is off by default.

## Packages

- `@raw-edit/core` — ports, retake scoring, dual-signal silence, EDL, render plans, streaming SHA-256, state machines. Zero I/O.
- Adapters: `db`, `storage`, `queue`, `transcription`, `media`, `imports`
- Construction only in `apps/web/lib/container.ts` and `apps/worker/src/lib/context.ts`

## Six ports

StorageProvider, TranscriptionProvider, QueueProvider, VideoProcessor, CloudImportProvider, PaymentProvider.

## Invariants

- Resume authority is R2 `ListParts`, never the client's memory.
- Part size is `clamp(size / 9000, 8 MiB, 512 MiB)`.
- Silence cuts require acoustic quiet **and** a transcript gap.
- Undo is an override stack replayed onto the automatic EDL.
- Render uses `atrim`/`concat` by default; `select` is a fallback past 400 KEEP ranges.
- Jobs are claimed by `sha256(type|videoId|inputVersion)`. A second render with a new EDL version is new work.
- `FAILED → RUNNING` is a legal job retry. A RUNNING job silent for 90s is reclaimed.
- Retention may delete keys only under `originals/`.
- Share slugs are 12 characters from a 31-symbol alphabet.
- Private, loopback, link-local and CGNAT import URLs are refused.

See the repository README for local development.
