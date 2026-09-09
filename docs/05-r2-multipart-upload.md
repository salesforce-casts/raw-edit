# 5. R2 Multipart Upload Design

Goals: multi-gigabyte iPhone files go **browser → R2 directly**, never through a
Next.js function; the upload survives Safari backgrounding, network switches and page
refreshes; and the stored object is provably the file the user picked.

## Wire protocol

```
POST   /api/uploads                     create video + upload session + R2 upload id
POST   /api/uploads/:id/parts           batch-sign N part URLs
GET    /api/uploads/:id                 resume info (server ListParts + session row)
POST   /api/uploads/:id/complete        CompleteMultipartUpload, verify, enqueue
POST   /api/uploads/:id/abort           AbortMultipartUpload, free the storage
```

### `POST /api/uploads`
Request `{ filename, fileSize, mimeType, lastModified, durationHint? }`.

1. Authorise + check the plan's per-file and per-month limits.
2. Reject unsupported container/mime early (`video/*`, `.mov .mp4 .m4v .hevc …`).
3. Compute `storageKey = originals/{userId}/{videoId}/{sanitisedFilename}`.
4. Choose a part size — see below — and `CreateMultipartUpload` on R2.
5. Insert `video (UPLOADING)` + `upload_session (PENDING)`.
6. Return `{ videoId, uploadId, key, partSize, totalParts, sessionId }`.

**The `uploadId` and `key` are opaque to the client for retrieval only.** No R2
credentials, account id or endpoint secret ever leaves the server.

### Part size selection
S3/R2 allow 10 000 parts, minimum 5 MiB (except the last).

```
partSize = clamp(ceil(fileSize / 9000), 8 MiB, 512 MiB) rounded up to 1 MiB
```

8 MiB floor keeps a single failed part cheap to retry on cellular; the 9 000-part
target leaves headroom under the 10 000 cap. A 4 GB file ⇒ 8 MiB parts ⇒ 500 parts.

### `POST /api/uploads/:id/parts`
Request `{ partNumbers: number[] }` (batched, ≤ 100 at a time). The server signs
`UploadPart` URLs with a **5-minute TTL** scoped to exactly that bucket, key, uploadId
and part number. Short TTLs are safe because the client re-requests on demand; the
signer is cheap and never touches the file bytes.

### `POST /api/uploads/:id/complete`
Request `{ parts: [{ partNumber, etag, size }], sha256? }`.

1. Re-`ListParts` on R2 and reconcile with the client's list — the **server's** view
   wins, so a lying or confused client cannot complete a partial object.
2. Verify `sum(part.size) === upload_session.file_size`; reject otherwise.
3. `CompleteMultipartUpload`, then `HeadObject` and verify `ContentLength`.
4. Persist `checksum_sha256` (client-computed, see below), mark session `COMPLETED`,
   video `UPLOADED`, write an `UPLOADED_MINUTES` usage record, enqueue
   `ANALYZE_VIDEO`.

## Resumability

Three failure modes, three answers:

| Event | Recovery |
|---|---|
| Network drop / Wi-Fi ↔ cellular switch | Uppy retries the failed part with a fresh signed URL. The `File` handle is still live, so this is invisible to the user. |
| Safari backgrounded / tab suspended | Upload pauses. On `visibilitychange` the client calls `GET /api/uploads/:id`, learns which parts R2 already has, and continues from there. |
| Page refresh / Safari kills the tab | The `File` handle is **gone** — no browser can restore it. We persist `{sessionId, uploadId, key, fingerprint, filename, size}` in `localStorage`, and on next load show *"Resume `IMG_4821.MOV`"*. The user re-picks the file; we verify `fingerprint = sha256(name:size:lastModified)` matches, then skip every part R2 already holds. |

The last row is the honest limit of the platform, and the UI says so explicitly
rather than pretending the upload continues by itself.

Server-side, `upload_session.parts` is updated opportunistically from client reports,
but **R2's `ListParts` is always the authority** on resume.

## Integrity

* **Immediate, always on** — byte accounting (`Σ part sizes` = declared size =
  `HeadObject.ContentLength`) plus R2's own per-part MD5 ETag validation.
* **End-to-end, default on** — a Web Worker streams the file through a pure-TS
  incremental SHA-256 (`@rawedit/core/hash`) while the upload runs and posts the digest
  with `complete`. The Railway worker recomputes SHA-256 while it streams the object
  for analysis and sets `video.checksum_verified_at`. A mismatch fails the video with
  `CHECKSUM_MISMATCH` and never renders from it.

Hashing is skippable via `NEXT_PUBLIC_UPLOAD_HASHING=0` (very old devices); the byte
accounting checks still run.

## Quality

The browser uploads the exact bytes of the file the user selected. There is no
client-side transcode, re-container, downscale or `canvas` round-trip anywhere in the
path. The `<input type="file" accept="video/*">` element on iOS is used **without**
capture constraints so Photos hands over the original asset.

## Cleanup

* `upload_session.expires_at = created_at + 24 h`. A daily `CLEANUP_SOURCE` job
  aborts expired R2 multipart uploads (they are billed until aborted) and marks the
  session `EXPIRED`.
* Aborting from the UI issues `AbortMultipartUpload` immediately.
