/**
 * Retention and cleanup, against real Postgres and real object storage.
 *
 * Deleting an original is irreversible, so these tests exist to prove the sweep
 * refuses every case where it should: no deadline, a deadline in the future, an
 * already-deleted source, and — the belt-and-braces check — a key that is not under
 * `originals/`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, StorageKeys } from '@rawedit/core';
import { uploadSession, user, video } from '@rawedit/db';

const enabled = Boolean(process.env['DATABASE_URL'] && process.env['REDIS_URL'] && process.env['R2_BUCKET']);
const describeIf = enabled ? describe : describe.skip;

describeIf('retention and cleanup', () => {
  let ctx: Awaited<ReturnType<typeof import('../src/lib/context.js').createContext>>;
  let userId = '';
  const created: string[] = [];

  beforeAll(async () => {
    const { createContext } = await import('../src/lib/context.js');
    ctx = await createContext();
    userId = newId('usr');
    await ctx.db.insert(user).values({
      id: userId,
      name: 'Retention Test',
      email: `retention-${Date.now()}@rawedit.test`,
      emailVerified: true,
    });
  }, 60_000);

  afterAll(async () => {
    if (ctx && userId) {
      await ctx.storage.deleteObjects(created).catch(() => undefined);
      await ctx.db.delete(user).where(eq(user.id, userId)).catch(() => undefined);
      await ctx.close();
    }
  });

  /** A video with a real object behind it, so deletion is observable. */
  async function makeVideo(patch: Partial<typeof video.$inferInsert> = {}) {
    const videoId = newId('vid');
    const key = StorageKeys.original(userId, videoId, 'clip.mp4');
    await ctx.storage.putObject({
      key,
      body: Buffer.from('not really a video, but really an object'),
      contentType: 'video/mp4',
    });
    created.push(key);

    await ctx.db.insert(video).values({
      id: videoId,
      userId,
      originalFilename: 'clip.mp4',
      storageKey: key,
      storageBucket: ctx.storage.bucket,
      mimeType: 'video/mp4',
      fileSize: 39,
      status: 'COMPLETE',
      duration: 5,
      ...patch,
    });
    return { videoId, key };
  }

  it('deletes an original whose retention deadline has passed', async () => {
    const { handleCleanup } = await import('../src/handlers/cleanup.js');
    const { videoId, key } = await makeVideo({
      sourceRetention: 'DAYS_7',
      deleteSourceAfter: new Date(Date.now() - 60_000),
    });

    await handleCleanup(ctx);

    expect(await ctx.storage.headObject(key)).toBeNull();
    const [row] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(row!.sourceDeletedAt).not.toBeNull();
    // The record survives; only the bytes are gone.
    expect(row!.storageKey).toBe(key);
    expect(row!.duration).toBe(5);
  }, 120_000);

  it('never deletes a source with no retention rule', async () => {
    const { handleCleanup } = await import('../src/handlers/cleanup.js');
    const { videoId, key } = await makeVideo({ sourceRetention: 'NEVER', deleteSourceAfter: null });

    await handleCleanup(ctx);

    expect(await ctx.storage.headObject(key)).not.toBeNull();
    const [row] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(row!.sourceDeletedAt).toBeNull();
  }, 120_000);

  it('never deletes a source whose deadline is still in the future', async () => {
    const { handleCleanup } = await import('../src/handlers/cleanup.js');
    const { videoId, key } = await makeVideo({
      sourceRetention: 'DAYS_30',
      deleteSourceAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    await handleCleanup(ctx);

    expect(await ctx.storage.headObject(key)).not.toBeNull();
    const [row] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(row!.sourceDeletedAt).toBeNull();
  }, 120_000);

  it('does not try to delete a source that is already gone', async () => {
    const { handleCleanup } = await import('../src/handlers/cleanup.js');
    await makeVideo({
      sourceRetention: 'DAYS_7',
      deleteSourceAfter: new Date(Date.now() - 60_000),
      sourceDeletedAt: new Date(Date.now() - 30_000),
    });

    // Nothing to do, and nothing thrown.
    await expect(handleCleanup(ctx)).resolves.toBeDefined();
  }, 120_000);

  it('aborts an abandoned multipart upload so R2 stops billing for its parts', async () => {
    const { handleCleanup } = await import('../src/handlers/cleanup.js');
    const videoId = newId('vid');
    const key = StorageKeys.original(userId, videoId, 'abandoned.mp4');
    const upload = await ctx.storage.createMultipartUpload(key, 'video/mp4');

    await ctx.db.insert(video).values({
      id: videoId,
      userId,
      originalFilename: 'abandoned.mp4',
      storageKey: key,
      storageBucket: ctx.storage.bucket,
      mimeType: 'video/mp4',
      fileSize: 1000,
      status: 'UPLOADING',
    });
    const sessionId = newId('ups');
    await ctx.db.insert(uploadSession).values({
      id: sessionId,
      videoId,
      userId,
      storageKey: key,
      r2UploadId: upload.uploadId,
      partSize: 8 * 1024 * 1024,
      totalParts: 1,
      fileSize: 1000,
      fileFingerprint: 'x'.repeat(64),
      status: 'IN_PROGRESS',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const result = await handleCleanup(ctx);
    expect(result.sessions).toBeGreaterThanOrEqual(1);

    const [row] = await ctx.db.select().from(uploadSession).where(eq(uploadSession.id, sessionId));
    expect(row!.status).toBe('EXPIRED');

    // The multipart upload is genuinely gone from storage.
    await expect(ctx.storage.listParts(key, upload.uploadId)).rejects.toThrow();
  }, 120_000);

  it('refuses to delete a key that is not an original', async () => {
    const { handleCleanup } = await import('../src/handlers/cleanup.js');
    const videoId = newId('vid');
    // A row pointing at an export key should never be swept, whatever its deadline
    // says — deleting a finished render on a retention rule about sources would be
    // the worst possible bug here.
    const exportKey = StorageKeys.export(userId, videoId, 'exp_x');
    await ctx.storage.putObject({ key: exportKey, body: Buffer.from('rendered'), contentType: 'video/mp4' });
    created.push(exportKey);

    await ctx.db.insert(video).values({
      id: videoId,
      userId,
      originalFilename: 'wrong.mp4',
      storageKey: exportKey,
      storageBucket: ctx.storage.bucket,
      mimeType: 'video/mp4',
      fileSize: 8,
      status: 'COMPLETE',
      sourceRetention: 'DAYS_7',
      deleteSourceAfter: new Date(Date.now() - 60_000),
    });

    await handleCleanup(ctx);

    expect(await ctx.storage.headObject(exportKey)).not.toBeNull();
    const [row] = await ctx.db.select().from(video).where(eq(video.id, videoId));
    expect(row!.sourceDeletedAt).toBeNull();
  }, 120_000);
});
