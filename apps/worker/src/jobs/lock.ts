import { and, eq } from "drizzle-orm";
import { getDb, processingJobs } from "@raw-edit/db";
import type { JobStatus } from "@raw-edit/contracts";

const workerId = `${process.env.HOSTNAME ?? "worker"}-${process.pid}`;

export async function claimJob(jobId: string) {
  const db = getDb();
  const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (!job) return null;
  if (job.status === "COMPLETED") return { job, alreadyDone: true as const };
  if (job.status === "ACTIVE" && job.lockedBy && job.lockedBy !== workerId) {
    return { job, alreadyDone: true as const };
  }
  const [claimed] = await db
    .update(processingJobs)
    .set({
      status: "ACTIVE",
      attempt: job.attempt + 1,
      lockedBy: workerId,
      lockedAt: new Date(),
      startedAt: job.startedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(processingJobs.id, jobId)))
    .returning();
  return { job: claimed, alreadyDone: false as const };
}

export async function finishJob(
  jobId: string,
  status: Extract<JobStatus, "COMPLETED" | "FAILED" | "DEAD_LETTER">,
  extra: { errorCode?: string; errorMessage?: string; progress?: number } = {},
) {
  const db = getDb();
  await db
    .update(processingJobs)
    .set({
      status,
      errorCode: extra.errorCode,
      errorMessage: extra.errorMessage,
      progress: extra.progress ?? (status === "COMPLETED" ? 100 : undefined),
      finishedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(processingJobs.id, jobId));
}
