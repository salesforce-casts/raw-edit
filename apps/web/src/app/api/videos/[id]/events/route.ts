import type { NextRequest } from 'next/server';
import { ProgressBus } from '@rawedit/queue';
import { isActiveStatus, type VideoStatus } from '@rawedit/core';
import { requireVideoForUser } from '@rawedit/db';
import { db } from '@/lib/container';
import { requireUser } from '@/lib/authz';

export const runtime = 'nodejs';
// SSE connections are long-lived; keep them well inside platform limits and let the
// client reconnect, which EventSource does on its own.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * GET /api/videos/:id/events — Server-Sent Events for pipeline progress.
 *
 * The worker publishes to Redis and this forwards it. Two things degrade gracefully:
 * if Redis is unreachable the stream falls back to polling the database every two
 * seconds, and if SSE itself fails the client hook falls back to polling. The
 * database is the source of truth in all three cases, so a user who closes the tab
 * and comes back sees the correct state.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await context.params;

  // Ownership is checked before a stream is opened, not per message.
  const row = await requireVideoForUser(db(), id, user.id);

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => Promise<void>) | null = null;
  let poller: NodeJS.Timeout | null = null;
  let keepAlive: NodeJS.Timeout | null = null;
  let lastStatus: VideoStatus = row.status;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Open with the current state so a client connecting mid-job renders at once.
      send('progress', {
        videoId: id,
        status: row.status,
        progress: row.progress,
        stage: row.statusDetail,
        message: row.errorMessage,
        at: Date.now(),
      });

      const finishIfTerminal = async (status: VideoStatus) => {
        lastStatus = status;
        if (isActiveStatus(status)) return;
        send('done', { videoId: id, status });
        await cleanup();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by the client disconnecting.
          }
        }
      };

      await finishIfTerminal(row.status);
      if (closed) return;

      // Live path: Redis pub/sub from the worker.
      try {
        const bus = new ProgressBus();
        unsubscribe = await bus.subscribe(id, (event) => {
          send('progress', event);
          void finishIfTerminal(event.status as VideoStatus);
        });
      } catch (error: unknown) {
        console.warn('[sse] Redis unavailable; falling back to polling', error);
      }

      // Safety net: poll the database, which also covers a worker that published
      // nothing because it died before its first progress call.
      poller = setInterval(() => {
        void (async () => {
          try {
            const current = await requireVideoForUser(db(), id, user.id);
            if (current.status !== lastStatus || current.progress !== row.progress) {
              send('progress', {
                videoId: id,
                status: current.status,
                progress: current.progress,
                stage: current.statusDetail,
                message: current.errorMessage,
                at: Date.now(),
              });
            }
            await finishIfTerminal(current.status);
          } catch {
            await cleanup();
          }
        })();
      }, 2000);

      // Proxies drop idle connections; a comment frame keeps this one alive.
      keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          closed = true;
        }
      }, 20_000);

      request.signal.addEventListener('abort', () => void cleanup(), { once: true });
    },

    async cancel() {
      await cleanup();
    },
  });

  async function cleanup(): Promise<void> {
    closed = true;
    if (poller) clearInterval(poller);
    if (keepAlive) clearInterval(keepAlive);
    poller = null;
    keepAlive = null;
    // A subscribed Redis connection is useless for anything else; always release it.
    if (unsubscribe) {
      const fn = unsubscribe;
      unsubscribe = null;
      await fn().catch(() => undefined);
    }
  }

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and similar buffer SSE unless told not to.
      'x-accel-buffering': 'no',
    },
  });
}
