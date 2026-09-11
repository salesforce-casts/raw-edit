import { NextResponse } from "next/server";
import { AppError, SIGNED_URL_TTL_SECONDS } from "@raw-edit/core";
import { objectKeys } from "@raw-edit/storage";
import { getWebContainer } from "@/lib/container";
import { jsonError } from "@/server/api";
import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";

export async function POST(_: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser();
    const { videoId } = await context.params;
    const video = await requireOwnedVideo(user.id, videoId);
    if (!video.audioStorageKey) throw new AppError("SOURCE_MISSING", "No analysis audio yet", 404);
    const storage = getWebContainer().storage;
    const waveformKey = objectKeys(user.id, video.id).waveform;
    try {
      await storage.head(waveformKey);
      return NextResponse.json({
        kind: "peaks",
        url: await storage.signGet(waveformKey, SIGNED_URL_TTL_SECONDS.proxyPlayback),
      });
    } catch {
      return NextResponse.json({
        kind: "audio",
        url: await storage.signGet(video.audioStorageKey, SIGNED_URL_TTL_SECONDS.proxyPlayback),
      });
    }
  } catch (error) {
    return jsonError(error);
  }
}
