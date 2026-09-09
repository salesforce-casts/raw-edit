import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, uploadParts, uploadSessions } from "@raw-edit/db";
import { eq } from "drizzle-orm";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedUploadSession } from "@/server/upload-session";

const schema = z.object({
  partNumber: z.number().int().positive(),
  etag: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const user = await requireUser();
    const { sessionId } = await context.params;
    const { session } = await requireOwnedUploadSession(user.id, sessionId);
    const body = schema.parse(await request.json());
    const db = getDb();
    await db
      .insert(uploadParts)
      .values({
        uploadSessionId: session.id,
        partNumber: body.partNumber,
        etag: body.etag.replaceAll('"', ""),
        sizeBytes: body.sizeBytes,
        completedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [uploadParts.uploadSessionId, uploadParts.partNumber],
        set: {
          etag: body.etag.replaceAll('"', ""),
          sizeBytes: body.sizeBytes,
          completedAt: new Date(),
        },
      });
    await db
      .update(uploadSessions)
      .set({ status: "UPLOADING", updatedAt: new Date() })
      .where(eq(uploadSessions.id, session.id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
