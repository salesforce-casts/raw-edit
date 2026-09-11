import { NextResponse } from "next/server";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";
import { enqueueJob } from "@/server/jobs";
import { getDb, transcripts, videos } from "@raw-edit/db";
import { eq } from "drizzle-orm";

export async function POST(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    const db = getDb();
    const [transcript] = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .where(eq(transcripts.videoId, video.id))
      .limit(1);
    const needsTranscription = !transcript;

    await db
      .update(videos)
      .set({
        status: needsTranscription ? "TRANSCRIBING" : "DETECTING_TAKES",
        progress: needsTranscription ? 50 : 65,
        progressMessage: needsTranscription ? "Transcribing audio" : "Re-analysing edits",
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));
    await enqueueJob({
      videoId: video.id,
      userId: user.id,
      type: needsTranscription ? "TRANSCRIBE_VIDEO" : "DETECT_AUTOMATIC_EDITS",
      inputVersion: `${video.sourceSha256 ?? video.id}|${video.silenceThresholdMs}|retry-${Date.now()}`,
    });
    return NextResponse.json({ ok: true, restartedFrom: needsTranscription ? "transcription" : "detection" });
  } catch (error) {
    return jsonError(error);
  }
}
