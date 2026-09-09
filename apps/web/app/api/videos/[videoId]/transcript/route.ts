import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, transcriptSegments, transcripts } from "@raw-edit/db";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";

export async function GET(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    const db = getDb();
    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.videoId, video.id)).limit(1);
    if (!transcript) return NextResponse.json({ transcript: null, segments: [] });
    const segments = await db
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.transcriptId, transcript.id))
      .orderBy(asc(transcriptSegments.sequenceNumber));
    return NextResponse.json({
      transcript: {
        id: transcript.id,
        provider: transcript.provider,
        model: transcript.model,
        language: transcript.language,
        fullText: transcript.fullText,
        durationMs: transcript.durationMs,
      },
      segments,
    });
  } catch (error) {
    return jsonError(error);
  }
}
