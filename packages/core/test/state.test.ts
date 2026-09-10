import { describe, expect, it } from 'vitest';
import {
  analyzeProgress,
  analyzeStageStatus,
  assertJobTransition,
  assertVideoTransition,
  canTransitionVideo,
  IllegalStateTransitionError,
} from '../src/state/video-state.js';
import { checkUploadQuota, PLAN_LIMITS } from '../src/ports/payment.js';
import { isRetryable, PermanentError, TransientError } from '../src/ports/queue.js';
import {
  choosePartSize,
  isAcceptableVideo,
  MAX_PARTS,
  partCount,
  partRange,
  sanitizeFilename,
  UploadRateTracker,
} from '../src/upload/multipart.js';
import { StorageKeys } from '../src/util/storage-keys.js';

describe('video state machine', () => {
  it('walks the happy path', () => {
    const path = [
      'UPLOADING', 'UPLOADED', 'ANALYZING', 'TRANSCRIBING', 'DETECTING_TAKES',
      'READY_FOR_REVIEW', 'RENDERING', 'COMPLETE',
    ] as const;
    for (let i = 1; i < path.length; i += 1) {
      expect(canTransitionVideo(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it('refuses to drag a finished video backwards', () => {
    expect(() => assertVideoTransition('COMPLETE', 'ANALYZING')).toThrow(IllegalStateTransitionError);
    expect(() => assertVideoTransition('COMPLETE', 'UPLOADING')).toThrow();
  });

  it('lets any stage fail', () => {
    for (const status of ['UPLOADING', 'ANALYZING', 'TRANSCRIBING', 'RENDERING'] as const) {
      expect(canTransitionVideo(status, 'FAILED')).toBe(true);
    }
  });

  it('allows a retry out of FAILED without losing the record', () => {
    expect(canTransitionVideo('FAILED', 'UPLOADED')).toBe(true);
    expect(canTransitionVideo('FAILED', 'READY_FOR_REVIEW')).toBe(true);
  });

  it('allows a second export from a complete video', () => {
    expect(canTransitionVideo('COMPLETE', 'RENDERING')).toBe(true);
  });

  it('treats a no-op transition as legal', () => {
    expect(canTransitionVideo('RENDERING', 'RENDERING')).toBe(true);
  });
});

describe('job state machine', () => {
  it('allows the retry loop', () => {
    expect(() => assertJobTransition('QUEUED', 'RUNNING')).not.toThrow();
    expect(() => assertJobTransition('RUNNING', 'FAILED')).not.toThrow();
    expect(() => assertJobTransition('FAILED', 'QUEUED')).not.toThrow();
    expect(() => assertJobTransition('FAILED', 'DEAD')).not.toThrow();
  });

  it('lets a retry delivery claim a failed job directly', () => {
    // The queue owns the backoff, so a retried job goes FAILED -> RUNNING without
    // passing through QUEUED. The same path is taken by a job the sweeper reclaimed
    // from a worker that stopped responding.
    expect(() => assertJobTransition('FAILED', 'RUNNING')).not.toThrow();
  });

  it('will not resurrect a succeeded job', () => {
    expect(() => assertJobTransition('SUCCEEDED', 'RUNNING')).toThrow();
  });

  it('makes a dead-lettered job be re-queued deliberately', () => {
    // Otherwise a permanent failure could loop without anyone deciding to retry it.
    expect(() => assertJobTransition('DEAD', 'RUNNING')).toThrow();
    expect(() => assertJobTransition('DEAD', 'QUEUED')).not.toThrow();
  });
});

describe('analyzeProgress', () => {
  it('rises monotonically across the pipeline', () => {
    const points = [
      analyzeProgress('probe', 0),
      analyzeProgress('probe', 1),
      analyzeProgress('audio', 0.5),
      analyzeProgress('transcribe', 0.5),
      analyzeProgress('takes', 1),
    ];
    for (let i = 1; i < points.length; i += 1) expect(points[i]!).toBeGreaterThan(points[i - 1]!);
    expect(points.at(-1)).toBe(100);
  });

  it('clamps a fraction outside 0..1', () => {
    expect(analyzeProgress('probe', -5)).toBe(0);
    expect(analyzeProgress('probe', 5)).toBe(10);
  });

  it('maps sub-stages to the status the user sees', () => {
    expect(analyzeStageStatus('audio')).toBe('ANALYZING');
    expect(analyzeStageStatus('transcribe')).toBe('TRANSCRIBING');
    expect(analyzeStageStatus('takes')).toBe('DETECTING_TAKES');
  });
});

describe('error classification', () => {
  it('retries transient failures and not permanent ones', () => {
    expect(isRetryable(new TransientError('R2 timed out'))).toBe(true);
    expect(isRetryable(new PermanentError('No audio stream', 'NO_AUDIO'))).toBe(false);
  });

  it('treats network-shaped errors as retryable', () => {
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
    expect(isRetryable(new Error('read ECONNRESET'))).toBe(true);
    expect(isRetryable(new Error('Request failed with status 503'))).toBe(true);
  });

  it('does not retry an unrecognised programming error', () => {
    expect(isRetryable(new TypeError('x is not a function'))).toBe(false);
  });
});

describe('multipart sizing', () => {
  it('stays under the 10 000 part cap for very large files', () => {
    for (const size of [100 * 1024 ** 2, 4 * 1024 ** 3, 25 * 1024 ** 3, 500 * 1024 ** 3]) {
      const part = choosePartSize(size);
      expect(partCount(size, part)).toBeLessThanOrEqual(MAX_PARTS);
    }
  });

  it('keeps parts above the 5 MiB S3 minimum', () => {
    expect(choosePartSize(1024)).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(choosePartSize(50 * 1024 ** 3)).toBeGreaterThanOrEqual(5 * 1024 * 1024);
  });

  it('uses 8 MiB parts for a typical 4 GB iPhone recording', () => {
    const size = 4 * 1024 ** 3;
    expect(choosePartSize(size)).toBe(8 * 1024 * 1024);
    expect(partCount(size, choosePartSize(size))).toBe(512);
  });

  it('computes byte ranges that tile the file exactly', () => {
    const size = 20 * 1024 * 1024 + 123;
    const part = 8 * 1024 * 1024;
    const count = partCount(size, part);
    let covered = 0;
    for (let n = 1; n <= count; n += 1) {
      const range = partRange(n, part, size);
      expect(range.start).toBe(covered);
      covered = range.end;
    }
    expect(covered).toBe(size);
  });
});

describe('UploadRateTracker', () => {
  it('reports null until it has two samples', () => {
    const tracker = new UploadRateTracker();
    expect(tracker.bytesPerSecond()).toBeNull();
    tracker.push(0, 1000);
    expect(tracker.bytesPerSecond()).toBeNull();
  });

  it('measures throughput over the window', () => {
    const tracker = new UploadRateTracker(10_000);
    tracker.push(0, 1000);
    tracker.push(5_000_000, 6000);
    expect(tracker.bytesPerSecond()).toBeCloseTo(1_000_000, -3);
  });

  it('follows a slowdown rather than averaging it away', () => {
    const tracker = new UploadRateTracker(4000);
    tracker.push(0, 0);
    tracker.push(10_000_000, 1000);
    tracker.push(10_100_000, 5000);
    tracker.push(10_200_000, 6000);
    expect(tracker.bytesPerSecond()!).toBeLessThan(1_000_000);
  });

  it('estimates remaining time from the current rate', () => {
    const tracker = new UploadRateTracker();
    tracker.push(0, 0);
    tracker.push(1_000_000, 1000);
    expect(tracker.etaSeconds(1_000_000, 5_000_000)).toBeCloseTo(4, 1);
  });
});

describe('filename handling', () => {
  it('accepts iPhone captures even when Safari reports no MIME type', () => {
    expect(isAcceptableVideo('IMG_4821.MOV', '')).toBe(true);
    expect(isAcceptableVideo('IMG_4821.mov', 'application/octet-stream')).toBe(true);
    expect(isAcceptableVideo('clip.mp4', 'video/mp4')).toBe(true);
  });

  it('rejects things that are not video', () => {
    expect(isAcceptableVideo('notes.pdf', 'application/pdf')).toBe(false);
    expect(isAcceptableVideo('photo.heic', 'image/heic')).toBe(false);
  });

  it('produces a safe storage-key component', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('My Video (final).MOV')).toBe('My_Video_final_.MOV');
    expect(sanitizeFilename('')).toBe('video');
    expect(sanitizeFilename('a'.repeat(500)).length).toBeLessThanOrEqual(180);
  });
});

describe('storage keys', () => {
  it('keeps originals under their own prefix', () => {
    const key = StorageKeys.original('usr_1', 'vid_1', 'IMG_4821.MOV');
    expect(key).toBe('originals/usr_1/vid_1/IMG_4821.MOV');
    expect(StorageKeys.isOriginal(key)).toBe(true);
    expect(StorageKeys.isOriginal(StorageKeys.export('usr_1', 'vid_1', 'exp_1'))).toBe(false);
  });

  it('detects a key belonging to another user', () => {
    expect(StorageKeys.belongsTo('originals/usr_1/vid_1/a.mov', 'usr_1')).toBe(true);
    expect(StorageKeys.belongsTo('originals/usr_1/vid_1/a.mov', 'usr_2')).toBe(false);
  });
});

describe('plan quotas', () => {
  const empty = { uploadedMinutes: 0, transcribedMinutes: 0, renderedMinutes: 0, storageBytes: 0 };

  it('allows a normal upload on the free plan', () => {
    expect(checkUploadQuota('FREE', empty, { fileSizeBytes: 500 * 1024 ** 2 }).allowed).toBe(true);
  });

  it('blocks a file above the per-file limit and explains why', () => {
    const result = checkUploadQuota('FREE', empty, { fileSizeBytes: PLAN_LIMITS.FREE.maxFileSizeBytes + 1 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/per-file limit/);
  });

  it('blocks once the monthly minutes are used up', () => {
    const used = { ...empty, uploadedMinutes: PLAN_LIMITS.FREE.monthlyUploadMinutes };
    expect(checkUploadQuota('FREE', used, { fileSizeBytes: 1024 }).allowed).toBe(false);
  });

  it('blocks an upload that would exceed the storage allowance', () => {
    const used = { ...empty, storageBytes: PLAN_LIMITS.FREE.storageBytes - 1024 };
    expect(checkUploadQuota('FREE', used, { fileSizeBytes: 10 * 1024 ** 2 }).allowed).toBe(false);
  });

  it('gives a Pro account more headroom', () => {
    const size = 8 * 1024 ** 3;
    expect(checkUploadQuota('FREE', empty, { fileSizeBytes: size }).allowed).toBe(false);
    expect(checkUploadQuota('PRO', empty, { fileSizeBytes: size }).allowed).toBe(true);
  });
});
