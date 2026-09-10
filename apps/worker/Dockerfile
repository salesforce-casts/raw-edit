# syntax=docker/dockerfile:1
#
# Media worker: Node + ffmpeg, optionally with faster-whisper for self-hosted
# transcription. Built from the monorepo root:
#
#   docker build -f apps/worker/Dockerfile -t rawedit-worker .
#
# Railway: set the Dockerfile path to apps/worker/Dockerfile and the build context
# to the repository root.

# ---------------------------------------------------------------- build stage --
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy only manifests first so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
COPY packages/queue/package.json packages/queue/
COPY packages/transcription/package.json packages/transcription/
COPY packages/media/package.json packages/media/
COPY packages/imports/package.json packages/imports/
COPY apps/worker/package.json apps/worker/

# The web app is not part of the worker image; omit its workspace entirely.
RUN npm install --omit=optional --workspaces --include-workspace-root \
      --workspace @rawedit/core \
      --workspace @rawedit/db \
      --workspace @rawedit/storage \
      --workspace @rawedit/queue \
      --workspace @rawedit/transcription \
      --workspace @rawedit/media \
      --workspace @rawedit/imports \
      --workspace @rawedit/worker

COPY packages/ packages/
COPY apps/worker/ apps/worker/

RUN npm run build -w @rawedit/core \
 && npm run build -w @rawedit/db \
 && npm run build -w @rawedit/storage \
 && npm run build -w @rawedit/queue \
 && npm run build -w @rawedit/transcription \
 && npm run build -w @rawedit/media \
 && npm run build -w @rawedit/imports \
 && npm run build -w @rawedit/worker

RUN npm prune --omit=dev

# ----------------------------------------------------------------- run stage --
FROM node:22-bookworm-slim AS runtime

# ffmpeg and ffprobe are the worker's reason for existing.
# ca-certificates is needed for HTTPS reads from R2.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Optional: self-hosted transcription. Enabled at build time so the default image
# stays small; a hosted provider needs none of this.
#   docker build --build-arg INSTALL_FASTER_WHISPER=1 ...
ARG INSTALL_FASTER_WHISPER=0
RUN if [ "$INSTALL_FASTER_WHISPER" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 python3-pip \
      && pip3 install --no-cache-dir --break-system-packages faster-whisper==1.1.1 \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
ENV NODE_ENV=production \
    WORKER_TMP_DIR=/tmp/rawedit

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker ./apps/worker

# Renders write multi-gigabyte scratch files; keep them off the image layer.
RUN mkdir -p /tmp/rawedit && chown -R node:node /tmp/rawedit /app
USER node

# tini reaps ffmpeg children so a cancelled render cannot leave a zombie behind,
# and forwards SIGTERM so in-flight jobs drain cleanly on redeploy.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/worker/dist/index.js"]
