import { NextResponse } from "next/server";
import { AppError, SIGNED_URL_TTL_SECONDS } from "@raw-edit/contracts";
import { createR2Storage } from "@raw-edit/storage";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";

export async function POST(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    const key = video.proxyStorageKey ?? video.sourceStorageKey;
    if (!key) throw new AppError("SOURCE_MISSING", "No playable object yet", 404);
    const url = await createR2Storage().signGet(key, SIGNED_URL_TTL_SECONDS.proxyPlayback);
    return NextResponse.json({ url, expiresIn: SIGNED_URL_TTL_SECONDS.proxyPlayback });
  } catch (error) {
    return jsonError(error);
  }
}
