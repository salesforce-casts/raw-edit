import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, processingJobs, videos } from "@raw-edit/db";
import { queueNameForJob, type QueueJobPayload } from "@raw-edit/queue";
import { jobIdempotencyKey, persistJobStatus, retryDelayMs, type JobType } from "@raw-edit/core";
import { loadConfig } from "@raw-edit/config";
import { getWebContainer } from "@/lib/container";

export async function enqueueJob(input: {
  videoId: string;
  userId: string;
  type: JobType;
  exportId?: string;
  inputVersion: string;
  payload?: Record<string, unknown>;
}) {
  const db = getDb();
  const config = loadConfig();
  const key = jobIdempotencyKey(input.type, input.videoId, input.inputVersion);
  const [existing] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.idempotencyKey, key))
    .limit(1);
  if (existing && (existing.status === "SUCCEEDED" || existing.status === "COMPLETED")) return existing;
  if (existing && (existing.status === "QUEUED" || existing.status === "RUNNING" || existing.status === "ACTIVE")) {
    return existing;
  }

  const activeForUser = await db
    .select({ count: sql<number>`count(*)` })
    .from(processingJobs)
    .innerJoin(videos, eq(videos.id, processingJobs.videoId))
    .where(
      and(eq(videos.userId, input.userId), inArray(processingJobs.status, ["QUEUED", "RUNNING", "ACTIVE"])),
    );
  const delayMs = Number(activeForUser[0]?.count ?? 0) >= config.maxConcurrentJobsPerUser ? retryDelayMs(0) : 0;

  const [job] =
    existing && (existing.status === "FAILED" || existing.status === "DEAD" || existing.status === "DEAD_LETTER")
      ? await db
          .update(processingJobs)
          .set({
            status: persistJobStatus("QUEUED"),
            inputVersion: input.inputVersion,
            payload: { ...input.payload, exportId: input.exportId, userId: input.userId },
            updatedAt: new Date(),
          })
          .where(eq(processingJobs.id, existing.id))
          .returning()
      : await db
          .insert(processingJobs)
          .values({
            videoId: input.videoId,
            type: input.type,
            status: persistJobStatus("QUEUED"),
            idempotencyKey: key,
            inputVersion: input.inputVersion,
            payload: { ...input.payload, exportId: input.exportId, userId: input.userId },
          })
          .returning();

  const payload: QueueJobPayload = {
    jobId: job.id,
    videoId: input.videoId,
    userId: input.userId,
    type: input.type,
    exportId: input.exportId,
    idempotencyKey: key,
    inputVersion: input.inputVersion,
  };
  const bullmqJobId = await getWebContainer().queue.enqueue(queueNameForJob(input.type), payload, {
    jobId: key,
    delayMs,
  });
  await db.update(processingJobs).set({ bullmqJobId, updatedAt: new Date() }).where(eq(processingJobs.id, job.id));
  return job;
}
