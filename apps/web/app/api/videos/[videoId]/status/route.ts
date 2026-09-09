import { NextResponse } from "next/server";
import { getDb, processingJobs } from "@raw-edit/db";
import { desc, eq } from "drizzle-orm";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";

export async function GET(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    const jobs = await getDb()
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.videoId, video.id))
      .orderBy(desc(processingJobs.createdAt));
    return NextResponse.json({
      videoId: video.id,
      status: video.status,
      progress: video.progress,
      progressMessage: video.progressMessage,
      errorCode: video.errorCode,
      errorMessage: video.errorMessage,
      jobs: jobs.map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        errorCode: job.errorCode,
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
