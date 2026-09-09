import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, exports, shareLinks, videos } from "@raw-edit/db";
import { AppError } from "@raw-edit/contracts";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";

export async function DELETE(_: Request, context: { params: Promise<{ shareId: string }> }) {
  try {
    const user = await requireUser();
    const { shareId } = await context.params;
    const [row] = await getDb()
      .select({ link: shareLinks, userId: videos.userId })
      .from(shareLinks)
      .innerJoin(exports, eq(exports.id, shareLinks.exportId))
      .innerJoin(videos, eq(videos.id, exports.videoId))
      .where(eq(shareLinks.id, shareId))
      .limit(1);
    if (!row || row.userId !== user.id) throw new AppError("NOT_FOUND", "Share link not found", 404);
    await getDb()
      .update(shareLinks)
      .set({ disabledAt: new Date() })
      .where(eq(shareLinks.id, shareId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
