import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, exports, videos } from "@raw-edit/db";
import { AppError, SIGNED_URL_TTL_SECONDS } from "@raw-edit/contracts";
import { createR2Storage } from "@raw-edit/storage";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";

export async function POST(_: Request, context: { params: Promise<{ exportId: string }> }) {
  try {
    const user = await requireUser();
    const { exportId } = await context.params;
    const [row] = await getDb()
      .select({ export: exports, userId: videos.userId, filename: videos.originalFilename })
      .from(exports)
      .innerJoin(videos, eq(videos.id, exports.videoId))
      .where(eq(exports.id, exportId))
      .limit(1);
    if (!row || row.userId !== user.id) throw new AppError("NOT_FOUND", "Export not found", 404);
    if (!row.export.storageKey || row.export.status !== "COMPLETE") {
      throw new AppError("NOT_FOUND", "Export is not ready", 404);
    }
    const url = await createR2Storage().signGet(
      row.export.storageKey,
      SIGNED_URL_TTL_SECONDS.exportDownload,
      `${row.filename.replace(/\.[^.]+$/, "")}-edit.mp4`,
    );
    return NextResponse.json({ url, expiresIn: SIGNED_URL_TTL_SECONDS.exportDownload });
  } catch (error) {
    return jsonError(error);
  }
}
