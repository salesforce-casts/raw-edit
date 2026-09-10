import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, PRESIGN_BATCH_SIZE, SIGNED_URL_TTL_SECONDS } from "@raw-edit/core";
import { getWebContainer } from "@/lib/container";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedUploadSession } from "@/server/upload-session";

const schema = z.object({
  partNumbers: z.array(z.number().int().positive()).min(1).max(PRESIGN_BATCH_SIZE),
});

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const user = await requireUser();
    const { sessionId } = await context.params;
    const { session } = await requireOwnedUploadSession(user.id, sessionId);
    if (!session.providerUploadId) throw new AppError("UPLOAD_PART_FAILED", "Not a multipart upload", 400);
    const body = schema.parse(await request.json());
    const storage = getWebContainer().storage;
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS.uploadPart * 1000).toISOString();
    const parts = await Promise.all(
      body.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await storage.signPart(session.storageKey, session.providerUploadId!, partNumber),
        expiresAt,
      })),
    );
    return NextResponse.json({ parts });
  } catch (error) {
    return jsonError(error);
  }
}
