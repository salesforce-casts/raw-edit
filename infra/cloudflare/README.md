# Cloudflare R2

Create private buckets per environment:

- `rawedit-dev`
- `rawedit-prod`

Do not enable public access.

Application object keys:

```
users/{userId}/videos/{videoId}/source/original.mov
users/{userId}/videos/{videoId}/proxy/720p.mp4
users/{userId}/videos/{videoId}/audio/transcription.wav
users/{userId}/videos/{videoId}/thumb/poster.jpg
users/{userId}/videos/{videoId}/exports/{exportId}.mp4
```

Optional lifecycle rules should only clean abandoned multipart uploads, never user originals.
