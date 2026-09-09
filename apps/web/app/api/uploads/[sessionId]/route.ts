import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, uploadParts } from "@raw-edit/db";
import { createR2Storage } from "@raw-edit/storage";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedUploadSession } from "@/server/upload-session";

export async function GET(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const user = await requireUser();
    const { sessionId } = await context.params;
    const { session, video } = await requireOwnedUploadSession(user.id, sessionId);
    const dbParts = await getDb()
      .select()
      .from(uploadParts)
      .where(eq(uploadParts.uploadSessionId, session.id));
    let providerParts = dbParts.map((part) => ({
      partNumber: part.partNumber,
      etag: part.etag,
      sizeBytes: part.sizeBytes,
    }));
    if (session.providerUploadId) {
      try {
        const listed = await createR2Storage().listParts(session.storageKey, session.providerUploadId);
        providerParts = listed.map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag,
          sizeBytes: dbParts.find((item) => item.partNumber === part.partNumber)?.sizeBytes ?? null,
        }));
      } catch {
        // Keep database parts if ListParts is unavailable (expired upload).
      }
    }
    return NextResponse.json({
      session: {
        id: session.id,
        videoId: session.videoId,
        uploadType: session.uploadType,
        partSizeBytes: session.partSizeBytes,
        totalParts: session.totalParts,
        totalBytes: session.totalBytes,
        status: session.status,
        filename: video.originalFilename,
        mimeType: video.mimeType,
      },
      completedParts: providerParts,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const user = await requireUser();
    const { sessionId } = await context.params;
    const { session } = await requireOwnedUploadSession(user.id, sessionId);
    if (session.providerUploadId) {
      await createR2Storage().abortMultipartUpload(session.storageKey, session.providerUploadId);
    }
    await getDb()
      .update((await import("@raw-edit/db")).uploadSessions)
      .set({ status: "ABORTED", updatedAt: new Date() })
      .where(eq((await import("@raw-edit/db")).uploadSessions.id, session.id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
