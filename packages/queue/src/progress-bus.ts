import type { Redis } from 'ioredis';
import type { ProgressEvent } from '@rawedit/core';
import { createRedis, progressChannel } from './connection.js';

/**
 * Subscriber side of the progress channel, used by the SSE route.
 *
 * A subscribed ioredis connection cannot issue normal commands, so this owns its own
 * connection and tears it down when the client disconnects.
 */
export class ProgressBus {
  private readonly subscriber: Redis;
  private closed = false;

  constructor(url?: string) {
    this.subscriber = createRedis(url);
  }

  async subscribe(videoId: string, onEvent: (event: ProgressEvent) => void): Promise<() => Promise<void>> {
    const channel = progressChannel(videoId);
    await this.subscriber.subscribe(channel);

    const handler = (incoming: string, message: string): void => {
      if (incoming !== channel) return;
      try {
        onEvent(JSON.parse(message) as ProgressEvent);
      } catch {
        // A malformed message must not kill the stream.
      }
    };
    this.subscriber.on('message', handler);

    return async () => {
      if (this.closed) return;
      this.closed = true;
      this.subscriber.off('message', handler);
      try {
        await this.subscriber.unsubscribe(channel);
      } finally {
        await this.subscriber.quit();
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.subscriber.quit();
  }
}
