# 3. Processing Pipeline

```
iPhone / Browser
      │  multipart PUTs (signed, direct to R2)
      ▼
Cloudflare R2  originals/{userId}/{videoId}/{filename}        ← NEVER rewritten
      │
      │  POST /api/uploads/:id/complete  → enqueue ANALYZE_VIDEO
      ▼
┌──────────────────────── Railway worker (Docker, ffmpeg) ────────────────────────┐
│                                                                                │
│  ANALYZE_VIDEO                                                                 │
│    1. ffprobe over a short-lived signed GET URL (no download)   →  0–10 %       │
│       stores codec, resolution, fps, VFR flag, colour metadata, HDR format     │
│    2. extract audio: ffmpeg -vn -ac 1 -ar 16000 -c:a pcm_s16le  →  10–30 %      │
│    3. silencedetect pass over the extracted audio               →  30–40 %      │
│    4. thumbnail + preview proxy + waveform peaks (preview only) →  40–55 %      │
│         proxies exist ONLY for the browser player; renders never read them     │
│    5. TranscriptionProvider.transcribe(audio)                   →  55–85 %      │
│    6. segmentation → retake detection → filler tagging → EDL    →  85–100 %     │
│    7. status = READY_FOR_REVIEW                                                │
│                                                                                │
│  RENDER_VIDEO                                                                  │
│    1. load active EDL + export preset                                          │
│    2. build render plan (padding, snap to frame grid, merge, drop tiny)        │
│    3. single-pass ffmpeg from the ORIGINAL master                              │
│       progress parsed from `-progress pipe:1`                 →  0–92 %        │
│    4. multipart upload of the result to R2                     → 92–99 %       │
│    5. export row COMPLETE, video status COMPLETE, share link ready             │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Stage detail

### 1. Probe
`ffprobe -v error -print_format json -show_format -show_streams -show_entries
stream_side_data` is run **against a signed URL**, so a 4 GB master is never copied
onto the worker's disk just to read its header. The full JSON is persisted in
`video.probe_json`.

HDR classification (`packages/core/src/analysis/hdr.ts`):

| transfer | primaries | side data | ⇒ `hdr_format` |
|---|---|---|---|
| `smpte2084` | `bt2020` | – | `HDR10` |
| `arib-std-b67` | `bt2020` | – | `HLG` |
| any | any | `DOVI configuration record` | `DOLBY_VISION` |
| otherwise | | | `null` (SDR) |

### 2. Audio extraction
16 kHz mono PCM. This is the only derivative that transcription sees. It is deleted
from the worker's scratch disk when the job ends; it is never uploaded.

### 3. Silence detection
`ffmpeg -i audio.wav -af silencedetect=noise=-32dB:d=0.25 -f null -` parsed into
`{ start, end }` ranges. Two independent signals are used later:

* **word timings** from the transcript → where speech definitely is
* **silencedetect** → where the audio is definitely quiet

A gap is only proposed for removal when *both* agree, which is what stops breaths
and quiet consonants from being cut.

### 4. Preview derivatives (optional, never used for rendering)
* `thumbnail_key` — single JPEG at 10 % of duration
* `proxy_key` — 720p H.264 CRF 28 faststart, tone-mapped if HDR, purely so the
  review player is scrubbable on cellular
* `waveform_key` — JSON peak array for the timeline

### 5. Transcription
`TranscriptionProvider.transcribe({ audioPath|audioUrl, language })` returns
`{ words: [{ text, start, end, confidence }], language, provider, model, raw }`.
Word-level timings are mandatory; a provider that cannot supply them is rejected at
construction time.

### 6. Analysis → EDL
Pure functions in `@rawedit/core`, fully unit-tested, no I/O:

```
words
  └─► segmentWords()          gap ≥ 0.45 s or sentence-final punctuation
        └─► tagFillers()      um / uh / err / you know / like (config)
              └─► detectRetakes()   ← the core feature, see below
                    └─► detectSilenceRemovals()
                          └─► buildEdl()   → EditDecision[]
```

`detectRetakes` combines deterministic string/timing analysis with an optional
`EditAdvisor`. The default advisor is `HeuristicEditAdvisor` (no network). An
`LlmEditAdvisor` may be enabled to arbitrate **only** low-margin groups; it receives
*text* and returns *which candidate index is the best take plus a reason*. It never
sees or emits timestamps, and it can never introduce a cut the deterministic layer
did not propose. See `docs/07-retake-detection.md`.

## Idempotency

Each job carries `idempotency_key = sha256(videoId | type | inputVersion)`.
`inputVersion` is the EDL version for renders and the storage key + checksum for
analysis. Re-enqueuing the same key returns the existing `processing_job` instead of
duplicating work, so a webhook replay or a double-click cannot cost two renders.
