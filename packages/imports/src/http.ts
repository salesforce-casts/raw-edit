import { Readable } from 'node:stream';
import { ImportError, type RemoteFileStream } from '@rawedit/core';

/** Shared HTTP plumbing for every cloud import adapter. */

export const IMPORT_USER_AGENT = 'RawEdit/0.1 (+https://rawedit.app)';

export async function fetchWithErrors(
  url: string,
  init: RequestInit = {},
  what = 'the file',
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'user-agent': IMPORT_USER_AGENT, ...(init.headers ?? {}) },
      redirect: 'follow',
    });
  } catch (error: unknown) {
    throw new ImportError(`Could not reach ${what}: ${String(error)}`, 'NETWORK', true);
  }

  if (response.ok) return response;

  switch (response.status) {
    case 401:
    case 403:
      throw new ImportError(
        `Access to ${what} was refused. Check the link is shared with "anyone with the link", or connect the account.`,
        'FORBIDDEN',
      );
    case 404:
    case 410:
      throw new ImportError(`${what} was not found. The link may have expired or been removed.`, 'NOT_FOUND');
    case 429:
      throw new ImportError('The provider is rate limiting us; the import will be retried.', 'NETWORK', true);
    default:
      if (response.status >= 500) {
        throw new ImportError(`The provider returned ${response.status}.`, 'NETWORK', true);
      }
      throw new ImportError(`The provider returned ${response.status} for ${what}.`, 'NOT_FOUND');
  }
}

/** Turn a fetch Response into the node stream the import job consumes. */
export function toRemoteStream(response: Response): RemoteFileStream {
  const body = response.body;
  if (!body) throw new ImportError('The provider returned an empty response body.', 'NETWORK', true);

  const lengthHeader = response.headers.get('content-length');
  const size = lengthHeader ? Number.parseInt(lengthHeader, 10) : null;

  return {
    stream: Readable.fromWeb(body as never),
    size: Number.isFinite(size) && size !== null && size > 0 ? size : null,
    mimeType: response.headers.get('content-type'),
  };
}

/** Filename from Content-Disposition, falling back to the URL path. */
export function filenameFrom(response: Response, fallbackUrl: string): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      // fall through to the quoted form
    }
  }
  const quoted = /filename="?([^";]+)"?/i.exec(disposition);
  if (quoted?.[1]) return quoted[1];

  try {
    const path = new URL(fallbackUrl).pathname;
    const last = path.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // not a URL we can parse
  }
  return 'imported-video';
}

const VIDEO_EXTENSIONS = /\.(mov|mp4|m4v|hevc|avi|mkv|webm|mpg|mpeg|m2ts|mts|3gp)$/i;

/**
 * A container check, not a guarantee — ffprobe in the worker makes the final call.
 * Rejecting here only catches the obvious mistakes (a PDF, a photo, a folder link).
 */
export function looksLikeVideo(filename: string, mimeType: string | null): boolean {
  if (mimeType && mimeType.startsWith('video/')) return true;
  if (mimeType && /^(image|text|application\/pdf)/.test(mimeType)) return false;
  return VIDEO_EXTENSIONS.test(filename);
}

export function assertIsVideo(filename: string, mimeType: string | null): void {
  if (!looksLikeVideo(filename, mimeType)) {
    throw new ImportError(
      `"${filename}" does not look like a video file (${mimeType ?? 'unknown type'}).`,
      'NOT_A_VIDEO',
    );
  }
}
