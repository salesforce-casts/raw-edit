import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, exports, shareLinks, videos } from "@raw-edit/db";
import { AppError } from "@raw-edit/contracts";
import { createShareToken } from "@raw-edit/video-core";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { logger } from "@/server/logger";

const schema = z.object({
  expiresInHours: z.union([z.literal(24), z.literal(24 * 7), z.literal(24 * 30), z.literal(0)]).default(0),
});

export async function POST(request: Request, context: { params: Promise<{ exportId: string }> }) {
  try {
    const user = await requireUser();
    const { exportId } = await context.params;
    const body = schema.parse(await request.json().catch(() => ({})));
    const [row] = await getDb()
      .select({ export: exports, userId: videos.userId })
      .from(exports)
      .innerJoin(videos, eq(videos.id, exports.videoId))
      .where(eq(exports.id, exportId))
      .limit(1);
    if (!row || row.userId !== user.id) throw new AppError("NOT_FOUND", "Export not found", 404);
    const { token, tokenHash } = createShareToken();
    const [link] = await getDb()
      .insert(shareLinks)
      .values({
        exportId: row.export.id,
        tokenHash,
        expiresAt: body.expiresInHours === 0 ? null : new Date(Date.now() + body.expiresInHours * 3600 * 1000),
      })
      .returning();
    logger.info({ event: "share_link_created", userId: user.id, exportId }, "share_link_created");
    return NextResponse.json({
      shareId: link.id,
      url: `/v/${token}`,
      expiresAt: link.expiresAt,
    });
  } catch (error) {
    return jsonError(error);
  }
}
