import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, exports, videos } from "@raw-edit/db";
import { AppError } from "@raw-edit/contracts";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";

export async function GET(_: Request, context: { params: Promise<{ exportId: string }> }) {
  try {
    const user = await requireUser();
    const { exportId } = await context.params;
    const [row] = await getDb()
      .select({ export: exports, userId: videos.userId })
      .from(exports)
      .innerJoin(videos, eq(videos.id, exports.videoId))
      .where(eq(exports.id, exportId))
      .limit(1);
    if (!row || row.userId !== user.id) throw new AppError("NOT_FOUND", "Export not found", 404);
    return NextResponse.json({ export: row.export });
  } catch (error) {
    return jsonError(error);
  }
}
