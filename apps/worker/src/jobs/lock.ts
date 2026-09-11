import { and, eq } from "drizzle-orm";
import { getDb, processingJobs } from "@raw-edit/db";
import {
  assertJobTransition,
  decideJobClaim,
  persistJobStatus,
  type JobStatus,
} from "@raw-edit/core";

const workerId = `${process.env.HOSTNAME ?? "worker"}-${process.pid}`;

export async function claimJob(jobId: string, idempotencyKey?: string) {
  const db = getDb();
  const [job] = idempotencyKey
    ? await db.select().from(processingJobs).where(eq(processingJobs.idempotencyKey, idempotencyKey)).limit(1)
    : await db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (!job) return null;
  const decision = decideJobClaim(job, workerId);
  if (decision === "already-done" || decision === "busy") {
    return { job, alreadyDone: true as const };
  }
  if (job.status !== persistJobStatus("RUNNING")) {
    assertJobTransition(job.status, "RUNNING");
  }
  const [claimed] = await db
    .update(processingJobs)
    .set({
      status: persistJobStatus("RUNNING"),
      attempt: job.attempt + 1,
      lockedBy: workerId,
      lockedAt: new Date(),
      heartbeatAt: new Date(),
      startedAt: job.startedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(processingJobs.id, job.id)))
    .returning();
  return { job: claimed, alreadyDone: false as const };
}

export function startHeartbeat(jobId: string, intervalMs = 10_000) {
  const timer = setInterval(() => {
    void (async () => {
      await getDb()
        .update(processingJobs)
        .set({ heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(processingJobs.id, jobId));
    })().catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function finishJob(
  jobId: string,
  status: Extract<JobStatus, "SUCCEEDED" | "COMPLETED" | "FAILED" | "DEAD" | "DEAD_LETTER">,
  extra: { errorCode?: string; errorMessage?: string; progress?: number; errorClass?: string } = {},
) {
  const persisted =
    status === "COMPLETED" ? persistJobStatus("SUCCEEDED") : status === "DEAD_LETTER" ? persistJobStatus("DEAD") : persistJobStatus(status);
  await getDb()
    .update(processingJobs)
    .set({
      status: persisted,
      errorCode: extra.errorCode,
      errorMessage: extra.errorMessage,
      errorClass: extra.errorClass,
      progress: extra.progress ?? (persisted === "SUCCEEDED" ? 100 : undefined),
      finishedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      updatedAt: new Date(),
    })
    .where(eq(processingJobs.id, jobId));
}
