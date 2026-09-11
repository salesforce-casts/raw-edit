import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, userProfiles } from "@raw-edit/db";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";

const schema = z.object({
  pacingPreset: z.enum(["natural", "tight", "very_tight"]),
});

export async function GET() {
  try {
    const user = await requireUser();
    const db = getDb();
    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, user.id)).limit(1);
    return NextResponse.json({ pacingPreset: profile?.pacingPreset ?? "natural" });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = schema.parse(await request.json());
    const db = getDb();
    const [existing] = await db.select().from(userProfiles).where(eq(userProfiles.userId, user.id)).limit(1);
    if (existing) {
      await db
        .update(userProfiles)
        .set({ pacingPreset: body.pacingPreset, updatedAt: new Date() })
        .where(eq(userProfiles.userId, user.id));
    } else {
      await db.insert(userProfiles).values({ userId: user.id, pacingPreset: body.pacingPreset });
    }
    return NextResponse.json({ pacingPreset: body.pacingPreset });
  } catch (error) {
    return jsonError(error);
  }
}
