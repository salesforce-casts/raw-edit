import 'server-only';
import { getDb, type Database } from '@rawedit/db';
import { createStorageFromEnv } from '@rawedit/storage';
import { getQueue, type BullMqQueue } from '@rawedit/queue';
import { createImporters } from '@rawedit/imports';
import type { CloudImportProvider, StorageProvider } from '@rawedit/core';

/**
 * The composition root for the web app.
 *
 * This is the ONLY module that constructs a provider from environment variables.
 * Route handlers and server components ask for an interface; nothing in
 * `src/components` may import a provider SDK, which is what keeps the storage
 * credentials off the client and makes swapping R2 for S3 a one-line change.
 */

let storageSingleton: StorageProvider | null = null;
let importerSingleton: CloudImportProvider[] | null = null;

export function db(): Database {
  return getDb();
}

export function storage(): StorageProvider {
  if (!storageSingleton) storageSingleton = createStorageFromEnv();
  return storageSingleton;
}

export function queue(): BullMqQueue {
  return getQueue();
}

export function importers(): CloudImportProvider[] {
  if (!importerSingleton) importerSingleton = createImporters();
  return importerSingleton;
}

/** Signed-URL lifetimes, in one place so they can be reasoned about together. */
export const URL_TTL = {
  /** Playback in the review screen; long enough to watch without re-signing. */
  playback: 4 * 3600,
  /** A download the user just clicked. */
  download: 15 * 60,
  /** A single multipart PUT. Short because the client re-requests on demand. */
  uploadPart: 5 * 60,
  /** Thumbnails on the dashboard. */
  thumbnail: 3600,
} as const;

export const appUrl = (): string =>
  process.env['NEXT_PUBLIC_APP_URL'] ??
  (process.env['VERCEL_URL'] ? `https://${process.env['VERCEL_URL']}` : 'http://localhost:3000');
