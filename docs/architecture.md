# Raw Edit V1 architecture

This file is the implementation contract. The repository follows the authoritative product architecture:

- Next.js App Router on Vercel is the control plane only.
- Cloudflare R2 is the data plane. The original master is immutable.
- Neon PostgreSQL is the source of truth. BullMQ / Upstash Redis is execution coordination.
- Railway Node workers run FFmpeg, ffprobe, transcription, and render.
- `packages/db` is the only schema definition.
- Automatic editing writes an EDL. It never mutates source media.
- AI may choose among timestamped take candidates. It does not invent timestamps.
- Final exports always read the original master.

See the repository README for local development and deployment.
