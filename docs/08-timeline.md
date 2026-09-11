# 8. Timeline, Clipping and Trimming

The review screen's job is to let a creator judge and adjust an edit they did not make.
That needs a timeline that reads like an NLE — ruler, zoom, tracks, clips, trim handles,
a razor — without ever becoming one, because this product is **subtractive**: there is
one source, and an edit is a set of removals over it.

## 8.1 Two time bases

Everything below follows from one distinction.

```
source time   0 ─────────────────────────────────────────────► duration
              [ keep ][ X ][ keep ][ X ][ keep ][ X ][  keep  ]
                               │
                               │  keepRanges + accumulated offset
                               ▼
program time  0 ──────────────────────────► proposedDuration
              [ keep ][ keep ][ keep ][  keep  ]
```

- **Source time** is where every `EditDecision`, transcript word, take group and silence
  region lives. Editing happens here, because overrides are expressed in source time.
- **Program time** is what the rendered file *is*. Its length is `proposedDuration`.

`mapToEditedTime` / `mapToSourceTime` in `util/ranges.ts` convert between them. Both
return `null` for a source time inside a removed span — that case is real and the UI
must show it rather than clamping, or the compare view silently lies.

The timeline draws the **source** lane, because that is what you edit. The compare view
plays both.

## 8.2 The clip model

A clip is not a stored object. Clips are derived, every render, from the decisions:

```
clips = invertRanges(removals, duration)   // the keep set
        subdivided at any split points
```

This is deliberate. A parallel clip list would be a second source of truth that could
disagree with the EDL, and the EDL is what renders. `deriveClips` is therefore a pure
function of `(decisions, duration)` and nothing caches its output across an edit.

Each clip carries its source range, its program range (offset by everything kept before
it), and the ids of the removals adjacent to it — which is what makes trimming outward
possible without a lookup at drag time.

## 8.3 How clipping and trimming map onto the EDL

Every gesture on the timeline resolves to an override on the existing stack, so undo,
redo and "reset automatic edits" keep working with no new machinery.

| Gesture | Meaning | Override |
|---|---|---|
| Drag a clip edge **inward** | remove more footage | `remove` over the abandoned span |
| Drag a clip edge **outward** | reclaim removed footage | `restoreRange` over the reclaimed span |
| Razor / split at the playhead | divide one clip in two | `split` |
| Delete a selected clip | remove it, close the gap | `remove` over the clip |
| Restore a removal | undo one automatic cut | `restore` (existing) |

Two new override types are needed:

```ts
| { type: 'restoreRange'; startTime: number; endTime: number }
| { type: 'split'; time: number }
```

`restoreRange` subtracts a span from every overlapping removal — clipping an edge,
splitting a removal in two, or dropping it entirely. It is deliberately **geometric and
id-free**: an override that referenced a decision id would break when an earlier
override in the stack shifted which decisions exist, and the stack is replayed from
scratch on every edit.

`split` is stored as a zero-length `keep` decision. That looks odd until you notice it
is the honest encoding: a split *is* a statement about the timeline, it belongs in the
EDL so undo and reset cover it, it round-trips through the `edit_decision` table
unchanged, and `buildRenderPlan` ignores it because it only ever reads removals. A split
is presentational by construction — it cannot alter the output, and adjacent keep ranges
are merged before rendering regardless.

### Why there is no lift delete

In a track-based NLE, deleting a clip can either close the gap (ripple) or leave a hole
(lift). Here the keep set is the *complement* of the removals, so a hole is not
representable — removing a span always closes the gap. Only ripple delete exists, and
the UI does not offer a choice it cannot honour.

## 8.4 Module layout

```
packages/core/src/timeline/
  viewport.ts    pixels-per-second, scroll, ms↔px, zoom-at-anchor, fit,
                 visible window, adaptive ruler ticks, HH:MM:SS:FF
  clips.ts       deriveClips, splitAt, trimClip, deleteClip, clipAt
  snapping.ts    candidate collection + nearest-within-threshold
```

Pure, no DOM, colocated `*.test.ts`. The arithmetic is settled and tested before any
pixel depends on it — a timeline that is wrong by a frame is worse than no timeline,
because it is wrong invisibly.

```
apps/web/src/components/timeline/
  timeline-root.tsx     composition, selection, pointer routing
  ruler.tsx             ticks + drag-to-scrub
  track-header.tsx      the fixed left gutter
  clip-track.tsx        clips, removals, trim handles, razor
  waveform-track.tsx    canvas waveform, redrawn per zoom
  filmstrip.tsx         sprite-sheet frames behind the clips
  playhead.tsx          imperative, rAF-driven
  toolbar.tsx           zoom, fit, snap, split, delete
  use-viewport.ts       viewport state, wheel/pinch/keyboard zoom
  use-timeline-keys.ts  shortcut map, inert while typing
```

## 8.5 Staying smooth

"Smooth" is not a finish; it is a set of specific decisions about what does **not**
cause a React render.

1. **The playhead never re-renders the tree.** `timeupdate` fires about four times a
   second, which is visibly steppy. Instead a rAF loop reads `video.currentTime` and
   writes `transform: translate3d(...)` straight to the playhead element. React state
   for the current time is updated at ~10 Hz, only for the transcript highlight and the
   timecode readout.

2. **Dragging writes to the DOM, not to state.** A trim drag updates the dragged clip's
   inline geometry through a ref and commits one override on pointer-up. A `setState`
   per `pointermove` would re-render every clip, every tick and the whole waveform on
   each of ~120 events per second.

3. **Pointer events are rAF-coalesced.** Moves collapse to at most one write per frame.

4. **Only the visible window is built.** Ticks, clips and filmstrip tiles outside the
   scrolled viewport are never created. An hour at high zoom is tens of thousands of
   ticks; rendering them all is what makes naive timelines stutter.

5. **The waveform is a canvas, redrawn on zoom.** An SVG polyline with a point per peak
   is fine at one screen width and hopeless at 40× zoom. The canvas draws min/max per
   pixel column from the peak array — constant cost per frame regardless of duration.

6. **The filmstrip is one sprite sheet.** Frames are tiled into a single image with a
   JSON index, positioned with `background-position`. One request serves the whole
   track instead of one per thumbnail.

7. **Drags are bound to the window, not the handle.** A 4 px handle cannot hold a thumb;
   the pointer leaves it immediately. Handles also have a hit area far wider than their
   paint.

## 8.6 Snapping

Snap targets, in priority order when two are within threshold:

1. the playhead
2. clip edges (the cut points)
3. **transcript word boundaries**
4. the frame grid

Threshold is defined in **pixels** (8 px) and converted to time through the current
zoom, so snapping feels identical at every zoom level rather than becoming useless when
zoomed in.

Word-boundary snapping is the affordance a general NLE cannot offer, because it does not
know what was said. Dragging a cut edge should catch on the start of a word — it is the
product's premise expressed as one UI detail.

## 8.7 Frame accuracy

The ruler renders `HH:MM:SS:FF` and arrow-key nudges move exactly one frame. Frame
duration is `1 / frameRate` where `frameRate` is the source's average rate, and
`snapToFrameGrid` (already used by `buildRenderPlan`) rounds outward to whole frames.

Snapping is applied by **frame index**, not by repeatedly adding a frame duration:
at 29.97 fps a frame is 33.3667 ms, and accumulating that per frame drifts visibly over
a long recording. `floor(time * fps + 0.5) / fps` stays exact.

The timeline snaps display and interaction to the frame grid, but the *authority* is
still `buildRenderPlan`, which re-snaps at render time. The UI agreeing with the render
is a property to verify, not to assume.

## 8.8 Compare view

Once an export completes, the screen can show the original and the rendered result side
by side.

- **One playhead, two clocks.** Scrubbing either player moves the other through
  `mapToEditedTime` / `mapToSourceTime`. One player owns the clock at a time and the
  other follows; both correcting each other oscillates.
- **Modes:** side by side, A/B (one viewport, toggled), or edited only.
- **Inside a cut**, source time has no program equivalent. The edited player holds at
  the next join and the UI says so.

This answers a question the review screen otherwise cannot: *did the render actually do
what the preview promised?* Preview skips ranges in a player; the export is a real
encode. Side by side, a divergence is visible before publishing rather than after.

## 8.9 What this deliberately is not

| Excluded | Why |
|---|---|
| Drag clips to reorder | The single-pass `split → atrim → concat` render assumes ranges in increasing order. Reordering forces buffering and breaks the one-encode property. |
| Multiple video tracks | Compositing is a different render graph and a different product. |
| Transitions, effects, titles | Each adds an encode stage; all are out of scope for v1. |

The reorder exclusion is a constraint propagating **upward from the render**, not a
scoping preference. A UI that allowed it would quietly invalidate the render strategy,
and the failure would surface as memory exhaustion on a long video — far from the
feature that caused it.
