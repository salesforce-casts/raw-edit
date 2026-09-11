import { NextResponse } from "next/server";
import { AppError, SIGNED_URL_TTL_SECONDS } from "@raw-edit/core";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";
import { getWebContainer } from "@/lib/container";

export async function POST(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    if (!video.filmstripStorageKey) throw new AppError("SOURCE_MISSING", "No filmstrip yet", 404);
    const url = await getWebContainer().storage.signGet(video.filmstripStorageKey, SIGNED_URL_TTL_SECONDS.proxyPlayback);
    return NextResponse.json({ url, expiresIn: SIGNED_URL_TTL_SECONDS.proxyPlayback });
  } catch (error) {
    return jsonError(error);
  }
}
