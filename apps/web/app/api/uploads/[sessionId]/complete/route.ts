import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, uploadSessions, videos } from "@raw-edit/db";
import { AppError, assertTransition } from "@raw-edit/core";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedUploadSession } from "@/server/upload-session";
import { enqueueJob } from "@/server/jobs";
import { logger } from "@/server/logger";
import { getWebContainer } from "@/lib/container";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const user = await requireUser();
    const { sessionId } = await context.params;
    const { session, video } = await requireOwnedUploadSession(user.id, sessionId);
    const storage = getWebContainer().storage;
    const db = getDb();
    const body = (await request.json().catch(() => ({}))) as { sha256?: string };

    await db
      .update(uploadSessions)
      .set({ status: "COMPLETING", updatedAt: new Date() })
      .where(eq(uploadSessions.id, session.id));

    if (session.uploadType === "multipart") {
      if (!session.providerUploadId) throw new AppError("UPLOAD_PART_FAILED", "Missing multipart upload id", 400);
      const listed = await storage.listParts(session.storageKey, session.providerUploadId);
      if (listed.length === 0) throw new AppError("UPLOAD_PART_FAILED", "R2 reports no completed parts", 400);
      await storage.completeMultipartUpload(session.storageKey, session.providerUploadId, listed);
    }

    const head = await storage.head(session.storageKey);
    if (session.totalBytes && head.contentLength !== session.totalBytes) {
      throw new AppError(
        "UPLOAD_SIZE_MISMATCH",
        `Uploaded object is ${head.contentLength} bytes, expected ${session.totalBytes}`,
        409,
      );
    }

    assertTransition(video.status === "UPLOADING" ? "UPLOADING" : video.status, "UPLOADED");
    await db
      .update(videos)
      .set({
        status: "UPLOADED",
        sizeBytes: head.contentLength,
        r2Etag: head.etag,
        clientSha256: body.sha256 ?? video.clientSha256,
        progress: 0,
        progressMessage: "Upload complete",
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));
    await db
      .update(uploadSessions)
      .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(uploadSessions.id, session.id));

    await enqueueJob({
      videoId: video.id,
      userId: user.id,
      type: "ANALYZE_VIDEO",
      inputVersion: body.sha256 ?? video.clientSha256 ?? session.storageKey,
    });
    logger.info({ event: "video_upload_completed", userId: user.id, videoId: video.id }, "upload_complete");
    return NextResponse.json({ ok: true, sizeBytes: head.contentLength });
  } catch (error) {
    return jsonError(error);
  }
}
