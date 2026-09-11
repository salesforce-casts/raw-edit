import { and, asc, eq } from "drizzle-orm";
import {
  editOverrides,
  editSegments,
  editVersions,
  getDb,
  transcriptSegments,
  transcripts,
} from "@raw-edit/db";
import {
  applyOverrides,
  buildEditedTimelineSrt,
  coveringKeepRanges,
  flattenWords,
  type EditOverride,
  type EditSegment,
} from "@raw-edit/core";
import { jsonError } from "@/server/api";
import { requireOwnedVideo } from "@/server/owned-video";
import { requireUser } from "@/server/session";

export async function GET(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    const db = getDb();
    const [version] = await db
      .select()
      .from(editVersions)
      .where(and(eq(editVersions.videoId, video.id), eq(editVersions.isCurrent, true)))
      .limit(1);
    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.videoId, video.id)).limit(1);
    if (!version || !transcript) return new Response("No reviewed transcript is available", { status: 404 });

    const [automatic, overrides, rows] = await Promise.all([
      db.select().from(editSegments).where(eq(editSegments.editVersionId, version.id)).orderBy(asc(editSegments.sequenceNumber)),
      db.select().from(editOverrides).where(eq(editOverrides.videoId, video.id)).orderBy(asc(editOverrides.sequenceNumber)),
      db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcript.id)).orderBy(asc(transcriptSegments.sequenceNumber)),
    ]);
    const autoSegments: EditSegment[] = automatic.map((row) => ({
      startMs: row.startMs,
      endMs: row.endMs,
      action: row.action,
      source: row.source,
      reason: row.reason ?? undefined,
      confidence: row.confidence ?? undefined,
    }));
    const manualOverrides: EditOverride[] = overrides.map((row) => ({
      startMs: row.startMs,
      endMs: row.endMs,
      action: row.action,
      reason: row.reason ?? undefined,
    }));
    const finalSegments = applyOverrides(autoSegments, manualOverrides);
    const words = flattenWords(rows.map((row) => ({
      startMs: row.startMs,
      endMs: row.endMs,
      text: row.text,
      confidence: row.confidence ?? undefined,
      words: row.wordsJson,
    })));
    const srt = buildEditedTimelineSrt(words, coveringKeepRanges(finalSegments));
    const baseName = video.originalFilename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-") || "raw-edit";
    return new Response(srt, {
      headers: {
        "Content-Type": "application/x-subrip; charset=utf-8",
        "Content-Disposition": `attachment; filename="${baseName}.review.srt"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
