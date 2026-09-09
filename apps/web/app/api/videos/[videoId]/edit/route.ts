import { NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { getDb, editSegments, editVersions } from "@raw-edit/db";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";

const putSchema = z.object({
  segments: z.array(
    z.object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
      action: z.enum(["KEEP", "REMOVE"]),
      source: z.enum(["AUTO_SILENCE", "AUTO_RETAKE", "AUTO_FILLER", "USER", "SYSTEM"]).optional(),
      reason: z.string().optional(),
      confidence: z.number().optional(),
    }),
  ),
});

async function currentEdit(videoId: string) {
  const db = getDb();
  const [version] = await db
    .select()
    .from(editVersions)
    .where(and(eq(editVersions.videoId, videoId), eq(editVersions.isCurrent, true)))
    .limit(1);
  if (!version) return { version: null, segments: [] };
  const segments = await db
    .select()
    .from(editSegments)
    .where(eq(editSegments.editVersionId, version.id))
    .orderBy(asc(editSegments.sequenceNumber));
  return { version, segments };
}

export async function GET(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    const edit = await currentEdit(video.id);
    return NextResponse.json({
      videoId: video.id,
      version: edit.version?.versionNumber ?? 0,
      versionId: edit.version?.id ?? null,
      segments: edit.segments,
      durationMs: video.durationMs,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    const body = putSchema.parse(await request.json());
    const db = getDb();
    const existing = await db.select().from(editVersions).where(eq(editVersions.videoId, video.id));
    const nextNumber = existing.reduce((max, version) => Math.max(max, version.versionNumber), 0) + 1;
    await db.update(editVersions).set({ isCurrent: false }).where(eq(editVersions.videoId, video.id));
    const [version] = await db
      .insert(editVersions)
      .values({
        videoId: video.id,
        versionNumber: nextNumber,
        createdBy: user.id,
        isCurrent: true,
      })
      .returning();
    if (body.segments.length > 0) {
      await db.insert(editSegments).values(
        body.segments.map((segment, index) => ({
          editVersionId: version.id,
          sequenceNumber: index,
          startMs: segment.startMs,
          endMs: segment.endMs,
          action: segment.action,
          source: segment.source ?? "USER",
          reason: segment.reason,
          confidence: segment.confidence,
        })),
      );
    }
    return NextResponse.json({ version: nextNumber, versionId: version.id });
  } catch (error) {
    return jsonError(error);
  }
}
