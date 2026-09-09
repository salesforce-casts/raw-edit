# Railway media worker

Create one service named `media-worker` from `apps/worker`.

Recommended settings:

- Replicas: 1
- Restart: on failure
- Health check: `GET /health`
- `RENDER_CONCURRENCY=1`
- Do not attach a volume. Workers are stateless; R2 is durable storage.

Scale by adding replicas. Each replica runs at most one 4K render at a time.
