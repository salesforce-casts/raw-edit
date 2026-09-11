import { NextResponse } from "next/server";
import { exports, getDb, videos } from "@raw-edit/db";
import { and, desc, eq } from "drizzle-orm";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";
import { enqueueJob } from "@/server/jobs";
import { assertTransition } from "@raw-edit/video-core";

export async function GET(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    const [latestExport] = await getDb()
      .select({ id: exports.id })
      .from(exports)
      .where(and(eq(exports.videoId, video.id), eq(exports.status, "COMPLETE")))
      .orderBy(desc(exports.completedAt))
      .limit(1);
    return NextResponse.json({ video, latestExport: latestExport ?? null });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    assertTransition(video.status, "DELETING");
    const db = getDb();
    await db
      .update(videos)
      .set({ status: "DELETING", updatedAt: new Date() })
      .where(eq(videos.id, video.id));
    await enqueueJob({
      videoId: video.id,
      userId: user.id,
      type: "DELETE_VIDEO",
      inputVersion: video.sourceStorageKey ?? video.id,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
