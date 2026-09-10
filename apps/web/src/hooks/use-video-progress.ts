'use client';

import * as React from 'react';
import { isActiveStatus, type VideoStatus } from '@rawedit/core';

export interface ProgressState {
  status: VideoStatus;
  progress: number;
  stage: string | null;
  message: string | null;
}

/**
 * Live pipeline progress.
 *
 * Server-Sent Events first, because they are cheap and immediate. If the stream
 * fails — a proxy that buffers, a network that drops it, a platform that limits
 * connection duration — this falls back to polling without the user noticing. Both
 * paths read the same database state, so neither can show something the other would
 * disagree with.
 */
export function useVideoProgress(
  videoId: string,
  initial: ProgressState,
  options: { onSettled?: (status: VideoStatus) => void } = {},
): ProgressState {
  const [state, setState] = React.useState<ProgressState>(initial);
  const settledRef = React.useRef(false);
  const onSettled = options.onSettled;

  React.useEffect(() => {
    if (!isActiveStatus(initial.status)) {
      setState(initial);
      return;
    }

    let source: EventSource | null = null;
    let poller: NodeJS.Timeout | null = null;
    let cancelled = false;

    const settle = (status: VideoStatus) => {
      if (settledRef.current || isActiveStatus(status)) return;
      settledRef.current = true;
      source?.close();
      if (poller) clearInterval(poller);
      onSettled?.(status);
    };

    const apply = (next: Partial<ProgressState> & { status: VideoStatus }) => {
      if (cancelled) return;
      setState((previous) => ({ ...previous, ...next }));
      settle(next.status);
    };

    const startPolling = () => {
      if (poller || cancelled) return;
      poller = setInterval(() => {
        void fetch(`/api/videos/${videoId}/edl`, { method: 'HEAD' }).catch(() => undefined);
        void fetch(`/api/videos/${videoId}`)
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { video?: { status: VideoStatus; progress: number; statusDetail: string | null; errorMessage: string | null } } | null) => {
            if (!body?.video) return;
            apply({
              status: body.video.status,
              progress: body.video.progress,
              stage: body.video.statusDetail,
              message: body.video.errorMessage,
            });
          })
          .catch(() => undefined);
      }, 3000);
    };

    try {
      source = new EventSource(`/api/videos/${videoId}/events`);

      source.addEventListener('progress', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as {
            status: VideoStatus;
            progress: number;
            stage?: string;
            message?: string;
          };
          apply({
            status: data.status,
            progress: data.progress,
            stage: data.stage ?? null,
            message: data.message ?? null,
          });
        } catch {
          // A malformed frame must not tear down the stream.
        }
      });

      source.addEventListener('done', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { status: VideoStatus };
          settle(data.status);
        } catch {
          settle('COMPLETE');
        }
      });

      source.addEventListener('error', () => {
        // EventSource reconnects on its own, but if it is failing repeatedly the
        // poller keeps the UI truthful in the meantime.
        startPolling();
      });
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      source?.close();
      if (poller) clearInterval(poller);
    };
    // Re-subscribing on every state change would thrash the connection; the initial
    // status is only used to decide whether to subscribe at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  return state;
}
