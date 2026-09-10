import { NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, editOverrides, editSegments, editVersions } from "@raw-edit/db";
import { applyOverrides, undoOverrides, type EditOverride, type EditSegment } from "@raw-edit/core";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";

const overrideSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  action: z.enum(["KEEP", "REMOVE"]),
  reason: z.string().optional(),
});

const putSchema = z.object({
  type: z.enum(["override", "undo", "segments"]).optional(),
  override: overrideSchema.optional(),
  segments: z
    .array(
      z.object({
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
        action: z.enum(["KEEP", "REMOVE"]),
        source: z.enum(["AUTO_SILENCE", "AUTO_RETAKE", "AUTO_FILLER", "USER", "SYSTEM"]).optional(),
        reason: z.string().optional(),
        confidence: z.number().optional(),
      }),
    )
    .optional(),
});

function asSegments(rows: Array<{
  startMs: number;
  endMs: number;
  action: EditSegment["action"];
  source: EditSegment["source"] | null;
  reason: string | null;
  confidence: number | null;
}>): EditSegment[] {
  return rows.map((row) => ({
    startMs: row.startMs,
    endMs: row.endMs,
    action: row.action,
    source: row.source ?? undefined,
    reason: row.reason ?? undefined,
    confidence: row.confidence ?? undefined,
  }));
}

function asOverrides(rows: Array<{ startMs: number; endMs: number; action: EditSegment["action"]; reason: string | null }>): EditOverride[] {
  return rows.map((row) => ({
    startMs: row.startMs,
    endMs: row.endMs,
    action: row.action,
    reason: row.reason ?? undefined,
  }));
}

async function currentEdit(videoId: string) {
  const db = getDb();
  const [version] = await db
    .select()
    .from(editVersions)
    .where(and(eq(editVersions.videoId, videoId), eq(editVersions.isCurrent, true)))
    .limit(1);
  if (!version) return { version: null, auto: [], overrides: [], segments: [] };
  const auto = await db
    .select()
    .from(editSegments)
    .where(eq(editSegments.editVersionId, version.id))
    .orderBy(asc(editSegments.sequenceNumber));
  const overrides = await db
    .select()
    .from(editOverrides)
    .where(eq(editOverrides.videoId, videoId))
    .orderBy(asc(editOverrides.sequenceNumber));
  const mappedAuto = asSegments(auto);
  const mappedOverrides = asOverrides(overrides);
  return {
    version,
    auto: mappedAuto,
    overrides: mappedOverrides,
    segments: applyOverrides(mappedAuto, mappedOverrides),
  };
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
      overrideCount: edit.overrides.length,
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
    const edit = await currentEdit(video.id);
    if (!edit.version) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "No automatic edit to override" } }, { status: 404 });
    }

    if (body.type === "undo") {
      const next = undoOverrides(edit.overrides);
      await db.delete(editOverrides).where(eq(editOverrides.videoId, video.id));
      if (next.length > 0) {
        await db.insert(editOverrides).values(
          next.map((override, index) => ({
            videoId: video.id,
            sequenceNumber: index,
            startMs: override.startMs,
            endMs: override.endMs,
            action: override.action,
            reason: override.reason,
          })),
        );
      }
      return NextResponse.json({ overrideCount: next.length, segments: applyOverrides(edit.auto, next) });
    }

    const override =
      body.type === "override"
        ? body.override
        : body.segments
          ? (() => {
              const changed = body.segments.find((segment, index) => {
                const current = edit.segments[index];
                return !current || current.action !== segment.action || current.startMs !== segment.startMs;
              });
              return changed
                ? {
                    startMs: changed.startMs,
                    endMs: changed.endMs,
                    action: changed.action,
                    reason: changed.reason ?? "Manual edit",
                  }
                : null;
            })()
          : null;
    if (!override) return NextResponse.json({ overrideCount: edit.overrides.length, segments: edit.segments });

    const [last] = await db
      .select({ sequenceNumber: editOverrides.sequenceNumber })
      .from(editOverrides)
      .where(eq(editOverrides.videoId, video.id))
      .orderBy(sql`${editOverrides.sequenceNumber} desc`)
      .limit(1);
    await db.insert(editOverrides).values({
      videoId: video.id,
      sequenceNumber: (last?.sequenceNumber ?? -1) + 1,
      startMs: override.startMs,
      endMs: override.endMs,
      action: override.action,
      reason: override.reason,
    });
    const next = [...edit.overrides, override];
    return NextResponse.json({ overrideCount: next.length, segments: applyOverrides(edit.auto, next) });
  } catch (error) {
    return jsonError(error);
  }
}
