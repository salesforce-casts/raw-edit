import { eq } from "drizzle-orm";
import { AppError } from "@raw-edit/contracts";
import { getDb, videos } from "@raw-edit/db";
import { createR2Storage, objectKeys } from "@raw-edit/storage";
import type { QueueJobPayload } from "@raw-edit/queue";
import { claimJob, finishJob } from "./lock";

export async function processDeleteVideo(payload: QueueJobPayload) {
  const claimed = await claimJob(payload.jobId);
  if (!claimed || claimed.alreadyDone) return;
  const db = getDb();
  try {
    const [video] = await db.select().from(videos).where(eq(videos.id, payload.videoId)).limit(1);
    if (!video) throw new AppError("NOT_FOUND", "Video missing", 404);
    await createR2Storage().deletePrefix(objectKeys(payload.userId, video.id).prefix);
    await db
      .update(videos)
      .set({
        status: "DELETED",
        deletedAt: new Date(),
        sourceStorageKey: video.sourceStorageKey,
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));
    await finishJob(payload.jobId, "COMPLETED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed";
    await getDb()
      .update(videos)
      .set({ status: "FAILED", errorMessage: message, updatedAt: new Date() })
      .where(eq(videos.id, payload.videoId));
    await finishJob(payload.jobId, "FAILED", { errorMessage: message });
    throw error;
  }
}
