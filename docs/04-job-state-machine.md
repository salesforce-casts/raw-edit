# 4. Job & Video State Machine

## Video status

```
              ┌────────────────────────────────────────────────┐
              │                                                │
   UPLOADING ─┴─► UPLOADED ─► ANALYZING ─► TRANSCRIBING ─► DETECTING_TAKES
       │                │          │             │                │
       │                │          └─────────────┴────────────────┤
       │                │                                         ▼
       │                │                             READY_FOR_REVIEW ◄──┐
       │                │                                         │       │
       │                │                                         ▼       │
       │                │                                    RENDERING ───┤ (re-render /
       │                │                                         │       │  new export)
       │                │                                         ▼       │
       │                │                                     COMPLETE ───┘
       ▼                ▼                                         ▲
    FAILED ◄────────────┴───────── (any stage) ───────────────────┘
       │
       └─► retry ─► UPLOADED (analysis restart) or READY_FOR_REVIEW (render restart)
```

Legal transitions are declared once, in `packages/core/src/state/video-state.ts`, and
enforced by `assertTransition()` in every writer. An illegal transition throws rather
than silently corrupting a record — this is what stops a late-arriving worker from
dragging a `COMPLETE` video back to `RENDERING`.

| From | Allowed next |
|---|---|
| `UPLOADING` | `UPLOADED`, `FAILED` |
| `UPLOADED` | `ANALYZING`, `FAILED` |
| `ANALYZING` | `TRANSCRIBING`, `FAILED` |
| `TRANSCRIBING` | `DETECTING_TAKES`, `FAILED` |
| `DETECTING_TAKES` | `READY_FOR_REVIEW`, `FAILED` |
| `READY_FOR_REVIEW` | `RENDERING`, `ANALYZING` (re-analyse), `FAILED` |
| `RENDERING` | `COMPLETE`, `READY_FOR_REVIEW` (cancel), `FAILED` |
| `COMPLETE` | `RENDERING` (new export), `READY_FOR_REVIEW` (edit again) |
| `FAILED` | `UPLOADED`, `READY_FOR_REVIEW` (operator/user retry) |

Terminal-ish states (`COMPLETE`, `READY_FOR_REVIEW`) are re-enterable because a user
may render several presets from one edit.

## Job status

```
QUEUED ──claim──► RUNNING ──ok──► SUCCEEDED
   ▲                 │
   │             error│
   │                 ▼
   └──backoff──── (attempt < max) ──► QUEUED
                     │
                (attempt = max)
                     ▼
                   DEAD  (dead-letter queue, needs operator/user action)
```

* **Retries** — `max_attempts = 3` for analysis/render, exponential backoff
  `10s → 60s → 300s`. Errors are classified: `TransientError` retries,
  `PermanentError` (corrupt file, no audio stream, quota exceeded) goes straight to
  `DEAD` without burning attempts.
* **Locking** — BullMQ gives one consumer per job; on top of that, the worker writes
  `locked_by = <workerId>` and a `heartbeat_at` every 10 s. A `RUNNING` job whose
  heartbeat is older than 90 s is reclaimable by the sweeper.
* **Dead-letter** — `DEAD` jobs stay in `processing_job` with the full error and
  stack. `/api/videos/:id/retry` re-queues them, keeping the video record intact.
* **Failure isolation** — a failing job never mutates `video` fields other than
  `status`, `status_detail`, `error_message`, `progress`. Analysis results are
  written in a single transaction at the end of the job, so a crash mid-way leaves the
  previous transcript/EDL untouched.
* **Fairness** — the worker uses BullMQ's group/rate limiting: `WORKER_CONCURRENCY`
  jobs in flight, and at most `MAX_CONCURRENT_JOBS_PER_USER` (default 1) from any
  single user, so one creator rendering ten 4K videos cannot monopolise the fleet.

## Progress reporting

Progress is **measured, never faked**:

| Stage | Source of truth |
|---|---|
| Upload | bytes ACKed by R2 / total bytes |
| Analysing | fixed weights per sub-step, each sub-step reporting ffmpeg `out_time_us` |
| Transcribing | provider callback where available, else audio seconds submitted |
| Finding retakes | segments compared / total comparisons |
| Rendering | ffmpeg `-progress pipe:1` `out_time_us` ÷ planned output duration |

The worker writes progress to `processing_job.progress` **and** publishes it to Redis
channel `video:{id}:progress`. `/api/videos/:id/events` (SSE) forwards those messages;
if Redis is unavailable the endpoint degrades to a 2 s DB poll, and the client hook
degrades to plain polling if SSE fails. The browser may be closed at any time — all
state is in Postgres.
