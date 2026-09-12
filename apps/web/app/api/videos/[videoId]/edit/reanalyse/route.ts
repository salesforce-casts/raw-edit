import { NextResponse } from "next/server";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";
import { enqueueJob } from "@/server/jobs";
import { getWebContainer } from "@/lib/container";
import { getDb, transcripts, videos } from "@raw-edit/db";
import { CANONICAL_SCRIPT_PROMPT_VERSION } from "@raw-edit/core";
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
    const status = needsTranscription ? "TRANSCRIBING" : "DETECTING_TAKES";
    const progress = needsTranscription ? 50 : 65;
    const progressMessage = needsTranscription ? "Transcribing audio" : "Re-analysing edits";

    await db
      .update(videos)
      .set({
        status,
        progress,
        progressMessage,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));

    try {
      await enqueueJob({
        videoId: video.id,
        userId: user.id,
        type: needsTranscription ? "TRANSCRIBE_VIDEO" : "DETECT_AUTOMATIC_EDITS",
        inputVersion: `${video.sourceSha256 ?? video.id}|${video.silenceThresholdMs}|${CANONICAL_SCRIPT_PROMPT_VERSION}|retry-${Date.now()}`,
      });
    } catch (error) {
      await db
        .update(videos)
        .set({
          status: video.status,
          progress: video.progress,
          progressMessage: video.progressMessage,
          errorCode: "QUEUE_UNAVAILABLE",
          errorMessage: "Could not queue re-analysis. Check that Redis and the worker are running.",
          updatedAt: new Date(),
        })
        .where(eq(videos.id, video.id));
      throw error;
    }

    await getWebContainer().queue.publishProgress(video.id, {
      status,
      progress,
      progressMessage,
      analysisVersion: CANONICAL_SCRIPT_PROMPT_VERSION,
    });
    return NextResponse.json({
      ok: true,
      restartedFrom: needsTranscription ? "transcription" : "detection",
      status,
      progress,
      progressMessage,
    });
  } catch (error) {
    return jsonError(error);
  }
}
