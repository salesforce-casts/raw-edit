import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, exports, shareLinks, videos } from "@raw-edit/db";
import { AppError, SIGNED_URL_TTL_SECONDS, hashShareToken } from "@raw-edit/core";
import { getWebContainer } from "@/lib/container";
import { jsonError } from "@/server/api";

export async function GET(_: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const tokenHash = hashShareToken(token);
    const [row] = await getDb()
      .select({
        link: shareLinks,
        export: exports,
        filename: videos.originalFilename,
      })
      .from(shareLinks)
      .innerJoin(exports, eq(exports.id, shareLinks.exportId))
      .innerJoin(videos, eq(videos.id, exports.videoId))
      .where(eq(shareLinks.tokenHash, tokenHash))
      .limit(1);
    if (!row) throw new AppError("NOT_FOUND", "Share link not found", 404);
    if (row.link.disabledAt) throw new AppError("FORBIDDEN", "Share link is disabled", 410);
    if (row.link.expiresAt && row.link.expiresAt.getTime() < Date.now()) {
      throw new AppError("FORBIDDEN", "Share link expired", 410);
    }
    if (!row.export.storageKey || row.export.status !== "COMPLETE") {
      throw new AppError("NOT_FOUND", "Export is not ready", 404);
    }
    const url = await getWebContainer().storage.signGet(
      row.export.storageKey,
      SIGNED_URL_TTL_SECONDS.exportDownload,
      `${row.filename.replace(/\.[^.]+$/, "")}-edit.mp4`,
    );
    return NextResponse.json({
      filename: row.filename,
      durationMs: row.export.durationMs,
      width: row.export.width,
      height: row.export.height,
      playbackUrl: url,
    });
  } catch (error) {
    return jsonError(error);
  }
}
