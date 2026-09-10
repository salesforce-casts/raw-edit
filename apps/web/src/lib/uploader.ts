'use client';

import Uppy, { type UppyFile } from '@uppy/core';
import AwsS3 from '@uppy/aws-s3';
import { fileFingerprint, UploadRateTracker, type UploadPartRef } from '@rawedit/core';
import { api } from './utils';

/**
 * The upload client.
 *
 * Uppy's AwsS3 plugin handles chunking, per-part retries and concurrency; every
 * signing call is routed to our own API so the browser never sees an R2 credential.
 * The UI is ours, driven by the events below.
 */

export interface UploadStats {
  filename: string;
  fileSize: number;
  bytesUploaded: number;
  percent: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  /** 0..1; runs alongside the upload in a Web Worker. */
  hashProgress: number;
  resolution: string | null;
  status: 'idle' | 'preparing' | 'uploading' | 'paused' | 'completing' | 'done' | 'error';
  error: string | null;
  videoId: string | null;
  resumedFromPart: number;
}

export interface UploadHandle {
  cancel: () => Promise<void>;
  pause: () => void;
  resume: () => void;
}

interface CreateResponse {
  resumed: boolean;
  videoId: string;
  sessionId: string;
  uploadId: string;
  key: string;
  partSize: number;
  totalParts: number;
  uploadedParts: UploadPartRef[];
}

/** Persisted so an interrupted upload can be offered back after a refresh. */
const STORAGE_KEY = 'rawedit.pendingUploads';

export interface PendingUpload {
  sessionId: string;
  videoId: string;
  filename: string;
  fileSize: number;
  fingerprint: string;
  startedAt: number;
}

export function readPendingUploads(): PendingUpload[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingUpload[];
    // A day-old entry is past the session's own expiry; drop it.
    return parsed.filter((entry) => Date.now() - entry.startedAt < 24 * 60 * 60 * 1000);
  } catch {
    return [];
  }
}

function writePendingUploads(entries: PendingUpload[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Private mode, or storage full. Resume-after-refresh degrades; upload does not.
  }
}

export function rememberPendingUpload(entry: PendingUpload): void {
  const existing = readPendingUploads().filter((item) => item.sessionId !== entry.sessionId);
  writePendingUploads([entry, ...existing].slice(0, 5));
}

export function forgetPendingUpload(sessionId: string): void {
  writePendingUploads(readPendingUploads().filter((entry) => entry.sessionId !== sessionId));
}

/** Read width and height without decoding the whole file. */
export async function readVideoResolution(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const element = document.createElement('video');
    const url = URL.createObjectURL(file);
    const finish = (value: string | null) => {
      URL.revokeObjectURL(url);
      element.remove();
      resolve(value);
    };
    element.preload = 'metadata';
    element.muted = true;
    element.onloadedmetadata = () => {
      finish(element.videoWidth > 0 ? `${element.videoWidth}×${element.videoHeight}` : null);
    };
    // Safari cannot always decode HEVC metadata in a detached element; that is fine,
    // ffprobe establishes the real numbers server-side.
    element.onerror = () => finish(null);
    setTimeout(() => finish(null), 5000);
    element.src = url;
  });
}

export interface StartUploadOptions {
  file: File;
  onStats: (stats: UploadStats) => void;
  onComplete: (videoId: string) => void;
  onError: (message: string) => void;
  /** Off only for very old devices; the byte-accounting checks still run. */
  hashing?: boolean;
}

export async function startUpload(options: StartUploadOptions): Promise<UploadHandle> {
  const { file, onStats, onComplete, onError } = options;
  const hashing = options.hashing !== false;

  const fingerprint = fileFingerprint(file.name, file.size, file.lastModified);
  const rate = new UploadRateTracker();

  const stats: UploadStats = {
    filename: file.name,
    fileSize: file.size,
    bytesUploaded: 0,
    percent: 0,
    bytesPerSecond: null,
    etaSeconds: null,
    hashProgress: hashing ? 0 : 1,
    resolution: null,
    status: 'preparing',
    error: null,
    videoId: null,
    resumedFromPart: 0,
  };
  const emit = () => onStats({ ...stats });
  emit();

  void readVideoResolution(file).then((resolution) => {
    stats.resolution = resolution;
    emit();
  });

  // ---- open (or resume) the session -----------------------------------------
  const session = await api<CreateResponse>('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name,
      fileSize: file.size,
      mimeType: file.type,
      lastModified: file.lastModified,
      fingerprint,
    }),
  });

  stats.videoId = session.videoId;
  stats.resumedFromPart = session.uploadedParts.length;
  stats.bytesUploaded = session.uploadedParts.reduce((sum, part) => sum + part.size, 0);
  stats.percent = file.size > 0 ? (stats.bytesUploaded / file.size) * 100 : 0;
  stats.status = 'uploading';
  emit();

  rememberPendingUpload({
    sessionId: session.sessionId,
    videoId: session.videoId,
    filename: file.name,
    fileSize: file.size,
    fingerprint,
    startedAt: Date.now(),
  });

  // ---- hash in the background ------------------------------------------------
  let sha256: string | null = null;
  let hashWorker: Worker | null = null;
  if (hashing) {
    hashWorker = startHashWorker(file, (message) => {
      if (message.type === 'progress') {
        stats.hashProgress = message.totalBytes > 0 ? message.bytesHashed / message.totalBytes : 1;
        emit();
      } else if (message.type === 'done') {
        sha256 = message.sha256;
        stats.hashProgress = 1;
        emit();
      } else {
        // Hashing is an integrity nicety; never block an upload on it.
        stats.hashProgress = 1;
        emit();
      }
    });
  }

  // ---- drive the multipart upload -------------------------------------------
  const uppy = new Uppy({
    autoProceed: true,
    allowMultipleUploadBatches: false,
    debug: false,
  }).use(AwsS3, {
    shouldUseMultipart: true,
    // Enough parallelism to saturate a good connection without swamping a phone.
    limit: 4,
    getChunkSize: () => session.partSize,

    async createMultipartUpload() {
      return { uploadId: session.uploadId, key: session.key };
    },

    async listParts() {
      // R2 is the authority on what has landed; this is what makes resume correct.
      const state = await api<{ uploadedParts: UploadPartRef[] }>(`/api/uploads/${session.sessionId}`);
      return state.uploadedParts.map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag,
        Size: part.size,
      }));
    },

    async signPart(_file, { partNumber }) {
      const signed = await api<{ parts: { partNumber: number; url: string }[] }>(
        `/api/uploads/${session.sessionId}/parts`,
        { method: 'POST', body: JSON.stringify({ partNumbers: [partNumber] }) },
      );
      const url = signed.parts.find((part) => part.partNumber === partNumber)?.url;
      if (!url) throw new Error(`No signed URL was returned for part ${partNumber}`);
      return { url };
    },

    async completeMultipartUpload() {
      stats.status = 'completing';
      emit();
      // Wait for the hash so the server can store it with the object; the upload is
      // already done at this point, so this only ever costs a moment.
      if (hashing && sha256 === null) sha256 = await waitForHash(() => sha256, 30_000);

      const result = await api<{ videoId: string }>(`/api/uploads/${session.sessionId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ sha256: sha256 ?? undefined }),
      });
      return { location: result.videoId };
    },

    async abortMultipartUpload() {
      await api(`/api/uploads/${session.sessionId}`, { method: 'DELETE' }).catch(() => undefined);
    },
  });

  uppy.on('upload-progress', (_file, progress) => {
    const uploaded = progress.bytesUploaded ?? 0;
    stats.bytesUploaded = uploaded;
    stats.percent = file.size > 0 ? Math.min(100, (uploaded / file.size) * 100) : 0;
    rate.push(uploaded);
    stats.bytesPerSecond = rate.bytesPerSecond();
    stats.etaSeconds = rate.etaSeconds(uploaded, file.size);
    emit();
  });

  uppy.on('upload-success', () => {
    stats.status = 'done';
    stats.percent = 100;
    stats.bytesUploaded = file.size;
    emit();
    forgetPendingUpload(session.sessionId);
    hashWorker?.terminate();
    onComplete(session.videoId);
  });

  uppy.on('upload-error', (_file, error) => {
    stats.status = 'error';
    stats.error = error.message;
    emit();
    onError(error.message);
  });

  uppy.addFile({
    name: file.name,
    type: file.type || 'video/quicktime',
    data: file,
    source: 'local',
  });

  // Safari suspends timers and connections in a backgrounded tab. On return, ask R2
  // what it actually has rather than trusting whatever the paused upload believed.
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') return;
    void api<{ uploadedParts: UploadPartRef[] }>(`/api/uploads/${session.sessionId}`)
      .then((state) => {
        const uploaded = state.uploadedParts.reduce((sum, part) => sum + part.size, 0);
        if (uploaded > stats.bytesUploaded) {
          stats.bytesUploaded = uploaded;
          stats.percent = file.size > 0 ? (uploaded / file.size) * 100 : 0;
          emit();
        }
      })
      .catch(() => undefined);
  };
  document.addEventListener('visibilitychange', onVisibility);

  const teardown = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    hashWorker?.terminate();
  };

  return {
    cancel: async () => {
      teardown();
      uppy.cancelAll();
      await api(`/api/uploads/${session.sessionId}`, { method: 'DELETE' }).catch(() => undefined);
      forgetPendingUpload(session.sessionId);
      stats.status = 'idle';
      emit();
    },
    pause: () => {
      uppy.pauseAll();
      stats.status = 'paused';
      emit();
    },
    resume: () => {
      uppy.resumeAll();
      stats.status = 'uploading';
      emit();
    },
  };
}

function startHashWorker(
  file: File,
  onMessage: (message: import('./hash-worker').HashMessage) => void,
): Worker | null {
  try {
    const worker = new Worker(new URL('./hash-worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent) => {
      onMessage(event.data as import('./hash-worker').HashMessage);
    });
    worker.postMessage({ file });
    return worker;
  } catch {
    // No worker support: skip hashing rather than blocking the upload.
    onMessage({ type: 'error', message: 'Web Workers are unavailable' });
    return null;
  }
}

function waitForHash(read: () => string | null, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const value = read();
      if (value !== null) return resolve(value);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

export type { UppyFile };
