import { and, eq, lt, isNotNull } from "drizzle-orm";
import { AppError, isOriginalsKey } from "@raw-edit/core";
import { videos } from "@raw-edit/db";
import { objectKeys } from "@raw-edit/storage";
import type { QueueJobPayload } from "@raw-edit/queue";
import { getWorkerContext } from "../lib/context";
import { claimJob, finishJob } from "./lock";

export async function processDeleteVideo(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId, payload.idempotencyKey);
  if (!claimed || claimed.alreadyDone) return;
  const { db, storage } = getWorkerContext();
  try {
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video) throw new AppError("NOT_FOUND", "Video missing", 404, true);
    const keys = objectKeys(payload.userId, video.id);
    const retentionOnly = Boolean(claimed.job.payload.retentionOnly);
    if (retentionOnly) {
      if (!video.sourceStorageKey || !isOriginalsKey(video.sourceStorageKey)) {
        throw new AppError("SOURCE_MISSING", "Retention sweep refused a key outside originals/", 400, true);
      }
      await storage.deleteKey(video.sourceStorageKey);
      await db
        .update(videos)
        .set({ sourceStorageKey: null, updatedAt: new Date() })
        .where(eq(videos.id, video.id));
    } else {
      await storage.deletePrefix(keys.prefix);
      await db
        .update(videos)
        .set({
          status: "DELETED",
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(videos.id, video.id));
    }
    await finishJob(payload.jobId, "SUCCEEDED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed";
    await getWorkerContext()
      .db.update(videos)
      .set({ status: "FAILED", errorMessage: message, updatedAt: new Date() })
      .where(eq(videos.id, payload.videoId));
    await finishJob(payload.jobId, "FAILED", { errorMessage: message });
    throw error;
  }
}

export async function sweepExpiredOriginals() {
  const { db } = getWorkerContext();
  const due = await db
    .select()
    .from(videos)
    .where(and(isNotNull(videos.deleteAfter), lt(videos.deleteAfter, new Date()), isNotNull(videos.sourceStorageKey)));
  for (const video of due) {
    if (!video.sourceStorageKey || !isOriginalsKey(video.sourceStorageKey)) continue;
    const { enqueueJob } = await import("../lib/enqueue");
    await enqueueJob({
      videoId: video.id,
      userId: video.userId,
      type: "DELETE_VIDEO",
      inputVersion: `retention|${video.sourceStorageKey}`,
      payload: { retentionOnly: true },
    });
  }
}
