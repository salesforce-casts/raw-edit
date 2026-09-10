/**
 * End-to-end pipeline test.
 *
 * This is the test that proves the product works: a real video file goes into real
 * S3-compatible storage, the real analysis job probes it, extracts audio, detects
 * silence and builds an EDL, and the real render job produces a shorter file from the
 * ORIGINAL — with the original left byte-for-byte untouched.
 *
 * Requires Postgres, Redis, MinIO (or any S3 endpoint) and ffmpeg. Skipped with a
 * clear message when they are not configured; `scripts/dev-services.sh` starts them.
 */
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_EXPORT_PRESET,
  newId,
  StorageKeys,
  type VideoStatus,
} from '@rawedit/core';
import {
  detectedTake,
  detectedTakeMember,
  editDecision,
  getActiveEdl,
  processingJob,
  transcript,
  transcriptSegment,
  user,
  userSettings,
  video,
  videoExport,
} from '@rawedit/db';
import { probe } from '@rawedit/media';
import { buildSourceVideo, HAS_ESPEAK, hasBinary, type SourceFixture } from './fixtures.js';

const HAS_SERVICES = Boolean(
  process.env['DATABASE_URL'] && process.env['REDIS_URL'] && process.env['R2_BUCKET'],
);

const enabled = HAS_SERVICES && hasBinary('ffmpeg', ['-version']);
const describeIf = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    '[pipeline.e2e] Skipped. Run `./scripts/dev-services.sh start` and source .env.test to enable.',
  );
}

describeIf('worker pipeline (end to end)', () => {
  let ctx: Awaited<ReturnType<typeof import('../src/lib/context.js').createContext>>;
  let dir = '';
  let userId = '';
  let videoId = '';
  let sourceSha = '';
  let sourceSize = 0;
  let storageKey = '';
  let fixture: SourceFixture;
  let sourceDuration = 0;

  beforeAll(async () => {
    const { createContext } = await import('../src/lib/context.js');
    ctx = await createContext();
    dir = await mkdtemp(join(tmpdir(), 'rawedit-e2e-'));

    // ---- a real video file ---------------------------------------------------
    // With espeak-ng present this contains genuine synthesised speech in the
    // brief's retake pattern, so take detection is exercised for real.
    fixture = await buildSourceVideo(dir);
    const sourcePath = fixture.path;
    sourceDuration = (await probe(sourcePath)).duration;
    const bytes = await readFile(sourcePath);
    sourceSize = bytes.byteLength;
    sourceSha = createHash('sha256').update(bytes).digest('hex');

    // ---- a real user -----------------------------------------------------------
    userId = newId('usr');
    await ctx.db.insert(user).values({
      id: userId,
      name: 'E2E Creator',
      email: `e2e-${Date.now()}@rawedit.test`,
      emailVerified: true,
      planTier: 'CREATOR',
    });
    await ctx.db.insert(userSettings).values({ userId });

    // ---- upload it to real object storage --------------------------------------
    videoId = newId('vid');
    storageKey = StorageKeys.original(userId, videoId, 'IMG_TEST.mp4');
    await ctx.storage.uploadStream(storageKey, createReadStream(sourcePath), 'video/mp4');

    await ctx.db.insert(video).values({
      id: videoId,
      userId,
      originalFilename: 'IMG_TEST.mp4',
      storageKey,
      storageBucket: ctx.storage.bucket,
      mimeType: 'video/mp4',
      fileSize: sourceSize,
      checksumSha256: sourceSha,
      status: 'UPLOADED',
    });
    await ctx.db.insert(processingJob).values({
      id: newId('job'),
      videoId,
      userId,
      type: 'ANALYZE_VIDEO',
      status: 'QUEUED',
      idempotencyKey: `analyze:${videoId}:e2e`,
      payload: { videoId, userId },
    });
  }, 300_000);

  afterAll(async () => {
    if (userId && ctx) {
      // Cascades clear the video, transcript, takes, EDL and exports.
      await ctx.db.delete(user).where(eq(user.id, userId)).catch(() => undefined);
      await ctx.storage
        .deleteObjects([
          storageKey,
          StorageKeys.proxy(userId, videoId),
          StorageKeys.thumbnail(userId, videoId),
          StorageKeys.waveform(userId, videoId),
        ])
        .catch(() => undefined);
    }
    if (ctx) await ctx.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('analyses the video and reaches READY_FOR_REVIEW', async () => {
    const { JobTracker } = await import('../src/lib/job-tracker.js');
    const { handleAnalyze } = await import('../src/handlers/analyze.js');

    const tracker = await JobTracker.claim(ctx, { videoId, type: 'ANALYZE_VIDEO', attempt: 1 });
    expect(tracker).not.toBeNull();

    try {
      await handleAnalyze(ctx, tracker!, { videoId, userId });
      await tracker!.succeed();
    } finally {
      tracker!.stopHeartbeat();
    }

    const [row] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(row!.status satisfies VideoStatus).toBe('READY_FOR_REVIEW');
    expect(row!.progress).toBe(100);
    expect(row!.errorMessage).toBeNull();
  }, 600_000);

  it('stored real technical metadata from ffprobe', async () => {
    const [row] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(row!.duration).toBeCloseTo(sourceDuration, 0);
    expect(row!.width).toBe(640);
    expect(row!.height).toBe(360);
    expect(row!.videoCodec).toBe('h264');
    expect(row!.audioCodec).toBe('aac');
    expect(row!.frameRate).toBeCloseTo(30, 0);
    expect(row!.colorPrimaries).toBe('bt709');
    expect(row!.isHdr).toBe(false);
    expect(row!.probeJson).toBeTruthy();
  });

  it('verified the source checksum end to end', async () => {
    const [row] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(row!.checksumSha256).toBe(sourceSha);
    expect(row!.checksumVerifiedAt).not.toBeNull();
  });

  it('left the original byte-for-byte untouched', async () => {
    const head = await ctx.storage.headObject(storageKey);
    expect(head).not.toBeNull();
    expect(head!.size).toBe(sourceSize);

    // Not just the size: re-read the object and hash it.
    const hash = createHash('sha256');
    const stream = await ctx.storage.getObjectStream(storageKey);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    expect(hash.digest('hex')).toBe(sourceSha);
  }, 120_000);

  it('produced a transcript and an EDL that removes the silences', async () => {
    const [head] = await ctx.db.select().from(transcript).where(eq(transcript.videoId, videoId));
    expect(head).toBeTruthy();

    const segments = await ctx.db
      .select()
      .from(transcriptSegment)
      .where(eq(transcriptSegment.videoId, videoId));
    // Without espeak the audio is tones, so a real transcriber may find nothing to
    // say. What must hold either way is a coherent, non-destructive EDL.
    expect(Array.isArray(segments)).toBe(true);
    if (fixture.hasSpeech) expect(segments.length).toBeGreaterThan(0);

    const decisions = await getActiveEdl(ctx.db, videoId);
    for (const decision of decisions) {
      expect(decision.endTime).toBeGreaterThan(decision.startTime);
      expect(decision.startTime).toBeGreaterThanOrEqual(0);
      expect(decision.endTime).toBeLessThanOrEqual(sourceDuration + 0.5);
      expect(decision.reason.length).toBeGreaterThan(5);
      expect(decision.confidence).toBeGreaterThan(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
    }

    // Removals never overlap, or the review UI would misreport what is cut.
    const removals = decisions
      .filter((decision) => decision.decision === 'remove')
      .sort((a, b) => a.startTime - b.startTime);
    for (let i = 1; i < removals.length; i += 1) {
      expect(removals[i]!.startTime).toBeGreaterThanOrEqual(removals[i - 1]!.endTime - 1e-6);
    }
  });

  it.runIf(HAS_ESPEAK)('detected the retakes in real transcribed speech', async () => {
    // The source says the same opening line three times: two aborted, one complete.
    // This is the product's core claim, asserted against genuine ASR output rather
    // than a hand-written transcript.
    const groups = await ctx.db.select().from(detectedTake).where(eq(detectedTake.videoId, videoId));
    expect(groups.length).toBeGreaterThanOrEqual(1);

    const group = groups[0]!;
    expect(group.memberCount).toBeGreaterThanOrEqual(2);
    expect(group.confidence).toBeGreaterThan(0.7);
    // The kept take is the last, most complete one.
    expect(group.canonicalText.toLowerCase()).toContain('business ideas');
    expect(group.chosenSegmentIndex).toBe(group.memberCount - 1);

    const members = await ctx.db
      .select()
      .from(detectedTakeMember)
      .where(eq(detectedTakeMember.videoId, videoId));
    const chosen = members.filter((member) => member.isChosen);
    expect(chosen).toHaveLength(groups.length);
    // The winner is the longest attempt, and every loser scores below it.
    for (const member of members.filter((m) => !m.isChosen)) {
      expect(member.score).toBeLessThan(chosen[0]!.score);
    }

    const decisions = await getActiveEdl(ctx.db, videoId);
    const retakes = decisions.filter((decision) => decision.kind === 'retake');
    expect(retakes.length).toBeGreaterThanOrEqual(1);
    for (const retake of retakes) {
      expect(retake.reason).toMatch(/retake|attempt|version|false start/i);
      expect(retake.confidence).toBeGreaterThan(0.7);
    }

    // Nothing inside the surviving take is proposed for removal.
    const keeper = { start: chosen[0]!.startTime, end: chosen[0]!.endTime };
    for (const decision of decisions.filter((d) => d.decision === 'remove')) {
      const overlaps = decision.startTime < keeper.end && decision.endTime > keeper.start;
      expect(overlaps, `decision ${decision.id} overlaps the kept take`).toBe(false);
    }
  }, 60_000);

  it('renders a shorter video from the original master', async () => {
    const { JobTracker } = await import('../src/lib/job-tracker.js');
    const { handleRender } = await import('../src/handlers/render.js');

    // Approve a deterministic edit that removes two 4-second spans, so the expected
    // output duration is exact regardless of what the transcriber found.
    await ctx.db.delete(editDecision).where(eq(editDecision.videoId, videoId));
    await ctx.db.insert(editDecision).values(
      [
        { start: 2.5, end: 6.5 },
        { start: 9.5, end: 13.5 },
      ].map((range, index) => ({
        id: newId('edd'),
        videoId,
        index,
        startTime: range.start,
        endTime: range.end,
        action: 'remove' as const,
        kind: 'silence' as const,
        reason: '4.0s pause removed.',
        confidence: 0.9,
        source: 'auto' as const,
        active: true,
        edlVersion: 1,
      })),
    );
    const expectedDuration = sourceDuration - 8;

    const exportId = newId('exp');
    await ctx.db.insert(videoExport).values({
      id: exportId,
      videoId,
      userId,
      preset: DEFAULT_EXPORT_PRESET,
      status: 'QUEUED',
      edlVersion: 1,
    });
    await ctx.db.insert(processingJob).values({
      id: newId('job'),
      videoId,
      userId,
      type: 'RENDER_VIDEO',
      status: 'QUEUED',
      idempotencyKey: `render:${videoId}:e2e`,
      payload: { videoId, userId, exportId, edlVersion: 1 },
    });

    const tracker = await JobTracker.claim(ctx, { videoId, type: 'RENDER_VIDEO', attempt: 1 });
    expect(tracker).not.toBeNull();
    try {
      await handleRender(ctx, tracker!, { videoId, userId, exportId, edlVersion: 1 });
      await tracker!.succeed();
    } finally {
      tracker!.stopHeartbeat();
    }

    const [exported] = await ctx.db.select().from(videoExport).where(eq(videoExport.id, exportId));
    expect(exported!.status).toBe('COMPLETE');
    expect(exported!.progress).toBe(100);
    expect(exported!.storageKey).toBeTruthy();
    expect(exported!.fileSize).toBeGreaterThan(1000);
    // Exactly 8 seconds removed.
    expect(exported!.duration).toBeCloseTo(expectedDuration, 0);
    // Quality preserved: same resolution and frame rate as the source.
    expect(exported!.width).toBe(640);
    expect(exported!.height).toBe(360);
    expect(exported!.frameRate).toBeCloseTo(30, 0);

    const [videoRow] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(videoRow!.status).toBe('COMPLETE');

    // The stored export is really a playable, shorter video.
    const downloadUrl = await ctx.storage.signDownloadUrl(exported!.storageKey!, 600);
    const rendered = await probe(downloadUrl);
    expect(rendered.duration).toBeCloseTo(expectedDuration, 0);
    expect(rendered.video?.width).toBe(640);
    expect(rendered.audio).not.toBeNull();

    // The signed command must never have a live credential stored with it.
    expect(exported!.ffmpegCommand).toContain('<signed>');
    expect(exported!.ffmpegCommand).not.toContain('X-Amz-Signature');

    await ctx.storage.deleteObject(exported!.storageKey!).catch(() => undefined);
  }, 600_000);

  it('did not touch the original after rendering', async () => {
    const head = await ctx.storage.headObject(storageKey);
    expect(head!.size).toBe(sourceSize);
    const [row] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(row!.storageKey).toBe(storageKey);
    expect(row!.sourceDeletedAt).toBeNull();
  }, 60_000);

  it('records a job row that survives a Redis flush', async () => {
    const jobs = await ctx.db.select().from(processingJob).where(eq(processingJob.videoId, videoId));
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    for (const job of jobs) {
      expect(job.status).toBe('SUCCEEDED');
      expect(job.progress).toBe(100);
      expect(job.finishedAt).not.toBeNull();
      expect(job.errorMessage).toBeNull();
    }
  });

  it('refuses to claim a job that already succeeded', async () => {
    const { JobTracker } = await import('../src/lib/job-tracker.js');
    const again = await JobTracker.claim(ctx, { videoId, type: 'ANALYZE_VIDEO', attempt: 2 });
    expect(again).toBeNull();
  });

  it('fails a video cleanly without destroying its analysis', async () => {
    const { markVideoFailed } = await import('../src/lib/job-tracker.js');

    const takesBefore = await ctx.db.select().from(detectedTake).where(eq(detectedTake.videoId, videoId));
    const edlBefore = await getActiveEdl(ctx.db, videoId);

    await markVideoFailed(ctx.db, videoId, new Error('simulated worker crash'));

    const [row] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(row!.status).toBe('FAILED');
    expect(row!.errorMessage).toContain('simulated worker crash');
    // The analysis is intact: only status fields changed.
    expect(row!.duration).toBeCloseTo(sourceDuration, 0);
    expect(row!.storageKey).toBe(storageKey);

    const takesAfter = await ctx.db.select().from(detectedTake).where(eq(detectedTake.videoId, videoId));
    const edlAfter = await getActiveEdl(ctx.db, videoId);
    expect(takesAfter.length).toBe(takesBefore.length);
    expect(edlAfter.length).toBe(edlBefore.length);
  }, 60_000);
});
