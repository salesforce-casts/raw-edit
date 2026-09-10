import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, uploadSessions, videos } from "@raw-edit/db";
import {
  AppError,
  SIGNED_URL_TTL_SECONDS,
  multipartPartSizeBytes,
  shouldUseMultipart,
} from "@raw-edit/core";
import { getWebContainer } from "@/lib/container";
import { objectKeys } from "@raw-edit/storage";
import { assertTransition } from "@raw-edit/core";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";
import { logger } from "@/server/logger";

export async function POST(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    if (video.status !== "CREATED" && video.status !== "FAILED") {
      throw new AppError("FORBIDDEN", "Upload already started", 409);
    }
    if (video.status === "CREATED") assertTransition(video.status, "UPLOADING");
    const sizeBytes = video.sizeBytes ?? 0;
    const keys = objectKeys(user.id, video.id);
    const storageKey = video.sourceStorageKey ?? keys.original(video.originalFilename);
    const uploadType = shouldUseMultipart(sizeBytes) ? "multipart" : "put";
    const storage = getWebContainer().storage;
    const db = getDb();

    let providerUploadId: string | undefined;
    let putUrl: string | undefined;
    if (uploadType === "multipart") {
      const created = await storage.createMultipartUpload(storageKey, video.mimeType ?? "video/quicktime");
      providerUploadId = created.uploadId;
    } else {
      putUrl = await storage.signPut(storageKey, video.mimeType ?? "video/quicktime", SIGNED_URL_TTL_SECONDS.uploadPart);
    }

    const partSize = multipartPartSizeBytes(sizeBytes);
    const totalParts = uploadType === "multipart" ? Math.ceil(sizeBytes / partSize) : 1;
    const [session] = await db
      .insert(uploadSessions)
      .values({
        videoId: video.id,
        providerUploadId,
        storageKey,
        uploadType,
        partSizeBytes: partSize,
        totalParts,
        totalBytes: sizeBytes,
        status: "INITIATED",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .onConflictDoUpdate({
        target: uploadSessions.videoId,
        set: {
          providerUploadId,
          storageKey,
          uploadType,
          partSizeBytes: partSize,
          totalParts,
          totalBytes: sizeBytes,
          status: "INITIATED",
          updatedAt: new Date(),
        },
      })
      .returning();

    await db
      .update(videos)
      .set({
        status: "UPLOADING",
        sourceStorageKey: storageKey,
        updatedAt: new Date(),
      })
      .where(and(eq(videos.id, video.id), eq(videos.userId, user.id)));

    logger.info({ event: "video_upload_started", userId: user.id, videoId: video.id }, "upload_init");

    return NextResponse.json({
      session,
      putUrl,
      partSizeBytes: partSize,
      totalParts,
      uploadType,
    });
  } catch (error) {
    return jsonError(error);
  }
}
