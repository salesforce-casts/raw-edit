import { getDb, processingJobs, videos } from "@raw-edit/db";
import { createBullmqQueue, queueNameForJob, type QueueJobPayload } from "@raw-edit/queue";
import { MAX_ACTIVE_RENDERS_PER_USER, type JobType } from "@raw-edit/contracts";
import { and, eq, inArray } from "drizzle-orm";

function queue() {
  return createBullmqQueue();
}

export async function enqueueJob(input: {
  videoId: string;
  userId: string;
  type: JobType;
  exportId?: string;
  payload?: Record<string, unknown>;
}) {
  const db = getDb();
  if (input.type === "RENDER_EXPORT") {
    const active = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .innerJoin(videos, eq(videos.id, processingJobs.videoId))
      .where(
        and(
          eq(videos.userId, input.userId),
          eq(processingJobs.type, "RENDER_EXPORT"),
          inArray(processingJobs.status, ["QUEUED", "ACTIVE"]),
        ),
      );
    if (active.length >= MAX_ACTIVE_RENDERS_PER_USER) {
      // Still enqueue; worker fairness will delay extras. Record remains QUEUED.
    }
  }

  const [job] = await db
    .insert(processingJobs)
    .values({
      videoId: input.videoId,
      type: input.type,
      status: "QUEUED",
      payload: { ...input.payload, exportId: input.exportId, userId: input.userId },
    })
    .returning();

  const payload: QueueJobPayload = {
    jobId: job.id,
    videoId: input.videoId,
    userId: input.userId,
    type: input.type,
    exportId: input.exportId,
  };
  const bullmqJobId = await queue().enqueue(queueNameForJob(input.type), payload);
  await db
    .update(processingJobs)
    .set({ bullmqJobId, updatedAt: new Date() })
    .where(eq(processingJobs.id, job.id));
  return job;
}
