import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb, editVersions, exports } from "@raw-edit/db";
import { AppError } from "@raw-edit/contracts";
import { objectKeys } from "@raw-edit/storage";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";
import { enqueueJob } from "@/server/jobs";
import { logger } from "@/server/logger";

const schema = z.object({
  preset: z.enum(["HIGH_QUALITY", "SOCIAL", "SMALLER_FILE", "HEVC_HIGH_QUALITY"]).default("HIGH_QUALITY"),
  strategy: z.enum(["PRESERVE_HDR", "COMPATIBLE_SDR"]).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    if (!["READY_FOR_REVIEW", "COMPLETE", "FAILED"].includes(video.status)) {
      throw new AppError("FORBIDDEN", "Video is not ready to export", 409);
    }
    const body = schema.parse(await request.json().catch(() => ({})));
    const db = getDb();
    const [version] = await db
      .select()
      .from(editVersions)
      .where(and(eq(editVersions.videoId, video.id), eq(editVersions.isCurrent, true)))
      .limit(1);
    if (!version) throw new AppError("NOT_FOUND", "No edit version to render", 404);
    const [record] = await db
      .insert(exports)
      .values({
        videoId: video.id,
        editVersionId: version.id,
        preset: body.preset,
        strategy:
          body.strategy ??
          (video.hdrType && video.hdrType !== "SDR" ? "PRESERVE_HDR" : "COMPATIBLE_SDR"),
        status: "PENDING",
        width: video.width,
        height: video.height,
        fpsNum: video.fpsNum,
        fpsDen: video.fpsDen,
      })
      .returning();
    const storageKey = objectKeys(user.id, video.id).export(record.id);
    await db.update(exports).set({ storageKey }).where(eq(exports.id, record.id));
    await enqueueJob({
      videoId: video.id,
      userId: user.id,
      type: "RENDER_EXPORT",
      exportId: record.id,
      inputVersion: `${version.versionNumber}|${body.preset}|${record.strategy}`,
      payload: { exportId: record.id, storageKey },
    });
    logger.info({ event: "export_started", userId: user.id, videoId: video.id, exportId: record.id }, "export_started");
    return NextResponse.json({ export: { ...record, storageKey } });
  } catch (error) {
    return jsonError(error);
  }
}
