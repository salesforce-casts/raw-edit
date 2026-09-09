import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  assertVideoTransition,
  newId,
  PLAN_LIMITS,
  RETENTION_DAYS,
  type EditDecision,
  type PlanTier,
  type RetentionPolicy,
  type UsageKind,
  type UsageTotals,
  type VideoStatus,
} from '@rawedit/core';
import type { Database } from './client.js';
import {
  detectedTake,
  detectedTakeMember,
  editDecision,
  editSettings,
  processingJob,
  shareLink,
  subscription,
  transcript,
  transcriptSegment,
  transcriptWord,
  uploadSession,
  usageRecord,
  user,
  userSettings,
  video,
  videoExport,
} from './schema/index.js';

/**
 * Every read and write below takes a `userId` and filters on it.
 *
 * Authorisation is not a middleware concern here — it is a property of the query, so
 * there is no route that can accidentally forget it.
 */

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export async function getVideoForUser(db: Database, videoId: string, userId: string) {
  const rows = await db
    .select()
    .from(video)
    .where(and(eq(video.id, videoId), eq(video.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireVideoForUser(db: Database, videoId: string, userId: string) {
  const row = await getVideoForUser(db, videoId, userId);
  if (!row) throw new NotFoundError('Video');
  return row;
}

export async function listVideosForUser(
  db: Database,
  userId: string,
  options: { limit?: number; offset?: number } = {},
) {
  return db
    .select()
    .from(video)
    .where(eq(video.userId, userId))
    .orderBy(desc(video.createdAt))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);
}

/**
 * Status writes go through the state machine. An illegal transition throws rather
 * than corrupting the record — this is what stops a late worker from dragging a
 * COMPLETE video back to RENDERING.
 */
export async function setVideoStatus(
  db: Database,
  videoId: string,
  next: VideoStatus,
  patch: {
    progress?: number;
    statusDetail?: string | null;
    errorMessage?: string | null;
    expectFrom?: VideoStatus[];
  } = {},
): Promise<VideoStatus> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ status: video.status })
      .from(video)
      .where(eq(video.id, videoId))
      .for('update')
      .limit(1);
    const current = rows[0]?.status;
    if (!current) throw new NotFoundError('Video');

    if (patch.expectFrom && !patch.expectFrom.includes(current)) {
      throw new Error(`Video ${videoId} is ${current}, expected one of ${patch.expectFrom.join(', ')}`);
    }
    assertVideoTransition(current, next);

    await tx
      .update(video)
      .set({
        status: next,
        progress: patch.progress ?? undefined,
        statusDetail: patch.statusDetail === undefined ? undefined : patch.statusDetail,
        errorMessage: patch.errorMessage === undefined ? undefined : patch.errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(video.id, videoId));

    return current;
  });
}

/** Progress-only update: cheap, frequent, and never touches status. */
export async function setVideoProgress(
  db: Database,
  videoId: string,
  progress: number,
  statusDetail?: string,
): Promise<void> {
  await db
    .update(video)
    .set({
      progress: Math.max(0, Math.min(100, Math.round(progress))),
      statusDetail: statusDetail ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(video.id, videoId));
}

export async function getActiveEdl(db: Database, videoId: string): Promise<EditDecision[]> {
  const rows = await db
    .select()
    .from(editDecision)
    .where(and(eq(editDecision.videoId, videoId), eq(editDecision.active, true)))
    .orderBy(asc(editDecision.startTime));

  return rows.map((row) => ({
    id: row.id,
    startTime: row.startTime,
    endTime: row.endTime,
    decision: row.action,
    kind: row.kind,
    reason: row.reason,
    confidence: row.confidence,
    source: row.source,
    takeId: row.takeId ?? undefined,
    segmentIndex: row.segmentIndex ?? undefined,
  }));
}

export async function getEdlVersion(db: Database, videoId: string): Promise<number> {
  const rows = await db
    .select({ version: editSettings.edlVersion })
    .from(editSettings)
    .where(eq(editSettings.videoId, videoId))
    .limit(1);
  return rows[0]?.version ?? 1;
}

/**
 * Replace the active EDL in one transaction.
 *
 * Superseded rows are kept (`active = false`) rather than deleted, so the original
 * automatic proposal can always be restored without re-running analysis.
 */
export async function replaceActiveEdl(
  db: Database,
  videoId: string,
  decisions: readonly EditDecision[],
  options: { bumpVersion?: boolean } = {},
): Promise<number> {
  return db.transaction(async (tx) => {
    const currentRows = await tx
      .select({ version: editSettings.edlVersion })
      .from(editSettings)
      .where(eq(editSettings.videoId, videoId))
      .limit(1);
    const version = (currentRows[0]?.version ?? 0) + (options.bumpVersion === false ? 0 : 1);

    await tx
      .update(editDecision)
      .set({ active: false })
      .where(and(eq(editDecision.videoId, videoId), eq(editDecision.active, true)));

    if (decisions.length > 0) {
      await tx.insert(editDecision).values(
        decisions.map((decision, index) => ({
          id: newId('edd'),
          videoId,
          index,
          startTime: decision.startTime,
          endTime: decision.endTime,
          action: decision.decision,
          kind: decision.kind,
          reason: decision.reason,
          confidence: decision.confidence,
          source: decision.source,
          takeId: decision.takeId ?? null,
          segmentIndex: decision.segmentIndex ?? null,
          active: true,
          edlVersion: Math.max(1, version),
        })),
      );
    }

    await tx
      .update(editSettings)
      .set({ edlVersion: Math.max(1, version), updatedAt: new Date() })
      .where(eq(editSettings.videoId, videoId));

    return Math.max(1, version);
  });
}

export async function getTranscriptWithSegments(db: Database, videoId: string) {
  const transcriptRows = await db.select().from(transcript).where(eq(transcript.videoId, videoId)).limit(1);
  const head = transcriptRows[0];
  if (!head) return null;

  const segments = await db
    .select()
    .from(transcriptSegment)
    .where(eq(transcriptSegment.videoId, videoId))
    .orderBy(asc(transcriptSegment.index));

  const words =
    segments.length === 0
      ? []
      : await db
          .select()
          .from(transcriptWord)
          .where(
            inArray(
              transcriptWord.segmentId,
              segments.map((segment) => segment.id),
            ),
          )
          .orderBy(asc(transcriptWord.index));

  const wordsBySegment = new Map<string, typeof words>();
  for (const word of words) {
    const bucket = wordsBySegment.get(word.segmentId);
    if (bucket) bucket.push(word);
    else wordsBySegment.set(word.segmentId, [word]);
  }

  return {
    transcript: head,
    segments: segments.map((segment) => ({ ...segment, words: wordsBySegment.get(segment.id) ?? [] })),
  };
}

export async function getTakesWithMembers(db: Database, videoId: string) {
  const takes = await db
    .select()
    .from(detectedTake)
    .where(eq(detectedTake.videoId, videoId))
    .orderBy(asc(detectedTake.groupIndex));
  if (takes.length === 0) return [];

  const members = await db
    .select()
    .from(detectedTakeMember)
    .where(eq(detectedTakeMember.videoId, videoId))
    .orderBy(asc(detectedTakeMember.index));

  return takes.map((take) => ({
    ...take,
    members: members.filter((member) => member.takeId === take.id),
  }));
}

/**
 * Insert a job unless one with the same idempotency key already exists.
 * Returns the row plus whether it was newly created, so a replayed webhook or a
 * double-click cannot cost two renders.
 */
export async function upsertJob(
  db: Database,
  input: {
    videoId: string;
    userId: string;
    type: (typeof processingJob.$inferInsert)['type'];
    idempotencyKey: string;
    payload: unknown;
    maxAttempts?: number;
  },
): Promise<{ job: typeof processingJob.$inferSelect; created: boolean }> {
  const existing = await db
    .select()
    .from(processingJob)
    .where(eq(processingJob.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (existing[0]) {
    // A dead or cancelled job with the same key is a retry, not a duplicate.
    if (existing[0].status === 'DEAD' || existing[0].status === 'CANCELLED' || existing[0].status === 'FAILED') {
      const [revived] = await db
        .update(processingJob)
        .set({
          status: 'QUEUED',
          attempt: 0,
          progress: 0,
          errorMessage: null,
          errorStack: null,
          deadLetteredAt: null,
          queuedAt: new Date(),
          startedAt: null,
          finishedAt: null,
        })
        .where(eq(processingJob.id, existing[0].id))
        .returning();
      return { job: revived!, created: true };
    }
    return { job: existing[0], created: false };
  }

  const [created] = await db
    .insert(processingJob)
    .values({
      id: newId('job'),
      videoId: input.videoId,
      userId: input.userId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload as never,
      maxAttempts: input.maxAttempts ?? 3,
      status: 'QUEUED',
    })
    .onConflictDoNothing({ target: processingJob.idempotencyKey })
    .returning();

  if (created) return { job: created, created: true };

  // Lost a race with a concurrent insert; the other one is authoritative.
  const [raced] = await db
    .select()
    .from(processingJob)
    .where(eq(processingJob.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!raced) throw new Error('Failed to create or find processing job');
  return { job: raced, created: false };
}

export async function countActiveJobsForUser(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(processingJob)
    .where(and(eq(processingJob.userId, userId), inArray(processingJob.status, ['QUEUED', 'RUNNING'])));
  return rows[0]?.count ?? 0;
}

/** Reclaim jobs whose worker died mid-run. */
export async function findStaleJobs(db: Database, staleAfterMs = 90_000) {
  const cutoff = new Date(Date.now() - staleAfterMs);
  return db
    .select()
    .from(processingJob)
    .where(
      and(
        eq(processingJob.status, 'RUNNING'),
        or(isNull(processingJob.heartbeatAt), lt(processingJob.heartbeatAt, cutoff)),
      ),
    )
    .limit(50);
}

export function periodKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function recordUsage(
  db: Database,
  input: { userId: string; videoId?: string; kind: UsageKind; quantity: number; unit: 'minutes' | 'bytes' },
): Promise<void> {
  await db.insert(usageRecord).values({
    id: newId('usg'),
    userId: input.userId,
    videoId: input.videoId ?? null,
    kind: input.kind,
    quantity: String(input.quantity),
    unit: input.unit,
    periodKey: periodKey(),
  });
}

export async function getUsageTotals(db: Database, userId: string, period = periodKey()): Promise<UsageTotals> {
  const rows = await db
    .select({ kind: usageRecord.kind, total: sql<string>`sum(${usageRecord.quantity})` })
    .from(usageRecord)
    .where(and(eq(usageRecord.userId, userId), eq(usageRecord.periodKey, period)))
    .groupBy(usageRecord.kind);

  const totals: UsageTotals = {
    uploadedMinutes: 0,
    transcribedMinutes: 0,
    renderedMinutes: 0,
    storageBytes: 0,
  };
  for (const row of rows) {
    const value = Number.parseFloat(row.total ?? '0');
    if (row.kind === 'UPLOADED_MINUTES') totals.uploadedMinutes = value;
    if (row.kind === 'TRANSCRIBED_MINUTES') totals.transcribedMinutes = value;
    if (row.kind === 'RENDERED_MINUTES') totals.renderedMinutes = value;
  }

  // Storage is a live figure, not a monthly sum: measure what actually exists.
  const storage = await db
    .select({
      total: sql<string>`coalesce(sum(${video.fileSize}), 0)`,
    })
    .from(video)
    .where(and(eq(video.userId, userId), isNull(video.sourceDeletedAt)));
  const exportsTotal = await db
    .select({ total: sql<string>`coalesce(sum(${videoExport.fileSize}), 0)` })
    .from(videoExport)
    .where(and(eq(videoExport.userId, userId), eq(videoExport.status, 'COMPLETE')));

  totals.storageBytes =
    Number.parseFloat(storage[0]?.total ?? '0') + Number.parseFloat(exportsTotal[0]?.total ?? '0');
  return totals;
}

export async function getPlanTier(db: Database, userId: string): Promise<PlanTier> {
  const rows = await db.select({ tier: user.planTier }).from(user).where(eq(user.id, userId)).limit(1);
  return rows[0]?.tier ?? 'FREE';
}

export async function getOrCreateUserSettings(db: Database, userId: string) {
  const existing = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  if (existing[0]) return existing[0];
  const [created] = await db.insert(userSettings).values({ userId }).onConflictDoNothing().returning();
  if (created) return created;
  const [fetched] = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  return fetched!;
}

/** Compute the deletion deadline a retention policy implies. */
export function retentionDeadline(policy: RetentionPolicy, from = new Date()): Date | null {
  const days = RETENTION_DAYS[policy];
  if (days === null) return null;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Originals eligible for deletion. A video only appears here when the user's own
 * retention rule set a deadline and that deadline has passed — nothing is deleted
 * because a job felt like tidying up.
 */
export async function findExpiredSources(db: Database, limit = 100) {
  return db
    .select()
    .from(video)
    .where(
      and(
        isNull(video.sourceDeletedAt),
        sql`${video.deleteSourceAfter} is not null`,
        lt(video.deleteSourceAfter, new Date()),
      ),
    )
    .limit(limit);
}

export async function findExpiredUploadSessions(db: Database, limit = 100) {
  return db
    .select()
    .from(uploadSession)
    .where(and(inArray(uploadSession.status, ['PENDING', 'IN_PROGRESS']), lt(uploadSession.expiresAt, new Date())))
    .limit(limit);
}

export async function getShareLinkBySlug(db: Database, slug: string) {
  const rows = await db
    .select({
      link: shareLink,
      video: video,
      export: videoExport,
    })
    .from(shareLink)
    .innerJoin(video, eq(shareLink.videoId, video.id))
    .innerJoin(videoExport, eq(shareLink.exportId, videoExport.id))
    .where(eq(shareLink.slug, slug))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.link.revokedAt) return null;
  if (row.link.expiresAt && row.link.expiresAt.getTime() < Date.now()) return null;
  if (row.export.status !== 'COMPLETE') return null;
  return row;
}

export async function recordShareView(db: Database, linkId: string): Promise<void> {
  await db
    .update(shareLink)
    .set({ viewCount: sql`${shareLink.viewCount} + 1`, lastViewedAt: new Date() })
    .where(eq(shareLink.id, linkId));
}

export async function getLatestCompleteExport(db: Database, videoId: string, userId: string) {
  const rows = await db
    .select()
    .from(videoExport)
    .where(
      and(eq(videoExport.videoId, videoId), eq(videoExport.userId, userId), eq(videoExport.status, 'COMPLETE')),
    )
    .orderBy(desc(videoExport.finishedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSubscription(db: Database, userId: string) {
  const rows = await db.select().from(subscription).where(eq(subscription.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export function planLimitsFor(tier: PlanTier) {
  return PLAN_LIMITS[tier];
}

/** Videos whose most recent activity is inside the window — used by the dashboard. */
export async function countVideosSince(db: Database, userId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(video)
    .where(and(eq(video.userId, userId), gte(video.createdAt, since)));
  return rows[0]?.count ?? 0;
}
