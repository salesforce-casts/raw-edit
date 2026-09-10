import {
  ImportError,
  type CloudImportCredentials,
  type CloudImportProvider,
  type RemoteFileStream,
  type ResolvedRemoteFile,
} from '@rawedit/core';
import { assertIsVideo, fetchWithErrors, filenameFrom, toRemoteStream } from './http.js';

/**
 * Dropbox.
 *
 * Two paths, both of which fetch the original file rather than Dropbox's preview:
 *  - a connected account uses `sharing/get_shared_link_file`, and
 *  - a bare public link is rewritten to `dl=1`, which serves the raw bytes.
 */
export class DropboxImporter implements CloudImportProvider {
  readonly kind = 'DROPBOX' as const;
  readonly name = 'Dropbox';

  canHandle(url: string): boolean {
    return /dropbox\.com|dropboxusercontent\.com/i.test(url);
  }

  isConfigured(credentials?: CloudImportCredentials): boolean {
    // Public `dl=1` links need no credentials at all.
    return true;
  }

  /** `?dl=0` (the preview page) becomes `?dl=1` (the file itself). */
  static toDirectUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.endsWith('dropboxusercontent.com')) return parsed.toString();
      parsed.searchParams.set('dl', '1');
      return parsed.toString();
    } catch {
      throw new ImportError('That is not a valid Dropbox link.', 'UNSUPPORTED_URL');
    }
  }

  async resolve(url: string, credentials?: CloudImportCredentials): Promise<ResolvedRemoteFile> {
    if (credentials?.accessToken) {
      const response = await fetchWithErrors(
        'https://api.dropboxapi.com/2/sharing/get_shared_link_metadata',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ url }),
        },
        'the Dropbox file',
      );
      const metadata = (await response.json()) as { name?: string; size?: number; id?: string };
      const filename = metadata.name ?? 'dropbox-video';
      assertIsVideo(filename, null);
      return {
        kind: this.kind,
        externalId: metadata.id ?? null,
        filename,
        mimeType: null,
        size: metadata.size ?? null,
        isOriginal: true,
        notes: [],
      };
    }

    // No account connected: HEAD the direct link to learn name and size.
    const direct = DropboxImporter.toDirectUrl(url);
    const response = await fetchWithErrors(direct, { method: 'HEAD' }, 'the Dropbox file');
    const filename = filenameFrom(response, direct);
    const mimeType = response.headers.get('content-type');
    assertIsVideo(filename, mimeType);

    const length = response.headers.get('content-length');
    return {
      kind: this.kind,
      externalId: null,
      filename,
      mimeType,
      size: length ? Number.parseInt(length, 10) : null,
      isOriginal: true,
      notes: [],
    };
  }

  async open(url: string, credentials?: CloudImportCredentials): Promise<RemoteFileStream> {
    if (credentials?.accessToken) {
      const response = await fetchWithErrors(
        'https://content.dropboxapi.com/2/sharing/get_shared_link_file',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            'Dropbox-API-Arg': JSON.stringify({ url }),
          },
        },
        'the Dropbox file',
      );
      return toRemoteStream(response);
    }

    const response = await fetchWithErrors(DropboxImporter.toDirectUrl(url), {}, 'the Dropbox file');
    return toRemoteStream(response);
  }
}
