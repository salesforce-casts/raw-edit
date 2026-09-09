# 6. FFmpeg Render Strategy

Rule zero: **the render reads the original master.** Proxies exist only for the
review player. There is exactly one encode between the uploaded file and the
delivered file.

```
R2 original  ──signed GET──►  ffmpeg (one pass)  ──►  R2 export
```

## From EDL to render plan

`packages/core/src/render/plan.ts` — pure, unit-tested.

1. Take the `REMOVE` decisions from the active EDL.
2. Invert them over `[0, duration]` to get **keep ranges**.
3. Apply padding: each keep range grows by `padPreMs` at its head and `padPostMs` at
   its tail (never past a neighbouring removal's midpoint, never past `[0, duration]`).
4. Merge keep ranges separated by less than `mergeGapMs` (default 120 ms) — removing a
   0.1 s sliver produces an audible click, so we do not.
5. Drop keep ranges shorter than `minSegmentSeconds` (default 0.35 s).
6. **Snap to the frame grid**: `start = floor(start * fps) / fps`,
   `end = ceil(end * fps) / fps`. This is what keeps audio and video in sync — each
   kept range then has an exact whole number of frames, so per-cut rounding error
   cannot accumulate into drift.

The plan carries `outputDuration = Σ (end − start)`, which is the denominator for
render progress and the input to the size estimate.

## Two single-pass filter strategies

Both decode once and encode once. The choice is recorded on the `export` row.

### A. `filter_concat` — the default

```
[0:v]split=3[v0i][v1i][v2i]; [0:a]asplit=3[a0i][a1i][a2i];
[v0i]trim=0:5.24,setpts=PTS-STARTPTS[v0]; [a0i]atrim=0:5.24,asetpts=PTS-STARTPTS[a0];
...
[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[outv][outa]
```

`atrim` cuts on **sample** boundaries and `trim` on frame boundaries, and `concat`
re-stamps each segment, so the output is frame-exact, sample-exact and correct for VFR
sources without any special casing.

### B. `filter_select` — fallback past `MAX_CONCAT_SEGMENTS` (default 400)

```
-vf  "select='between(t,0.000,5.240)+between(t,9.100,17.480)',setpts=N/FRAME_RATE/TB"
-af  "aselect='between(t,0.000,5.240)+between(t,9.100,17.480)',asetpts=N/SR/TB"
```

Used only when the segment count would make the filter graph unwieldy. `aselect` can
only drop **whole audio frames** (~21 ms at 48 kHz), so its cuts do not line up with
the video's, and `between()` is inclusive at both ends so it keeps an extra frame per
segment. Both effects are recorded as an explicit warning on the export row and shown
in the UI — never silent.

### Why concat, measured

`aselect`'s frame granularity is not a rounding detail; it accumulates. Rendering the
same 60 s source both ways (30 segments, 640×360, 48 kHz AAC):

| Strategy | Output duration | A/V drift | Peak RSS | Wall time |
|---|---|---|---|---|
| `filter_select` | 37.0 s (expected 36.0 s) | **819 ms** | 80 MB | 1.7 s |
| `filter_concat` | 36.0 s | **0 ms** | 80 MB | 1.9 s |

The usual objection to split/trim/concat is that the split branches buffer. That does
not happen for ranges in increasing order: each branch's `trim` discards everything
outside its own window, so nothing queues. At 200 segments the concat path peaks at
93 MB and finishes in 2.9 s with no drift, which is why the cap sits at 400 rather
than at 60.

`-ss`/`-to` fast-seek is deliberately not used for multi-range cuts: it is not
frame-accurate on open-GOP HEVC, which is exactly what iPhones produce.

### Reconnect flags
`-reconnect`/`-reconnect_streamed`/`-reconnect_delay_max` keep a long 4K pull from R2
alive across a dropped connection. They belong to ffmpeg's HTTP protocol handler, so
they are only passed for an `http(s)` input — ffmpeg rejects the entire invocation
with *"Option reconnect not found"* when the input is a local path.

## Codec & quality settings

| Source | `PRESERVE_SOURCE` output |
|---|---|
| H.264 8-bit | `libx264 -crf 18 -preset slow -profile:v high -pix_fmt yuv420p` |
| HEVC 8-bit | `libx265 -crf 20 -preset medium -pix_fmt yuv420p` |
| HEVC 10-bit / HDR | `libx265 -crf 20 -preset medium -pix_fmt yuv420p10le` + HDR params |
| audio | `aac -b:a 192k` (256k for ≥ 2 channels at 48 kHz), sample rate preserved |

`COMPATIBLE_MP4` is always `libx264 + aac`, `yuv420p`, `-movflags +faststart`.

Quality-based (CRF) encoding only — no arbitrary target bitrates. Resolution, aspect
ratio, frame rate, rotation metadata and colour tags are copied from the probe unless
the preset explicitly changes them.

**Orientation**: iPhone portrait video is landscape pixels plus a rotation matrix.
We never bake in a `transpose`; `-map_metadata 0` plus writing the `rotate`
side-data through keeps players correct and avoids a needless re-scale.

## Export presets

| Preset | Strategy | Resolution | Video | Audio | Default |
|---|---|---|---|---|---|
| **Original Quality** | `PRESERVE_SOURCE` | unchanged (4K stays 4K) | source codec, CRF 18/20 | AAC 192k | ✅ |
| **Social Media** | `COMPATIBLE_MP4` | capped at 1080p **long edge shown in the UI before render** | H.264 CRF 20 | AAC 160k | |
| **Smaller File** | `COMPATIBLE_MP4` | capped at 1080p | H.264 CRF 26 | AAC 128k | |

The UI shows the computed output resolution, codec and estimated size **before** the
render is queued (`estimateExportSize()` in core: bits-per-pixel model per codec/CRF,
plus audio bitrate × duration).

## HDR

`ffprobe` gives us `color_primaries`, `color_trc`, `color_space`, `pix_fmt` bit depth
and Dolby Vision side data. Three explicit paths:

1. **SDR source** → tags copied verbatim, nothing else.
2. **HDR source + Preserve Source** → `libx265`, 10-bit, and
   `-x265-params "hdr-opt=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:
   colormatrix=bt2020nc[:master-display=…][:max-cll=…]"` with the mastering display
   and content light level carried over from the probe when present. Output stays HDR.
3. **HDR source + Compatible MP4** → the user has explicitly chosen an SDR
   deliverable, so we tone-map with
   `zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p`
   (BT.2390 `tonemap_opencl` is not assumed to be available). This is the **only**
   path that tone-maps, and the UI labels it.

Dolby Vision RPU cannot be re-encoded by `libx265` without a licensed toolchain. For
a DV source we encode the HDR10 base layer and attach an explicit
`DOLBY_VISION_RPU_DROPPED` warning to the export — we do not pretend it survived.

Washed-out output is caused by dropping the transfer/primaries tags; every code path
sets them explicitly, and `test/render/ffmpeg-args.test.ts` asserts it.

## Upload of the result

Rendered files go up with the same multipart machinery (server-side this time), to
`exports/{userId}/{videoId}/{exportId}.mp4`. `video.storage_key` is untouched.
