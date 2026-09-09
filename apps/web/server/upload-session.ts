import { eq } from "drizzle-orm";
import { getDb, uploadSessions, videos } from "@raw-edit/db";
import { AppError } from "@raw-edit/contracts";

export async function requireOwnedUploadSession(userId: string, sessionId: string) {
  const db = getDb();
  const [session] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId)).limit(1);
  if (!session) throw new AppError("NOT_FOUND", "Upload session not found", 404);
  const [video] = await db.select().from(videos).where(eq(videos.id, session.videoId)).limit(1);
  if (!video || video.userId !== userId) throw new AppError("NOT_FOUND", "Upload session not found", 404);
  return { session, video };
}
