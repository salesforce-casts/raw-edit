import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, userProfiles, videos } from "@raw-edit/db";
import { AppError, PLAN_LIMITS } from "@raw-edit/contracts";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { logger } from "@/server/logger";

const createSchema = z.object({
  originalFilename: z.string().min(1),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().positive(),
});

export async function GET() {
  try {
    const user = await requireUser();
    const db = getDb();
    const rows = await db
      .select()
      .from(videos)
      .where(and(eq(videos.userId, user.id), isNull(videos.deletedAt)))
      .orderBy(desc(videos.createdAt));
    return NextResponse.json({ videos: rows });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = createSchema.parse(await request.json());
    const limits = PLAN_LIMITS.free;
    if (body.sizeBytes > limits.maxUploadBytes) {
      throw new AppError("PLAN_LIMIT", "File exceeds the current plan upload limit", 403);
    }
    const db = getDb();
    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, user.id)).limit(1);
    const [video] = await db
      .insert(videos)
      .values({
        userId: user.id,
        originalFilename: body.originalFilename,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        status: "CREATED",
        sourceType: "upload",
        pacingPreset: profile?.pacingPreset ?? "natural",
      })
      .returning();
    logger.info({ event: "video_created", userId: user.id, videoId: video.id }, "video_created");
    return NextResponse.json({ video });
  } catch (error) {
    return jsonError(error);
  }
}
