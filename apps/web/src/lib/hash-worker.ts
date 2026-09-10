/**
 * Web Worker that hashes the selected file while it uploads.
 *
 * WebCrypto has no streaming digest, so a multi-gigabyte file cannot go through
 * `crypto.subtle.digest` without holding all of it in memory. The pure-TS incremental
 * implementation in `@rawedit/core` runs at roughly 100 MB/s, which is fast enough to
 * finish alongside the upload, and it runs here so the main thread stays responsive
 * while the creator watches the progress bar.
 */
import { Sha256Stream } from '@rawedit/core';

export interface HashRequest {
  file: File;
  /** Bytes per read. 8 MiB keeps allocations modest on an older iPhone. */
  chunkSize?: number;
}

export interface HashProgress {
  type: 'progress';
  bytesHashed: number;
  totalBytes: number;
}

export interface HashDone {
  type: 'done';
  sha256: string;
}

export interface HashFailed {
  type: 'error';
  message: string;
}

export type HashMessage = HashProgress | HashDone | HashFailed;

self.addEventListener('message', (event: MessageEvent<HashRequest>) => {
  void run(event.data);
});

async function run({ file, chunkSize = 8 * 1024 * 1024 }: HashRequest): Promise<void> {
  try {
    const stream = new Sha256Stream();
    let offset = 0;

    while (offset < file.size) {
      const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
      const buffer = await slice.arrayBuffer();
      stream.update(new Uint8Array(buffer));
      offset += buffer.byteLength;
      post({ type: 'progress', bytesHashed: offset, totalBytes: file.size });
    }

    post({ type: 'done', sha256: stream.hex() });
  } catch (error: unknown) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

function post(message: HashMessage): void {
  (self as unknown as { postMessage: (data: HashMessage) => void }).postMessage(message);
}
