import { NextResponse } from "next/server";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";
import { enqueueJob } from "@/server/jobs";
import { getDb, videos } from "@raw-edit/db";
import { eq } from "drizzle-orm";

export async function POST(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    await getDb()
      .update(videos)
      .set({ status: "DETECTING_EDITS", progress: 65, progressMessage: "Re-analysing edits", updatedAt: new Date() })
      .where(eq(videos.id, video.id));
    await enqueueJob({ videoId: video.id, userId: user.id, type: "DETECT_AUTOMATIC_EDITS" });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
