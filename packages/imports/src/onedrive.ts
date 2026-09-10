import {
  ImportError,
  type CloudImportCredentials,
  type CloudImportProvider,
  type RemoteFileStream,
  type ResolvedRemoteFile,
} from '@rawedit/core';
import { assertIsVideo, fetchWithErrors, toRemoteStream } from './http.js';

/**
 * OneDrive / SharePoint.
 *
 * Microsoft Graph resolves a share link through a base64url "share id"; `/content`
 * then returns the original file rather than a streaming rendition.
 */
export class OneDriveImporter implements CloudImportProvider {
  readonly kind = 'ONEDRIVE' as const;
  readonly name = 'OneDrive';

  canHandle(url: string): boolean {
    return /1drv\.ms|onedrive\.live\.com|sharepoint\.com|-my\.sharepoint\.com/i.test(url);
  }

  isConfigured(credentials?: CloudImportCredentials): boolean {
    return Boolean(credentials?.accessToken);
  }

  /** Graph's documented encoding: base64url of the link, prefixed with `u!`. */
  static toShareId(url: string): string {
    const base64 = Buffer.from(url, 'utf8').toString('base64');
    return `u!${base64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}`;
  }

  private requireToken(credentials?: CloudImportCredentials): string {
    if (!credentials?.accessToken) {
      throw new ImportError(
        'OneDrive import needs a connected Microsoft account.',
        'NOT_CONFIGURED',
      );
    }
    return credentials.accessToken;
  }

  async resolve(url: string, credentials?: CloudImportCredentials): Promise<ResolvedRemoteFile> {
    const token = this.requireToken(credentials);
    const shareId = OneDriveImporter.toShareId(url);

    const response = await fetchWithErrors(
      `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem`,
      { headers: { authorization: `Bearer ${token}` } },
      'the OneDrive file',
    );
    const item = (await response.json()) as {
      id?: string;
      name?: string;
      size?: number;
      file?: { mimeType?: string };
      folder?: unknown;
    };

    if (item.folder) {
      throw new ImportError('That link points at a folder. Share the video file itself.', 'NOT_A_VIDEO');
    }

    const filename = item.name ?? 'onedrive-video';
    const mimeType = item.file?.mimeType ?? null;
    assertIsVideo(filename, mimeType);

    return {
      kind: this.kind,
      externalId: item.id ?? null,
      filename,
      mimeType,
      size: item.size ?? null,
      isOriginal: true,
      notes: [],
    };
  }

  async open(url: string, credentials?: CloudImportCredentials): Promise<RemoteFileStream> {
    const token = this.requireToken(credentials);
    const shareId = OneDriveImporter.toShareId(url);
    const response = await fetchWithErrors(
      `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/content`,
      { headers: { authorization: `Bearer ${token}` } },
      'the OneDrive file',
    );
    return toRemoteStream(response);
  }
}
