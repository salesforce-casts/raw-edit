import { sanitizeFilename } from '../upload/multipart.js';

/**
 * Every object key in one place. Originals live under their own prefix so a lifecycle
 * rule or a retention sweep can never touch them by accident.
 */
export const StorageKeys = {
  original(userId: string, videoId: string, filename: string): string {
    return `originals/${userId}/${videoId}/${sanitizeFilename(filename)}`;
  },
  export(userId: string, videoId: string, exportId: string, extension = 'mp4'): string {
    return `exports/${userId}/${videoId}/${exportId}.${extension}`;
  },
  proxy(userId: string, videoId: string): string {
    return `derivatives/${userId}/${videoId}/proxy.mp4`;
  },
  thumbnail(userId: string, videoId: string): string {
    return `derivatives/${userId}/${videoId}/thumb.jpg`;
  },
  waveform(userId: string, videoId: string): string {
    return `derivatives/${userId}/${videoId}/waveform.json`;
  },
  isOriginal(key: string): boolean {
    return key.startsWith('originals/');
  },
  /** Guard against a key from one user being served to another. */
  belongsTo(key: string, userId: string): boolean {
    return key.split('/')[1] === userId;
  },
} as const;
