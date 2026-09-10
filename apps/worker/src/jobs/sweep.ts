import { and, eq, inArray, lt, or, isNull } from "drizzle-orm";
import { JOB_STALE_MS, isStaleHeartbeat, persistJobStatus } from "@raw-edit/core";
import { processingJobs } from "@raw-edit/db";
import { getWorkerContext } from "../lib/context";
import { enqueueJob } from "../lib/enqueue";

export async function sweepStaleJobs() {
  const { db } = getWorkerContext();
  const cutoff = new Date(Date.now() - JOB_STALE_MS);
  const running = await db
    .select()
    .from(processingJobs)
    .where(
      and(
        inArray(processingJobs.status, ["RUNNING", "ACTIVE"]),
        or(isNull(processingJobs.heartbeatAt), lt(processingJobs.heartbeatAt, cutoff)),
      ),
    );
  for (const job of running) {
    if (!isStaleHeartbeat(job.heartbeatAt)) continue;
    await db
      .update(processingJobs)
      .set({
        status: persistJobStatus("FAILED"),
        errorMessage: "Stale heartbeat; reclaimed by sweeper",
        errorClass: "transient",
        lockedBy: null,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(processingJobs.id, job.id));
    const userId = String(job.payload.userId ?? "");
    if (!userId || !job.inputVersion) continue;
    await enqueueJob({
      videoId: job.videoId,
      userId,
      type: job.type,
      inputVersion: job.inputVersion,
      exportId: typeof job.payload.exportId === "string" ? job.payload.exportId : undefined,
      payload: job.payload,
    });
  }
}
