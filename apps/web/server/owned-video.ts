import { and, eq, isNull } from "drizzle-orm";
import { getDb, videos } from "@raw-edit/db";
import { AppError } from "@raw-edit/contracts";

export async function requireOwnedVideo(userId: string, videoId: string) {
  const db = getDb();
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.userId, userId), isNull(videos.deletedAt)))
    .limit(1);
  if (!video) {
    throw new AppError("NOT_FOUND", "Video not found", 404);
  }
  return video;
}
