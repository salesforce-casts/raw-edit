# Railway media worker

Create one service named `media-worker` from `apps/worker`.

Recommended settings:

- Replicas: 1
- Restart: on failure
- Health check: `GET /health`
- `RENDER_CONCURRENCY=1`
- Scratch on a volume (`WORKER_TMP_DIR` / `WORKER_SCRATCH_DIR`), not the container layer. A 4 GB source plus render wants ~8 GB.
- PID 1 is `tini` so cancelled ffmpeg processes are reaped.
- Do not attach a volume for durable media. R2 is durable storage; the volume is scratch only.

Scale by adding replicas. Each replica runs at most one 4K render at a time.
