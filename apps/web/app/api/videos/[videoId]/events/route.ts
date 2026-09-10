import { requireUser } from "@/server/session";
import { requireOwnedVideo } from "@/server/owned-video";
import { getWebContainer } from "@/lib/container";
import { getDb, videos } from "@raw-edit/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ videoId: string }> }) {
  const user = await requireUser();
  const { videoId } = await context.params;
  await requireOwnedVideo(user.id, videoId);
  const encoder = new TextEncoder();
  let unsubscribe: (() => Promise<void>) | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const poll = async () => {
        const [video] = await getDb().select().from(videos).where(eq(videos.id, videoId)).limit(1);
        if (video) send({ status: video.status, progress: video.progress, progressMessage: video.progressMessage });
      };
      await poll();
      try {
        unsubscribe = await getWebContainer().queue.subscribeProgress(videoId, (payload) => send(payload));
      } catch {
        unsubscribe = undefined;
      }
      const timer = setInterval(() => {
        void poll();
      }, 2000);
      const close = () => {
        clearInterval(timer);
        void unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const abort = (_: unknown) => close();
      void abort;
    },
    async cancel() {
      await unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
